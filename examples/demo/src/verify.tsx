/**
 * Automated E2E verification against the REAL SwiftUI host.
 * Mounts the demo app, checks the native tree via dump, synthesizes user
 * events via the debug emit channel, re-checks state, and captures PNG
 * screenshots of the actual native window. Exits non-zero on any failure.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { run, type TreeNode } from 'natui';
import { App } from './App.js';

const OUT_DIR = new URL('../../../screenshots/', import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const app = await run(<App />, {
  title: 'natui demo',
  width: 480,
  height: 620,
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

// --- 3. Add a todo through the real TextField value flow ----------------------
const field = collect(tree, 'TextField')[0]!;
app.emit(field.id, 'change', { value: 'Ship it' });
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
console.error('[verify] todo add OK');

// --- 4. Toggle + remove -------------------------------------------------------
const shipToggle = collect(tree, 'Toggle').find((t) => textOf(t) === 'Ship it')!;
app.emit(shipToggle.id, 'change', { value: true });
await sleep(200);
tree = await app.dump();
assert.equal(
  collect(tree, 'Toggle').find((t) => textOf(t) === 'Ship it')!.props?.value,
  true,
  'toggle round-tripped to true',
);
console.error('[verify] toggle OK');
await app.screenshot(`${OUT_DIR}/02-after-interactions.png`);

// --- 5. Slider continuous events ----------------------------------------------
const slider = collect(tree, 'Slider')[0]!;
app.emit(slider.id, 'change', { value: 85 });
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

console.error('[verify] ALL CHECKS PASSED');
app.quit();
setTimeout(() => process.exit(0), 400);
