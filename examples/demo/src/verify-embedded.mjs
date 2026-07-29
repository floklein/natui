/**
 * Stage 2 verification: launches the NatUI host with the React app bundle
 * evaluated in-process by JavaScriptCore on macOS or V8 on Windows, then
 * drives it over the stdio debug channel: tree dumps, synthesized events,
 * and a host-rendered screenshot. Exits non-zero on failure.
 *
 *   node src/verify-embedded.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { defaultHostCommand } from '@natui/core';
import {
  assertValidPng,
  collect,
  nextRequestId,
  runningHosts,
  textOf,
  waitForMessage,
} from '../../shared/probe.mjs';

const hostBin = defaultHostCommand().cmd;
const bundle = fileURLToPath(new URL('../dist/embedded.js', import.meta.url));
assert.ok(existsSync(bundle), 'embedded bundle missing. Run: pnpm build:embedded');
// Throwaway output lands in this example's own ignored dist, split per
// platform so a Windows run cannot clobber a macOS one.
const outDir = fileURLToPath(
  new URL(
    `../dist/screenshots/${process.platform === 'win32' ? 'windows' : 'macos'}/`,
    import.meta.url,
  ),
);
mkdirSync(outDir, { recursive: true });

// Refuse to run next to an already-running host (e.g. a forgotten pnpm demo).
const existingHosts = runningHosts();
if (existingHosts) {
  console.error(`[probe] another NatUI host is already running; close it first:\n${existingHosts}`);
  process.exit(1);
}

const host = spawn(hostBin, ['--bundle', bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
host.stdin.on('error', () => {
  // The host may exit before we finish writing; teardown handles that.
});
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
const waitFor = (pred, what, startIndex = 0) =>
  waitForMessage(messages, pred, what, { startIndex, timeoutMs: 10_000, pollMs: 50 });

// A failed assertion must not leave a native GUI host behind: the --bundle host
// deliberately survives stdin EOF, so an orphan would hard-fail the next run.
let orphan;
const shutdown = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin?.write(JSON.stringify({ t: 'quit' }) + '\n');
  } catch {
    // The host may already have closed its protocol channel.
  }
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
};

try {
  await waitFor((m) => m.t === 'ready', 'ready');
  console.error('[probe] host ready (bundle evaluating in-process)');

  // The embedded app mounts on its own; poll the dump until the tree is there.
  let tree;
  for (let i = 0; i < 40; i++) {
    const start = messages.length;
    send({ t: 'dump', rid: nextRequestId() });
    tree = (await waitFor((m) => m.t === 'tree', 'tree', start)).root;
    if (collect(tree, 'Toggle').length > 0) break;
    await sleep(100);
  }
  assert.equal(collect(tree, 'Toggle').length, 3, 'demo mounted inside the host JavaScript engine');
  console.error('[probe] tree mounted by in-process React OK');

  // Full interactive round trip without any external JS runtime for the app:
  // emit -> embedded bridge -> React setState -> commit ops -> native UI.
  const plus = collect(tree, 'Button').find((b) => textOf(b) === '+');
  assert.ok(plus, 'plus button found');
  send({ t: 'emit', id: plus.id, name: 'press' });
  send({ t: 'emit', id: plus.id, name: 'press' });
  await sleep(400);
  let start = messages.length;
  send({ t: 'dump', rid: nextRequestId() });
  tree = (await waitFor((m) => m.t === 'tree', 'tree after presses', start)).root;
  assert.ok(
    collect(tree, 'Text').some((t) => textOf(t) === '2'),
    'counter incremented to 2 by React running inside the native host',
  );
  console.error('[probe] in-process interactive round trip OK');

  // --- Native seq/ack host contract, deterministically. -----------------------
  // `edit` performs a real optimistic edit (host seq += 1). Because this probe
  // owns the stdio channel, it can then impersonate the renderer with updates
  // carrying chosen acks: a stale ack must be suppressed, a current ack must win.
  start = messages.length;
  send({ t: 'dump', rid: nextRequestId() });
  tree = (await waitFor((m) => m.t === 'tree', 'tree before seq/ack contract', start)).root;
  const field = collect(tree, 'TextField')[0];
  assert.ok(field, 'demo TextField found');
  send({ t: 'edit', id: field.id, value: 'racing' });
  await sleep(400); // in-proc React adopts the value (echo carries ack == seq 1)
  send({ t: 'commit', ops: [{ op: 'update', id: field.id, props: { value: 'STALE' }, ack: 0 }] });
  await sleep(100);
  start = messages.length;
  send({ t: 'dump', rid: nextRequestId() });
  tree = (await waitFor((m) => m.t === 'tree', 'tree after stale update', start)).root;
  assert.equal(
    collect(tree, 'TextField')[0].props?.value,
    'racing',
    'update with stale ack (0 < lastSentSeq 1) must be suppressed by the host',
  );
  send({ t: 'commit', ops: [{ op: 'update', id: field.id, props: { value: 'CURRENT' }, ack: 1 }] });
  await sleep(100);
  start = messages.length;
  send({ t: 'dump', rid: nextRequestId() });
  tree = (await waitFor((m) => m.t === 'tree', 'tree after authoritative update', start)).root;
  assert.equal(
    collect(tree, 'TextField')[0].props?.value,
    'CURRENT',
    'update with current ack (== lastSentSeq) is authoritative',
  );
  console.error('[probe] native seq/ack contract OK (stale suppressed, current wins)');

  const shotPath = path.join(
    outDir,
    process.platform === 'win32' ? '04-embedded-v8.png' : '04-embedded-jsc.png',
  );
  start = messages.length;
  send({ t: 'screenshot', path: shotPath });
  const shot = await waitFor((m) => m.t === 'shot', 'shot', start);
  assert.ok(!shot.error, `screenshot failed: ${shot.error}`);
  assertValidPng(shotPath);
  console.error('[probe] EMBEDDED MODE VERIFIED');

  send({ t: 'quit' });
  await new Promise((r) => host.on('exit', r));

  // --- Lifecycle regression: an embedded app must survive a closed stdin. -----
  // Stdin is only the optional debug channel in --bundle mode; EOF on it must
  // not terminate the application (it used to).
  orphan = spawn(hostBin, ['--bundle', bundle], { stdio: ['ignore', 'ignore', 'inherit'] });
  await sleep(2500);
  assert.equal(orphan.exitCode, null, 'embedded host must stay alive with stdin closed');
  orphan.kill('SIGTERM');
  const code = await new Promise((r) => orphan.on('exit', r));
  console.error(`[probe] closed-stdin lifecycle OK (survived, then terminated with ${code})`);
} finally {
  await shutdown(host);
  await shutdown(orphan);
}

process.exit(0);
