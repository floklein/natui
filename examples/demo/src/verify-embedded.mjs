/**
 * Stage 2 verification: launches the natui host with the React app bundle
 * evaluated IN-PROCESS by JavaScriptCore (no Node running the app), then
 * drives it over the stdio debug channel: tree dumps, synthesized events,
 * and a host-rendered screenshot. Exits non-zero on failure.
 *
 *   node src/verify-embedded.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const hostBin = `${repoRoot}hosts/macos/.build/debug/natui-host`;
const bundle = fileURLToPath(new URL('../dist/embedded.js', import.meta.url));
const outDir = `${repoRoot}screenshots`;
mkdirSync(outDir, { recursive: true });

const host = spawn(hostBin, ['--bundle', bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (msg) => host.stdin.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const messages = [];
createInterface({ input: host.stdout }).on('line', (line) => {
  try {
    messages.push(JSON.parse(line));
  } catch {
    console.error('[probe] noise:', line);
  }
});
const waitFor = async (pred, what) => {
  for (let i = 0; i < 200; i++) {
    const msg = messages.find(pred);
    if (msg) return msg;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const collect = (node, kind, out = []) => {
  if (node.kind === kind) out.push(node);
  (node.children ?? []).forEach((c) => collect(c, kind, out));
  return out;
};
const textOf = (n) => (n.kind === '#text' ? (n.text ?? '') : (n.children ?? []).map(textOf).join(''));

await waitFor((m) => m.t === 'ready', 'ready');
console.error('[probe] host ready (bundle evaluating in-process)');

// The embedded app mounts on its own; poll the dump until the tree is there.
let tree;
for (let i = 0; i < 40; i++) {
  messages.length = 0;
  send({ t: 'dump' });
  tree = (await waitFor((m) => m.t === 'tree', 'tree')).root;
  if (collect(tree, 'Toggle').length > 0) break;
  await sleep(100);
}
assert.equal(collect(tree, 'Toggle').length, 3, 'demo mounted from inside JSC');
console.error('[probe] tree mounted by in-process React OK');

// Full interactive round trip without any external JS runtime for the app:
// emit -> JSC bridge -> React setState -> commit ops -> SwiftUI.
const plus = collect(tree, 'Button').find((b) => textOf(b) === '+');
assert.ok(plus, 'plus button found');
send({ t: 'emit', id: plus.id, name: 'press' });
send({ t: 'emit', id: plus.id, name: 'press' });
await sleep(400);
messages.length = 0;
send({ t: 'dump' });
tree = (await waitFor((m) => m.t === 'tree', 'tree after presses')).root;
assert.ok(
  collect(tree, 'Text').some((t) => textOf(t) === '2'),
  'counter incremented to 2 by React running inside JavaScriptCore',
);
console.error('[probe] in-process interactive round trip OK');

send({ t: 'screenshot', path: `${outDir}/04-embedded-jsc.png` });
await waitFor((m) => m.t === 'shot', 'shot');
console.error('[probe] EMBEDDED MODE VERIFIED');

send({ t: 'quit' });
setTimeout(() => process.exit(0), 300);
