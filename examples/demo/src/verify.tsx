/**
 * Automated E2E verification against the REAL SwiftUI host, in two phases:
 *
 *  1. The demo app: tree dump checks, button presses via the debug `emit`
 *     channel, controlled TextField/Toggle flows via the debug `edit` channel
 *     (a real optimistic edit: local write + seq + change event, exactly the
 *     user-typing path), and PNG screenshots of the actual native window.
 *  2. A stress app exercising the hard controlled-input cases end to end on
 *     the native side: transform adoption, stale-echo suppression during
 *     fast typing, rejected/clamped edits (enforcement), Slider clamping,
 *     and screenshot failure replies.
 *
 * Exits non-zero on any failure.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { run, Slider, Text, TextField, VStack, type TreeNode } from 'natui';
import { App } from './App.js';

// fileURLToPath, not URL.pathname: the latter yields "/C:/…" on Windows.
const OUT_DIR = fileURLToPath(new URL('../../../screenshots/', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Another running host would grab focus and confuse window-level checks;
// refuse to run next to one (e.g. a forgotten `pnpm demo`).
function runningHosts(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq NatuiHost.exe', '/NH'],
        { encoding: 'utf8' },
      ).trim();
      return out.includes('NatuiHost.exe') ? out : '';
    }
    // pgrep exits 1 when nothing matches; that is the good case.
    return execFileSync('pgrep', ['-lf', 'natui-host'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const existingHosts = runningHosts();
if (existingHosts) {
  console.error(
    `[verify] another natui host is already running; close it first:\n${existingHosts}`,
  );
  process.exit(1);
}

function collect(root: TreeNode, kind: string): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === kind) out.push(n);
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

function textOf(node: TreeNode): string {
  if (node.kind === '#text') return node.text ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** The screenshot must exist, be non-empty, and decode as a real PNG. */
function assertValidPng(path: string): void {
  assert.ok(statSync(path).size > 1000, `${path} is suspiciously small`);
  const header = readFileSync(path).subarray(0, 8);
  assert.deepEqual(
    [...header],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path} lacks a PNG signature`,
  );
  if (process.platform === 'win32') {
    // System.Drawing decodes the image; a corrupt file makes FromFile throw
    // and the script exit non-zero (the Windows counterpart of sips below).
    const width = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile('${path.replace(/'/g, "''")}'); "pixelWidth: $($i.Width)"; $i.Dispose()`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(width, /pixelWidth: \d+/, `${path} did not decode`);
    return;
  }
  // sips decodes the image; a corrupt file makes it exit non-zero.
  const width = execFileSync('sips', ['-g', 'pixelWidth', path], { encoding: 'utf8' });
  assert.match(width, /pixelWidth: \d+/, `${path} did not decode`);
}

// === Phase 1: demo app =======================================================

let app = await run(<App />, {
  title: 'natui demo',
  width: 480,
  height: 620,
  // This script owns the lifecycle: the window closing as a side effect of
  // quit() must not fire the default onClose (which exits the process).
  onClose: () => {},
});

await sleep(500);

// --- 1. Initial tree ---------------------------------------------------------
let tree = await app.dump();
const toggles = collect(tree, 'Toggle');
assert.equal(toggles.length, 3, 'three todos rendered natively');
assert.deepEqual(
  toggles.map((t) => textOf(t)),
  ['Write a React reconciler', 'Render real SwiftUI from it', 'Port the host to WinUI 3'],
);
const counterText = collect(tree, 'Text').find((t) => textOf(t) === '0');
assert.ok(counterText, 'counter shows 0');
console.error('[verify] initial tree OK');
await app.screenshot(`${OUT_DIR}/01-initial.png`);
assertValidPng(`${OUT_DIR}/01-initial.png`);

// --- 2. Counter round trip ----------------------------------------------------
const plusButton = collect(tree, 'Button').find((b) => textOf(b) === '+');
assert.ok(plusButton, 'plus button found');
for (let i = 0; i < 3; i++) app.emit(plusButton.id, 'press');
await sleep(300);
tree = await app.dump();
assert.ok(
  collect(tree, 'Text').some((t) => textOf(t) === '3'),
  'counter shows 3 after three presses',
);
assert.ok(
  collect(tree, 'Button').some((b) => textOf(b) === 'Reset'),
  'conditional Reset button appeared',
);
console.error('[verify] counter round trip OK');

// --- 3. Add a todo through the real optimistic-edit flow ----------------------
const field = collect(tree, 'TextField')[0]!;
app.edit(field.id, 'Ship it');
await sleep(200);
tree = await app.dump();
assert.equal(collect(tree, 'TextField')[0]!.props?.value, 'Ship it', 'field is controlled');
const addButton = collect(tree, 'Button').find((b) => textOf(b) === 'Add');
assert.ok(addButton, 'add button found');
app.emit(addButton.id, 'press');
await sleep(300);
tree = await app.dump();
assert.equal(collect(tree, 'Toggle').length, 4, 'todo added');
assert.equal(collect(tree, 'TextField')[0]!.props?.value, '', 'field cleared after add');
console.error('[verify] todo add OK (optimistic edit path)');

// --- 4. Toggle + screenshot ---------------------------------------------------
const shipToggle = collect(tree, 'Toggle').find((t) => textOf(t) === 'Ship it')!;
app.edit(shipToggle.id, true);
await sleep(200);
tree = await app.dump();
assert.equal(
  collect(tree, 'Toggle').find((t) => textOf(t) === 'Ship it')!.props?.value,
  true,
  'toggle round-tripped to true',
);
console.error('[verify] toggle OK');
await app.screenshot(`${OUT_DIR}/02-after-interactions.png`);
assertValidPng(`${OUT_DIR}/02-after-interactions.png`);

// --- 5. Slider through the optimistic-edit path --------------------------------
const slider = collect(tree, 'Slider')[0]!;
app.edit(slider.id, 85);
await sleep(200);
tree = await app.dump();
assert.equal(collect(tree, 'Slider')[0]!.props?.value, 85, 'slider value round-tripped');
assert.ok(
  collect(tree, 'Text').some((t) => textOf(t) === '85'),
  'slider label updated',
);
const progress = collect(tree, 'ProgressView')[0]!;
assert.equal(progress.props?.value, 0.85, 'progress bar tracks slider');
console.error('[verify] slider OK');
// Let the native progress bar finish animating before the shot.
await sleep(1200);
await app.screenshot(`${OUT_DIR}/03-final.png`);
assertValidPng(`${OUT_DIR}/03-final.png`);

app.quit();
await sleep(500);

// === Phase 2: controlled-input stress app =====================================
// Every check below exercises the NATIVE seq/ack machinery: `edit` performs a
// real optimistic edit in the SwiftUI store (value write + seq + event), so
// suppression and enforcement run in the host, not in a JS mock.

function StressApp() {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [level, setLevel] = useState(20);
  return (
    <VStack spacing={8} padding={16} frame={{ minWidth: 300 }}>
      <TextField value={name} placeholder="uppercased" onChange={(v) => setName(v.toUpperCase())} />
      <TextField
        value={pin}
        placeholder="digits, max 4"
        onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
      />
      <Slider value={level} min={0} max={100} onChange={(v) => setLevel(Math.min(v, 50))} />
      <Text accessibilityIdentifier="status">{`${name}|${pin}|${String(level)}`}</Text>
    </VStack>
  );
}

app = await run(<StressApp />, {
  title: 'natui stress',
  width: 360,
  height: 240,
  onClose: () => {},
});
await sleep(400);

tree = await app.dump();
const [nameField, pinField] = collect(tree, 'TextField');
const stressSlider = collect(tree, 'Slider')[0]!;
assert.ok(nameField && pinField && stressSlider, 'stress controls mounted');

// Transform adoption: the controlled transform must win over the echo.
app.edit(nameField.id, 'hey');
await sleep(200);
tree = await app.dump();
assert.equal(collect(tree, 'TextField')[0]!.props?.value, 'HEY', 'uppercase transform adopted');

// Fast typing: two optimistic edits back to back must CONVERGE on the last
// value. (This races real echoes, so it pins convergence, not suppression
// itself; the deterministic stale-ack suppression check lives in
// verify-embedded.mjs, where the probe owns the wire and injects acks.)
app.edit(nameField.id, 'HEYA');
app.edit(nameField.id, 'HEYAB');
await sleep(300);
tree = await app.dump();
assert.equal(
  collect(tree, 'TextField')[0]!.props?.value,
  'HEYAB',
  'fast typing converges on the newest value',
);

// Rejected edit: letters are filtered out; enforcement must snap the native
// field back to the committed value.
app.edit(pinField.id, '12');
await sleep(200);
app.edit(pinField.id, '12a');
await sleep(300);
tree = await app.dump();
assert.equal(
  collect(tree, 'TextField')[1]!.props?.value,
  '12',
  'rejected edit enforced back to committed value on the native side',
);

// Clamped edit: max length 4.
app.edit(pinField.id, '123456');
await sleep(300);
tree = await app.dump();
assert.equal(collect(tree, 'TextField')[1]!.props?.value, '1234', 'clamped to 4 digits');

// Slider clamp at 50.
app.edit(stressSlider.id, 90);
await sleep(300);
tree = await app.dump();
assert.equal(collect(tree, 'Slider')[0]!.props?.value, 50, 'native slider settles on the clamp');
assert.ok(
  collect(tree, 'Text').some((t) => textOf(t) === 'HEYAB|1234|50'),
  'React state matches the enforced native state',
);
console.error('[verify] controlled-input stress OK (seq/ack exercised natively)');

// Screenshot failure: the host must reply with an error (not hang) when the
// path is unwritable, and the JS promise must reject.
await assert.rejects(
  app.screenshot('/nonexistent-natui-dir/nope.png'),
  /screenshot failed/,
  'unwritable screenshot path rejects with the host-reported error',
);
console.error('[verify] screenshot failure reply OK');

console.error('[verify] ALL CHECKS PASSED');
app.quit();
setTimeout(() => process.exit(0), 400);
