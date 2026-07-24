/**
 * Stage 2 verification: launches the NatUI host with the React app bundle
 * evaluated IN-PROCESS by JavaScriptCore (no Node running the app), then
 * drives it over the stdio debug channel: tree dumps, synthesized events,
 * and a host-rendered screenshot. Exits non-zero on failure.
 *
 *   node src/verify-embedded.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
// Same lookup order as the NatUI renderer: env override, then the release
// build the README documents, then a local debug build.
const hostBin =
  process.env.NATUI_HOST ??
  [
    `${repoRoot}hosts/macos/.build/release/natui-host`,
    `${repoRoot}hosts/macos/.build/debug/natui-host`,
  ].find(existsSync);
assert.ok(
  hostBin,
  'natui-host not built. Run: pnpm build:host:macos (or set NATUI_HOST)',
);
const bundle = fileURLToPath(new URL('../dist/embedded.js', import.meta.url));
assert.ok(existsSync(bundle), 'embedded bundle missing. Run: pnpm build:embedded');
const outDir = `${repoRoot}screenshots`;
mkdirSync(outDir, { recursive: true });

// Refuse to run next to an already-running host (e.g. a forgotten pnpm demo).
try {
  const existing = execFileSync('pgrep', ['-lf', 'natui-host'], { encoding: 'utf8' }).trim();
  if (existing) {
    console.error(`[probe] another NatUI host is already running; close it first:\n${existing}`);
    process.exit(1);
  }
} catch {
  // pgrep exits 1 when nothing matches; that is the good case.
}

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

// --- Native seq/ack host contract, deterministically. -------------------------
// `edit` performs a real optimistic edit (host seq += 1). Because this probe
// owns the stdio channel, it can then impersonate the renderer with updates
// carrying chosen acks: a stale ack must be suppressed, a current ack must win.
messages.length = 0;
send({ t: 'dump' });
tree = (await waitFor((m) => m.t === 'tree', 'tree before seq/ack contract')).root;
const field = collect(tree, 'TextField')[0];
assert.ok(field, 'demo TextField found');
send({ t: 'edit', id: field.id, value: 'racing' });
await sleep(400); // in-proc React adopts the value (echo carries ack == seq 1)
send({ t: 'commit', ops: [{ op: 'update', id: field.id, props: { value: 'STALE' }, ack: 0 }] });
await sleep(100);
messages.length = 0;
send({ t: 'dump' });
tree = (await waitFor((m) => m.t === 'tree', 'tree after stale update')).root;
assert.equal(
  collect(tree, 'TextField')[0].props?.value,
  'racing',
  'update with stale ack (0 < lastSentSeq 1) must be suppressed by the host',
);
send({ t: 'commit', ops: [{ op: 'update', id: field.id, props: { value: 'CURRENT' }, ack: 1 }] });
await sleep(100);
messages.length = 0;
send({ t: 'dump' });
tree = (await waitFor((m) => m.t === 'tree', 'tree after authoritative update')).root;
assert.equal(
  collect(tree, 'TextField')[0].props?.value,
  'CURRENT',
  'update with current ack (== lastSentSeq) is authoritative',
);
console.error('[probe] native seq/ack contract OK (stale suppressed, current wins)');

const shotPath = `${outDir}/04-embedded-jsc.png`;
send({ t: 'screenshot', path: shotPath });
const shot = await waitFor((m) => m.t === 'shot', 'shot');
assert.ok(!shot.error, `screenshot failed: ${shot.error}`);
// The PNG must exist, be non-empty, and decode.
assert.ok(statSync(shotPath).size > 1000, 'screenshot is suspiciously small');
assert.deepEqual(
  [...readFileSync(shotPath).subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'screenshot lacks a PNG signature',
);
assert.match(
  execFileSync('sips', ['-g', 'pixelWidth', shotPath], { encoding: 'utf8' }),
  /pixelWidth: \d+/,
  'screenshot did not decode',
);
console.error('[probe] EMBEDDED MODE VERIFIED');

send({ t: 'quit' });
await new Promise((r) => host.on('exit', r));

// --- Lifecycle regression: an embedded app must survive a closed stdin. -------
// Stdin is only the optional debug channel in --bundle mode; EOF on it must
// not terminate the application (it used to).
const orphan = spawn(hostBin, ['--bundle', bundle], { stdio: ['ignore', 'ignore', 'inherit'] });
await sleep(2500);
assert.equal(orphan.exitCode, null, 'embedded host must stay alive with stdin closed');
orphan.kill('SIGTERM');
const code = await new Promise((r) => orphan.on('exit', r));
console.error(`[probe] closed-stdin lifecycle OK (survived, then terminated with ${code})`);

process.exit(0);
