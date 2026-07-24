/**
 * Automated E2E verification of the kitchen-sink app against the REAL
 * SwiftUI host: window chrome (MenuBar/Toolbar) semantics via the debug
 * `emit` channel, every controlled input kind through the real
 * optimistic-edit path (`edit`: local write + seq + change event), overlay
 * presentation round-trips, table sort/selection, and PNG screenshots.
 *
 * Documented limitation: sheets, alerts, popovers, and open menus live in
 * separate NSWindows and do not appear in cacheDisplay screenshots, so
 * presentation coverage is dump-based; the unified toolbar IS captured.
 * On macOS 26+ the TabView tab strip is a glass material whose labels
 * cacheDisplay also cannot capture (verified identical in pure SwiftUI);
 * the strip renders correctly on screen.
 *
 * Exits non-zero on any failure.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, type TreeNode } from 'natui';
import type { MenuSpec, TableRowSpec, ToolbarItemSpec } from 'natui/components';
import { App } from './App.js';

const OUT_DIR = fileURLToPath(new URL('../../../screenshots/kitchen-sink/', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Another running host would grab focus and confuse window-level checks.
function runningHosts(): string {
  try {
    return execFileSync('pgrep', ['-lf', 'natui-host'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const existing = runningHosts();
if (existing) {
  console.error(`[verify] another NatUI host is already running; close it first:\n${existing}`);
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

function byAxId(root: TreeNode, id: string): TreeNode {
  const all: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.props?.accessibilityIdentifier === id) all.push(n);
    n.children?.forEach(walk);
  };
  walk(root);
  assert.ok(all[0], `no node with accessibilityIdentifier "${id}"`);
  return all[0];
}

function assertValidPng(path: string): void {
  assert.ok(statSync(path).size > 1000, `${path} is suspiciously small`);
  const header = readFileSync(path).subarray(0, 8);
  assert.deepEqual(
    [...header],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path} lacks a PNG signature`,
  );
  const width = execFileSync('sips', ['-g', 'pixelWidth', path], { encoding: 'utf8' });
  assert.match(width, /pixelWidth: \d+/, `${path} did not decode`);
}

// === Boot ====================================================================

const app = await run(<App />, {
  title: 'NatUI kitchen sink',
  width: 900,
  height: 640,
  minWidth: 760,
  minHeight: 520,
  onClose: () => {},
});
await sleep(700);

// --- 1. Mount: chrome specs, slots, sidebar, table ---------------------------

let tree = await app.dump();

const menuBar = collect(tree, 'MenuBar')[0]!;
assert.ok(menuBar, 'MenuBar node exists');
const menus = menuBar.props?.menus as unknown as MenuSpec[];
assert.deepEqual(
  menus.map((m) => m.id),
  ['file', 'edit', 'view', 'help'],
  'four menus in the spec',
);
assert.equal(menus[0]!.items.length, 4, 'File menu: new/export/divider/close');

const toolbar = collect(tree, 'Toolbar')[0]!;
const toolbarItems = toolbar.props?.items as unknown as ToolbarItemSpec[];
assert.deepEqual(
  toolbarItems.map((i) => ('id' in i ? i.id : i.type)),
  ['back', 'add', 'fav', 'export', 'flexibleSpace', 'find'],
  'toolbar item layout',
);

const splitView = collect(tree, 'SplitView')[0]!;
assert.equal(splitView.props?.value, 'all', 'sidebar visible');
assert.equal(collect(splitView, 'Sidebar').length, 1, 'sidebar slot');
assert.equal(collect(splitView, 'Detail').length, 1, 'detail slot');

const sidebarLabels = collect(collect(tree, 'Sidebar')[0]!, 'Label');
assert.deepEqual(
  sidebarLabels.map((l) => l.props?.tag),
  ['proj-1', 'proj-2', 'proj-3'],
  'sidebar rows tagged with project ids',
);
assert.equal(sidebarLabels[0]!.props?.badge, 3, 'proj-1 badge = item count');

const table = collect(tree, 'Table')[0]!;
assert.equal((table.props?.rows as unknown as TableRowSpec[]).length, 3, 'three rows');
assert.deepEqual(table.props?.sort, { key: 'name', order: 'asc' });

assert.equal(byAxId(tree, 'project-title') && textOf(byAxId(tree, 'project-title')), 'Launch prep');
console.error('[verify] mount OK (chrome specs, slots, sidebar, table)');
await app.screenshot(`${OUT_DIR}/01-initial.png`);
assertValidPng(`${OUT_DIR}/01-initial.png`);

// --- 2. Sidebar selection through the real optimistic-edit path ---------------

const sidebarList = collect(collect(tree, 'Sidebar')[0]!, 'List')[0]!;
app.edit(sidebarList.id, 'proj-2');
await sleep(250);
tree = await app.dump();
assert.equal(textOf(byAxId(tree, 'project-title')), 'Rigging', 'detail follows selection');
assert.equal(
  (collect(tree, 'Table')[0]!.props?.rows as unknown as TableRowSpec[]).length,
  1,
  'table shows the other project',
);
app.edit(sidebarList.id, 'proj-1');
await sleep(250);
tree = await app.dump();
assert.equal(textOf(byAxId(tree, 'project-title')), 'Launch prep');
console.error('[verify] sidebar selection OK');

// --- 3. Tab switch (controlled, optimistic) ------------------------------------

const tabView = collect(tree, 'TabView')[0]!;
app.edit(tabView.id, 'form');
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'TabView')[0]!.props?.value, 'form', 'tab switch adopted');
await app.screenshot(`${OUT_DIR}/02-form-tab.png`);
assertValidPng(`${OUT_DIR}/02-form-tab.png`);
console.error('[verify] tab switch OK');

// --- 4. Every input kind through the real edit path ----------------------------

const textFields = collect(tree, 'TextField');
const nameField = textFields.find((f) => f.props?.placeholder === 'Name')!;
const secretField = textFields.find((f) => f.props?.placeholder === 'Password')!;
const searchField = collect(tree, 'SearchField')[0]!;
const datePicker = collect(tree, 'DatePicker')[0]!;
const stepper = collect(tree, 'Stepper')[0]!;
const pickers = collect(tree, 'Picker');
const statusPicker = pickers.find((p) => p.props?.style === 'segmented')!;
const sizePicker = pickers.find((p) => p.props?.style === 'radioGroup')!;
const assigneePicker = pickers.find((p) => p.props?.style === 'menu')!;
const toggles = collect(tree, 'Toggle');
const notifyToggle = toggles.find((t) => t.props?.style === 'switch')!;
const agreeToggle = toggles.find((t) => t.props?.style === 'checkbox')!;
const slider = collect(tree, 'Slider')[0]!;
const textEditor = collect(tree, 'TextEditor')[0]!;

app.edit(nameField.id, 'Nautilus');
app.edit(secretField.id, 'hunter2');
app.edit(searchField.id, 'abc');
app.edit(datePicker.id, '2026-03-04');
app.edit(stepper.id, 5);
app.edit(statusPicker.id, 'done');
app.edit(sizePicker.id, 'l');
app.edit(assigneePicker.id, 'carol');
app.edit(notifyToggle.id, false);
app.edit(agreeToggle.id, true);
app.edit(slider.id, 75);
app.edit(textEditor.id, 'Ready for review.');
await sleep(400);
tree = await app.dump();

assert.equal(
  collect(tree, 'DatePicker')[0]!.props?.value,
  '2026-03-04',
  'date value echoed canonically (byte-identical round trip)',
);
assert.equal(
  textOf(byAxId(tree, 'form-summary')),
  'Nautilus|7|abc|2026-03-04|5|done|l|carol|false|true|75|Ready for review.',
  'derived summary pins every controlled handler at once',
);
console.error('[verify] all form inputs OK (optimistic edit path)');

// --- 5. Sheet: open via press, save, host-dismiss -------------------------------

const addButton = collect(tree, 'Button').find((b) => textOf(b) === 'Add Item')!;
const sheet = collect(tree, 'Sheet')[0]!;
app.emit(addButton.id, 'press');
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'Sheet')[0]!.props?.value, true, 'sheet presented');

const draftField = collect(tree, 'TextField').find((f) => f.props?.placeholder === 'Item name')!;
app.edit(draftField.id, 'grapnel');
await sleep(250);
tree = await app.dump();
const saveButton = collect(tree, 'Button').find((b) => textOf(b) === 'Save')!;
app.emit(saveButton.id, 'press');
await sleep(300);
tree = await app.dump();
assert.equal(collect(tree, 'Sheet')[0]!.props?.value, false, 'sheet dismissed after save');
assert.equal(
  (collect(tree, 'Table')[0]!.props?.rows as unknown as TableRowSpec[]).length,
  4,
  'saved item appended',
);
const sidebarAfterSave = collect(collect(tree, 'Sidebar')[0]!, 'Label')[0]!;
assert.equal(sidebarAfterSave.props?.badge, 4, 'sidebar badge count updated');

// Reopen, then dismiss from the HOST side (Esc/close): optimistic change(false).
app.emit(addButton.id, 'press');
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'Sheet')[0]!.props?.value, true, 'sheet re-presented');
app.edit(sheet.id, false);
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'Sheet')[0]!.props?.value, false, 'host dismissal adopted');
console.error('[verify] sheet OK (present, save, host-dismiss)');

// --- 6. Alert: select-then-dismiss convergence ----------------------------------

app.edit(collect(tree, 'Table')[0]!.id, 'r2');
await sleep(250);
tree = await app.dump();
assert.equal(
  textOf(byAxId(tree, 'selection-detail')),
  'anchor (done, qty 3)',
  'selection detail follows table selection',
);
const deleteButton = collect(tree, 'Button').find((b) => textOf(b) === 'Delete Selected')!;
app.emit(deleteButton.id, 'press');
await sleep(250);
tree = await app.dump();
const alert = collect(tree, 'Alert')[0]!;
assert.equal(alert.props?.value, true, 'alert presented');
assert.match(String(alert.props?.message), /"anchor" will be removed/);

app.emit(alert.id, 'select', { value: 'delete' });
await sleep(300);
tree = await app.dump();
assert.equal(collect(tree, 'Alert')[0]!.props?.value, false, 'alert dismissed via select handler');
assert.equal(
  (collect(tree, 'Table')[0]!.props?.rows as unknown as TableRowSpec[]).length,
  3,
  'row deleted',
);
assert.equal(textOf(byAxId(tree, 'last-action')), 'last: alert:delete');
console.error('[verify] alert OK (select-before-change convergence)');

// --- 7. MenuBar / Toolbar semantics via emit (chrome diff-update path) -----------

app.emit(menuBar.id, 'select', { value: 'toggle-sidebar' });
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'SplitView')[0]!.props?.value, 'detailOnly', 'menu toggled sidebar');
const viewMenu = (collect(tree, 'MenuBar')[0]!.props?.menus as unknown as MenuSpec[])[2]!;
assert.equal(
  (viewMenu.items[0] as { checked?: boolean }).checked,
  false,
  'menu checkmark echoed via props',
);
app.emit(menuBar.id, 'select', { value: 'toggle-sidebar' });
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'SplitView')[0]!.props?.value, 'all', 'sidebar restored');

app.emit(toolbar.id, 'action', { value: 'fav' });
await sleep(250);
tree = await app.dump();
const favItem = (collect(tree, 'Toolbar')[0]!.props?.items as unknown as ToolbarItemSpec[]).find(
  (i) => 'id' in i && i.id === 'fav',
) as { on?: boolean };
assert.equal(favItem.on, true, 'toolbar toggle state echoed via props (not optimistic)');

app.emit(toolbar.id, 'action', { value: 'export-csv' });
await sleep(250);
tree = await app.dump();
assert.equal(textOf(byAxId(tree, 'last-action')), 'last: toolbar:export-csv', 'toolbar menu leaf');

app.emit(toolbar.id, 'search', { value: 'bolt' });
await sleep(250);
tree = await app.dump();
assert.equal(
  (collect(tree, 'Table')[0]!.props?.rows as unknown as TableRowSpec[]).length,
  1,
  'toolbar search filters the data rows',
);
app.emit(toolbar.id, 'search', { value: '' });
await sleep(250);
console.error('[verify] menu bar + toolbar OK (select/action/search, prop echoes)');

// --- 8. Table sort (request semantics), context menu, popover --------------------

tree = await app.dump();
app.emit(collect(tree, 'Table')[0]!.id, 'sortChange', { value: { key: 'name', order: 'desc' } });
await sleep(250);
tree = await app.dump();
let tableNow = collect(tree, 'Table')[0]!;
assert.deepEqual(tableNow.props?.sort, { key: 'name', order: 'desc' }, 'sort echoed');
assert.deepEqual(
  (tableNow.props?.rows as unknown as TableRowSpec[]).map((r) => r.cells!.name),
  ['grapnel', 'clamp', 'bolt'],
  'rows re-sorted by the APP (host never sorts)',
);

app.edit(tableNow.id, 'r3');
await sleep(250);
tree = await app.dump();
assert.equal(textOf(byAxId(tree, 'selection-detail')), 'clamp (active, qty 5)');

const contextMenu = collect(tree, 'ContextMenu')[0]!;
app.emit(contextMenu.id, 'select', { value: 'duplicate' });
await sleep(250);
tree = await app.dump();
tableNow = collect(tree, 'Table')[0]!;
assert.ok(
  (tableNow.props?.rows as unknown as TableRowSpec[]).some((r) => r.cells!.name === 'clamp copy'),
  'context-menu duplicate added a row',
);

const helpButton = collect(tree, 'Button').find((b) => textOf(b) === 'What is this?')!;
const popover = collect(tree, 'Popover')[0]!;
app.emit(helpButton.id, 'press');
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'Popover')[0]!.props?.value, true, 'popover presented');
app.edit(popover.id, false);
await sleep(250);
tree = await app.dump();
assert.equal(collect(tree, 'Popover')[0]!.props?.value, false, 'popover host-dismiss adopted');
console.error('[verify] table sort/selection, context menu, popover OK');

// --- 9. Final screenshot on the data tab ------------------------------------------

app.edit(collect(tree, 'TabView')[0]!.id, 'data');
await sleep(400);
tree = await app.dump();
assert.equal(collect(tree, 'TabView')[0]!.props?.value, 'data');
await app.screenshot(`${OUT_DIR}/03-data-tab.png`);
assertValidPng(`${OUT_DIR}/03-data-tab.png`);

console.error('[verify] ALL CHECKS PASSED');
app.quit();
setTimeout(() => process.exit(0), 400);
