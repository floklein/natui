/**
 * Selection contract tests: List/Table controlled selection over row tags,
 * TabView controlled tab switching, Table request-semantics sorting, and
 * DisclosureGroup expansion, all riding the standard value/change/seq-ack
 * machinery.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { useState } from 'react';
import {
  Button,
  DisclosureGroup,
  List,
  Tab,
  TabView,
  Table,
  Text,
  VStack,
  type SortDescriptor,
  type TableRowSpec,
} from '../src/components.js';
import type { Op } from '../src/protocol.js';
import { settle, setup, type TestSetup } from './helpers.js';

function updateOpsFor(sent: TestSetup['transport']['sent'], id: number) {
  return sent
    .filter((m) => m.t === 'commit')
    .flatMap((m) => (m as { t: 'commit'; ops: Op[] }).ops)
    .filter((op): op is Extract<Op, { op: 'update' }> => op.op === 'update' && op.id === id);
}

// ---------------------------------------------------------------------------
// List selection
// ---------------------------------------------------------------------------

function SelectableList({
  mode,
  adopt = true,
}: {
  mode?: 'single' | 'multiple';
  adopt?: boolean;
}) {
  const [selection, setSelection] = useState<string | string[] | null>(
    mode === 'multiple' ? [] : 'a',
  );
  return (
    <List value={selection} selectionMode={mode} onChange={adopt ? setSelection : () => {}}>
      <Text tag="a">alpha</Text>
      <Text tag="b">beta</Text>
      <Text tag="c">gamma</Text>
    </List>
  );
}

test('List single selection: accept, deselect to null, reject', async () => {
  const { host, renderer } = setup();
  renderer.render(<SelectableList />);
  await settle();
  host.drain();
  const list = host.byKind('List')[0]!;
  assert.equal(list.props.value, 'a');
  assert.equal(host.byKind('Text')[1]!.props.tag, 'b', 'rows carry their tags');

  host.userEdit(list.id, 'b');
  await settle();
  host.drain();
  assert.equal(host.byKind('List')[0]!.props.value, 'b', 'selection adopted');

  host.userEdit(list.id, null);
  await settle();
  host.drain();
  assert.equal(host.byKind('List')[0]!.props.value, null, 'deselection round-trips as null');
});

test('List selection rejection snaps back via enforcement', async () => {
  const { host, renderer } = setup();
  renderer.render(<SelectableList adopt={false} />);
  await settle();
  host.drain();
  const list = host.byKind('List')[0]!;

  host.userEdit(list.id, 'c');
  await settle();
  host.drain();
  assert.equal(host.byKind('List')[0]!.props.value, 'a', 'refused selection snapped back');
});

test('List multiple selection round-trips a sorted tag array', async () => {
  const { host, renderer } = setup();
  renderer.render(<SelectableList mode="multiple" />);
  await settle();
  host.drain();
  const list = host.byKind('List')[0]!;
  assert.deepEqual(list.props.value, []);

  host.userEdit(list.id, ['a', 'c']);
  await settle();
  host.drain();
  assert.deepEqual(host.byKind('List')[0]!.props.value, ['a', 'c'], 'multi-selection adopted');
});

test('removing the selected row: app clears selection; stale events for the dead node are dropped', async () => {
  const { host, renderer, transport } = setup();
  function App() {
    const [rows, setRows] = useState(['a', 'b']);
    const [selection, setSelection] = useState<string | null>('b');
    return (
      <VStack>
        <List value={selection} onChange={(v) => setSelection(v as string | null)}>
          {rows.map((r) => (
            <Text key={r} tag={r}>
              {r}
            </Text>
          ))}
        </List>
        <Button
          onPress={() => {
            setRows(['a']);
            setSelection(null);
          }}
        >
          remove b
        </Button>
      </VStack>
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();

  const doomedRowId = host.byKind('Text').find((t) => t.props.tag === 'b')!.id;
  transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
  await settle();
  host.drain();

  assert.equal(host.byKind('Text').length, 1, 'row removed natively');
  assert.equal(host.byKind('List')[0]!.props.value, null, 'selection cleared by the app');

  // A straggler event for the destroyed row id must be dropped silently: no
  // crash, no handler dispatch, no corrective commit.
  transport.sent.length = 0;
  transport.emit({ t: 'event', id: doomedRowId, name: 'change', payload: { value: 'b' }, seq: 7 });
  await settle();
  assert.equal(transport.sent.length, 0, 'stale event for a destroyed node produced nothing');
});

// ---------------------------------------------------------------------------
// TabView
// ---------------------------------------------------------------------------

test('TabView: optimistic tab click adopted, rejection snaps back', async () => {
  const { host, renderer } = setup();
  function App({ adopt }: { adopt: boolean }) {
    const [tab, setTab] = useState('overview');
    return (
      <TabView value={tab} onChange={adopt ? setTab : () => {}}>
        <Tab id="overview" title="Overview">
          <Text>o</Text>
        </Tab>
        <Tab id="form" title="Form" badge={3}>
          <Text>f</Text>
        </Tab>
      </TabView>
    );
  }

  renderer.render(<App adopt={true} />);
  await settle();
  host.drain();
  const tabView = host.byKind('TabView')[0]!;
  assert.equal(tabView.props.value, 'overview');
  assert.equal(host.byKind('Tab')[1]!.props.badge, 3, 'badge common prop crosses the wire');

  host.userEdit(tabView.id, 'form');
  await settle();
  host.drain();
  assert.equal(host.byKind('TabView')[0]!.props.value, 'form', 'tab switch adopted');

  const { host: host2, renderer: renderer2 } = setup();
  renderer2.render(<App adopt={false} />);
  await settle();
  host2.drain();
  const stubborn = host2.byKind('TabView')[0]!;
  host2.userEdit(stubborn.id, 'form');
  await settle();
  host2.drain();
  assert.equal(host2.byKind('TabView')[0]!.props.value, 'overview', 'refused switch snapped back');
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'qty', label: 'Qty' },
  { key: 'notes', label: 'Notes', sortable: false },
];

const ROWS: TableRowSpec[] = [
  { id: 'r1', cells: { name: 'bolt', qty: '9', notes: '' } },
  { id: 'r2', cells: { name: 'anchor', qty: '3', notes: '' } },
  { id: 'r3', cells: { name: 'clamp', qty: '5', notes: '' } },
];

function sortRows(rows: TableRowSpec[], sort: SortDescriptor): TableRowSpec[] {
  const sorted = [...rows].sort((a, b) =>
    (a.cells[sort.key] ?? '').localeCompare(b.cells[sort.key] ?? ''),
  );
  return sort.order === 'desc' ? sorted.reverse() : sorted;
}

function TableApp() {
  const [rows, setRows] = useState(ROWS);
  const [sort, setSort] = useState<SortDescriptor>({ key: 'name', order: 'asc' });
  const [selection, setSelection] = useState<string | string[] | null>(null);
  return (
    <Table
      columns={COLUMNS}
      rows={rows}
      value={selection}
      sort={sort}
      onChange={setSelection}
      onSortChange={(next) => {
        setSort(next);
        setRows((r) => sortRows(r, next));
      }}
    />
  );
}

test('Table: selection round-trips; header click re-sorts via the app; no corrective on sort', async () => {
  const { host, renderer, transport } = setup();
  renderer.render(<TableApp />);
  await settle();
  host.drain();
  const table = host.byKind('Table')[0]!;
  assert.equal(table.props.value, null, 'selectable (value present), nothing selected');

  // Row click.
  host.userEdit(table.id, 'r2');
  await settle();
  host.drain();
  assert.equal(host.byKind('Table')[0]!.props.value, 'r2');

  // Sort by name: request semantics. The app reorders rows and echoes sort.
  transport.sent.length = 0;
  assert.ok(host.sortClick(table.id, 'name'));
  await settle();

  const updates = updateOpsFor(transport.sent, table.id);
  assert.equal(updates.length, 1, 'exactly the app-driven update, no corrective');
  host.drain();
  const after = host.byKind('Table')[0]!;
  assert.deepEqual(after.props.sort, { key: 'name', order: 'desc' }, 'sort echoed (asc flipped)');
  assert.deepEqual(
    (after.props.rows as unknown as TableRowSpec[]).map((r) => r.id),
    ['r3', 'r1', 'r2'],
    'rows reordered by the app, not the host',
  );
  assert.equal(after.props.value, 'r2', 'selection survives the sort');

  // Non-sortable column: no event at all.
  transport.sent.length = 0;
  assert.equal(host.sortClick(table.id, 'notes'), false);
  await settle();
  assert.equal(transport.sent.length, 0, 'non-sortable header click produced nothing');
});

// ---------------------------------------------------------------------------
// DisclosureGroup
// ---------------------------------------------------------------------------

test('DisclosureGroup: adopted collapse and refused collapse', async () => {
  const { host, renderer } = setup();
  function App({ adopt }: { adopt: boolean }) {
    const [open, setOpen] = useState(true);
    return (
      <DisclosureGroup label="Details" value={open} onChange={adopt ? setOpen : () => {}}>
        <Text>body</Text>
      </DisclosureGroup>
    );
  }

  renderer.render(<App adopt={true} />);
  await settle();
  host.drain();
  const group = host.byKind('DisclosureGroup')[0]!;
  assert.equal(group.props.label, 'Details');
  assert.equal(group.props.value, true);
  assert.equal(host.textOf(host.byKind('Text')[0]!.id), 'body', 'children materialize eagerly');

  host.userEdit(group.id, false);
  await settle();
  host.drain();
  assert.equal(host.byKind('DisclosureGroup')[0]!.props.value, false, 'collapse adopted');

  const { host: host2, renderer: renderer2 } = setup();
  renderer2.render(<App adopt={false} />);
  await settle();
  host2.drain();
  host2.userEdit(host2.byKind('DisclosureGroup')[0]!.id, false);
  await settle();
  host2.drain();
  assert.equal(
    host2.byKind('DisclosureGroup')[0]!.props.value,
    true,
    'refused collapse snapped back open',
  );
});
