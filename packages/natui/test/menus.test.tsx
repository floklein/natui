/**
 * Data-driven menu contract tests: MenuBar / Menu / ContextMenu spec trees
 * round-trip as plain JSON props, and select/action events follow the
 * documented dispatch rules (leaves only; never disabled items, dividers,
 * submenu parents, or command roles). Toolbar action/search semantics ride
 * the same machinery.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { useState } from 'react';
import {
  Button,
  ContextMenu,
  Menu,
  MenuBar,
  Text,
  Toolbar,
  VStack,
  type MenuItemSpec,
  type ToolbarItemSpec,
} from '../src/components.js';
import { settle, setup } from './helpers.js';

const FILE_ITEMS: MenuItemSpec[] = [
  { id: 'new', label: 'New Item', shortcut: 'cmd+n' },
  {
    id: 'export',
    label: 'Export',
    children: [
      { id: 'export-png', label: 'As PNG' },
      { id: 'export-csv', label: 'As CSV', disabled: true },
    ],
  },
  { divider: true },
  { id: 'close', label: 'Close', disabled: true },
];

test('MenuBar spec tree round-trips over the wire intact', async () => {
  const { host, renderer } = setup();
  renderer.render(
    <MenuBar
      menus={[
        { id: 'file', label: 'File', items: FILE_ITEMS },
        { id: 'edit', label: 'Edit', items: [{ id: 'copy', label: 'Copy', role: 'copy' }] },
      ]}
    />,
  );
  await settle();
  host.drain();

  const bar = host.byKind('MenuBar')[0]!;
  const menus = bar.props.menus as Array<{ id: string; label: string; items: unknown[] }>;
  assert.equal(menus.length, 2);
  assert.equal(menus[0]!.id, 'file');
  assert.deepEqual(menus[0]!.items, FILE_ITEMS, 'nested spec tree survives serialization');
  assert.deepEqual(menus[1]!.items, [{ id: 'copy', label: 'Copy', role: 'copy' }]);
});

test('menu select dispatches for leaves only: submenu leaf yes; disabled/divider/parent/role no', async () => {
  const { host, renderer } = setup();
  const selected: string[] = [];
  renderer.render(
    <MenuBar
      menus={[
        { id: 'file', label: 'File', items: FILE_ITEMS },
        { id: 'edit', label: 'Edit', items: [{ id: 'copy', label: 'Copy', role: 'copy' }] },
      ]}
      onSelect={(id) => selected.push(id)}
    />,
  );
  await settle();
  host.drain();
  const bar = host.byKind('MenuBar')[0]!;

  assert.equal(host.menuSelect(bar.id, 'new'), true, 'plain leaf fires');
  assert.equal(host.menuSelect(bar.id, 'export-png'), true, 'nested submenu leaf fires');
  assert.equal(host.menuSelect(bar.id, 'export-csv'), false, 'disabled nested leaf is silent');
  assert.equal(host.menuSelect(bar.id, 'export'), false, 'submenu parent is silent');
  assert.equal(host.menuSelect(bar.id, 'close'), false, 'disabled item is silent');
  assert.equal(host.menuSelect(bar.id, 'copy'), false, 'command-role item is native, no event');
  assert.equal(host.menuSelect(bar.id, 'nope'), false, 'unknown id is silent');
  await settle();
  host.drain();

  assert.deepEqual(selected, ['new', 'export-png'], 'handler saw exactly the two legal selects');
});

test('checked menu item flips via props, not optimistically', async () => {
  const { host, renderer } = setup();
  function App() {
    const [showSidebar, setShowSidebar] = useState(true);
    return (
      <MenuBar
        menus={[
          {
            id: 'view',
            label: 'View',
            items: [{ id: 'toggle-sidebar', label: 'Show Sidebar', checked: showSidebar }],
          },
        ]}
        onSelect={(id) => id === 'toggle-sidebar' && setShowSidebar((v) => !v)}
      />
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();

  const bar = host.byKind('MenuBar')[0]!;
  const checked = () =>
    (bar.props.menus as Array<{ items: Array<{ checked?: boolean }> }>)[0]!.items[0]!.checked;
  assert.equal(checked(), true);

  assert.ok(host.menuSelect(bar.id, 'toggle-sidebar'));
  await settle();
  host.drain();
  assert.equal(checked(), false, 'select round-tripped into checked:false');
});

test('Menu (dropdown) and ContextMenu dispatch select with their own item trees', async () => {
  const { host, renderer } = setup();
  const picks: string[] = [];
  renderer.render(
    <VStack>
      <Menu items={[{ id: 'dup', label: 'Duplicate' }]} onSelect={(id) => picks.push(`menu:${id}`)}>
        Actions
      </Menu>
      <ContextMenu
        items={[{ id: 'del', label: 'Delete', role: 'destructive' }]}
        onSelect={(id) => picks.push(`ctx:${id}`)}
      >
        <Text>target</Text>
      </ContextMenu>
    </VStack>,
  );
  await settle();
  host.drain();

  assert.ok(host.menuSelect(host.byKind('Menu')[0]!.id, 'dup'));
  // destructive is a styling role, not a command role: it still emits.
  assert.ok(host.menuSelect(host.byKind('ContextMenu')[0]!.id, 'del'));
  await settle();
  assert.deepEqual(picks, ['menu:dup', 'ctx:del']);
});

test('ContextMenu still dispatches after a keyed reorder', async () => {
  const { host, renderer, transport } = setup();
  const picks: string[] = [];
  function App() {
    const [order, setOrder] = useState(['a', 'b']);
    return (
      <VStack>
        {order.map((row) => (
          <ContextMenu
            key={row}
            items={[{ id: 'pick', label: 'Pick' }]}
            onSelect={() => picks.push(row)}
          >
            <Text>{row}</Text>
          </ContextMenu>
        ))}
        <Button onPress={() => setOrder((o) => [...o].reverse())}>flip</Button>
      </VStack>
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();

  const idOfA = host.byKind('ContextMenu')[0]!.id;
  host.menuSelect(idOfA, 'pick');
  await settle();
  host.drain();
  assert.deepEqual(picks, ['a']);

  // Reorder: keyed move, same node ids in swapped document order.
  transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.equal(host.byKind('ContextMenu')[1]!.id, idOfA, 'row a moved, not recreated');

  host.menuSelect(idOfA, 'pick');
  await settle();
  assert.deepEqual(picks, ['a', 'a'], 'moved row still dispatches to its own handler');
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function toolbarItems(fav: boolean): ToolbarItemSpec[] {
  return [
    { type: 'button', id: 'back', systemImage: 'chevron.left', disabled: true },
    { type: 'button', id: 'add', label: 'New Item', systemImage: 'plus' },
    { type: 'toggle', id: 'fav', systemImage: 'star', on: fav },
    {
      type: 'menu',
      id: 'export',
      systemImage: 'square.and.arrow.up',
      items: [
        { id: 'export-png', label: 'PNG' },
        { id: 'export-json', label: 'JSON', disabled: true },
      ],
    },
    { type: 'flexibleSpace' },
    { type: 'search', id: 'find', placeholder: 'Search' },
  ];
}

test('toolbar buttons, toggles, and menu leaves emit action; disabled items are silent', async () => {
  const { host, renderer } = setup();
  const actions: string[] = [];
  function App() {
    const [fav, setFav] = useState(false);
    return (
      <Toolbar
        items={toolbarItems(fav)}
        onAction={(id) => {
          actions.push(id);
          if (id === 'fav') setFav((v) => !v);
        }}
      />
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();
  const toolbar = host.byKind('Toolbar')[0]!;

  assert.equal(host.toolbarAction(toolbar.id, 'back'), false, 'disabled button is silent');
  assert.equal(host.toolbarAction(toolbar.id, 'add'), true);
  assert.equal(host.toolbarAction(toolbar.id, 'export-png'), true, 'menu leaf folds into action');
  assert.equal(host.toolbarAction(toolbar.id, 'export-json'), false, 'disabled menu leaf silent');
  assert.equal(host.toolbarAction(toolbar.id, 'export'), false, 'the menu itself is not an action');
  await settle();
  host.drain();
  assert.deepEqual(actions, ['add', 'export-png']);

  // Toggle: the action fires; `on` is prop-driven and echoes back true.
  assert.equal(host.toolbarAction(toolbar.id, 'fav'), true);
  await settle();
  host.drain();
  const items = host.byKind('Toolbar')[0]!.props.items as Array<{ id?: string; on?: boolean }>;
  assert.equal(items.find((i) => i.id === 'fav')!.on, true, 'toggle state echoed via props');
});

test('toolbar search is fire-and-forget: events flow, nothing echoes into items', async () => {
  const { host, renderer, transport } = setup();
  const seen: string[] = [];
  renderer.render(<Toolbar items={toolbarItems(false)} onSearch={(v) => seen.push(v)} />);
  await settle();
  host.drain();
  const toolbar = host.byKind('Toolbar')[0]!;
  const before = JSON.stringify(toolbar.props.items);

  host.toolbarSearch(toolbar.id, 'al');
  host.toolbarSearch(toolbar.id, 'alpha');
  await settle();
  host.drain();

  assert.deepEqual(seen, ['al', 'alpha']);
  assert.equal(
    JSON.stringify(host.byKind('Toolbar')[0]!.props.items),
    before,
    'search text never appears in the items prop',
  );
  assert.equal(transport.sent.length, 0, 'no commits were produced by search events');
});
