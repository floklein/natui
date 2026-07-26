import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForMessage } from '../../shared/probe.mjs';

const exampleDirectory = fileURLToPath(new URL('..', import.meta.url));
// The packaged artifact name carries the version, so read it from the config
// that produced the package rather than repeating it here.
const appConfig = JSON.parse(
  await readFile(path.join(exampleDirectory, 'natui.app.json'), 'utf8'),
);
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const defaultHost = process.platform === 'win32'
  ? path.join(
      exampleDirectory,
      'dist',
      'package',
      `${appConfig.executable}-${appConfig.version}-windows-${architecture}.exe`,
    )
  : path.join(
      exampleDirectory,
      'dist',
      'package',
      `${appConfig.executable}.app`,
      'Contents',
      'MacOS',
      appConfig.executable,
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
child.stdin.on('error', () => {
  // The app may exit before we finish writing; teardown handles that.
});

const messages = [];
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Ignore non-protocol output. Diagnostics belong on stderr.
    return;
  }
  messages.push(message);
});

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function containsKind(node, kind) {
  return node?.kind === kind || node?.children?.some((childNode) => containsKind(childNode, kind));
}

// A failed assertion must not leave a packaged GUI app behind: it would grab
// focus and hard-fail the next run.
async function shutdown() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    send({ t: 'quit' });
  } catch {
    // The app may already have closed its protocol channel.
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

try {
  const ready = await waitForMessage(messages, (message) => message.t === 'ready', 'ready');
  assert.equal(ready.protocol, 1);
  assert.ok(ready.hostApi >= 1);

  let tree;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const startIndex = messages.length;
    send({ t: 'dump' });
    tree = await waitForMessage(
      messages,
      (message) => message.t === 'tree',
      `tree ${attempt + 1}`,
      { startIndex },
    );
    if (containsKind(tree.root, 'Button')) break;
    await sleep(50);
  }
  assert.ok(containsKind(tree?.root, 'Button'), 'packaged entry mounted the demo tree');

  // This host-side request follows the normal native lifecycle. React unmounts
  // and sends quit, then the native host tears down its embedded engine.
  send({ t: 'requestClose' });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('packaged app did not exit after its close request'));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
  console.error(`[verify-package] packaged ${process.platform} lifecycle verified`);
} finally {
  await shutdown();
}
