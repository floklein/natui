import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDirectory = fileURLToPath(new URL('..', import.meta.url));
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const defaultHost = process.platform === 'win32'
  ? path.join(
      exampleDirectory,
      'dist',
      'package',
      `NatUIDemo-0.1.0-windows-${architecture}.exe`,
    )
  : path.join(
      exampleDirectory,
      'dist',
      'package',
      'NatUIDemo.app',
      'Contents',
      'MacOS',
      'NatUIDemo',
    );
const host = process.env.NATUI_PACKAGE_HOST
  ? path.resolve(process.env.NATUI_PACKAGE_HOST)
  : defaultHost;

const child = spawn(host, [], {
  // Prove packaged discovery is relative to the executable, not the caller.
  cwd: tmpdir(),
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: false,
});
child.stdin.on('error', () => {});

const messages = [];
const waiters = [];
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  messages.push(message);
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(message)) continue;
    clearTimeout(waiter.timer);
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(message);
  }
});

function waitFor(predicate, label, timeoutMs = 15_000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`packaged app did not send ${label} within ${timeoutMs}ms`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function containsKind(node, kind) {
  return node?.kind === kind || node?.children?.some((childNode) => containsKind(childNode, kind));
}

const ready = await waitFor((message) => message.t === 'ready', 'ready');
assert.equal(ready.protocol, 1);
assert.ok(ready.hostApi >= 1);

let tree;
let treeSequence = 0;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const expectedSequence = ++treeSequence;
  send({ t: 'dump' });
  tree = await waitFor(
    (message) => message.t === 'tree' && !message.__sequence,
    `tree ${expectedSequence}`,
  );
  tree.__sequence = expectedSequence;
  if (containsKind(tree.root, 'Button')) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(containsKind(tree?.root, 'Button'), 'packaged entry mounted the demo tree');

// This host-side request follows the normal native lifecycle. React unmounts
// and sends quit, then the native host tears down its embedded engine.
send({ t: 'requestClose' });
const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('packaged app did not exit after its close request'));
  }, 15_000);
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
assert.equal(exitCode, 0);
console.error(`[verify-package] packaged ${process.platform} lifecycle verified`);
