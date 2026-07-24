/**
 * Presentation-kind contract tests: Sheet / Alert / Popover ride the standard
 * controlled-value machinery with `value` = presented. Host dismissal is an
 * optimistic change(false); refusing apps re-present via the corrective
 * update; Alert buttons emit select BEFORE the dismissal change (normative
 * order) and a well-behaved app converges without any corrective op.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { useState } from 'react';
import {
  Alert,
  Button,
  Popover,
  PopoverContent,
  Sheet,
  Text,
  TextField,
  VStack,
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
// Sheet
// ---------------------------------------------------------------------------

function SheetApp({ stubborn = false }: { stubborn?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <VStack>
      <Button onPress={() => setOpen(true)}>open</Button>
      <Sheet value={open} onChange={stubborn ? () => {} : setOpen}>
        <Text>sheet body</Text>
        <TextField value="" placeholder="name" />
      </Sheet>
    </VStack>
  );
}

test('closed Sheet children materialize eagerly', async () => {
  const { host, renderer } = setup();
  renderer.render(<SheetApp />);
  await settle();
  host.drain();

  const sheet = host.byKind('Sheet')[0]!;
  assert.equal(sheet.props.value, false, 'sheet mounts closed');
  assert.equal(host.byKind('Text').length, 1, 'sheet content exists while closed');
  assert.equal(host.byKind('TextField').length, 1);
  assert.equal(host.textOf(host.byKind('Text')[0]!.id), 'sheet body');
});

test('Sheet open via app state, dismiss via optimistic host edit', async () => {
  const { host, renderer, transport } = setup();
  renderer.render(<SheetApp />);
  await settle();
  host.drain();
  const sheet = host.byKind('Sheet')[0]!;

  transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.equal(host.byKind('Sheet')[0]!.props.value, true, 'app opened the sheet');

  // Host-side dismissal (Esc / close): optimistic change(false), app adopts.
  host.dismiss(sheet.id);
  await settle();
  host.drain();
  assert.equal(host.byKind('Sheet')[0]!.props.value, false, 'dismissal adopted');
});

test('prevent-dismiss: a refusing app re-presents via the corrective update', async () => {
  const { host, renderer, transport } = setup();
  renderer.render(<SheetApp stubborn />);
  await settle();
  host.drain();
  const sheet = host.byKind('Sheet')[0]!;

  transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.equal(host.byKind('Sheet')[0]!.props.value, true);

  host.dismiss(sheet.id);
  await settle();
  host.drain();
  assert.equal(
    host.byKind('Sheet')[0]!.props.value,
    true,
    'corrective update re-presented the sheet (prevent dismissal)',
  );
});

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

const ALERT_BUTTONS = [
  { id: 'cancel', label: 'Cancel', role: 'cancel' as const },
  { id: 'delete', label: 'Delete', role: 'destructive' as const },
];

test('Alert button press: select then change converge with no corrective update op', async () => {
  const { host, renderer, transport } = setup();
  const picks: string[] = [];
  function App() {
    const [open, setOpen] = useState(true);
    return (
      <Alert
        value={open}
        title="Delete item?"
        message="This cannot be undone."
        buttons={ALERT_BUTTONS}
        onSelect={(id) => {
          picks.push(id);
          setOpen(false);
        }}
        onChange={setOpen}
      />
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();
  const alert = host.byKind('Alert')[0]!;
  assert.equal(alert.props.value, true, 'alert mounts presented');
  assert.equal(alert.props.title, 'Delete item?');

  transport.sent.length = 0;
  host.alertButtonPress(alert.id, 'delete');
  await settle();

  const updates = updateOpsFor(transport.sent, alert.id);
  assert.equal(updates.length, 1, 'exactly one update op (the select adoption), no corrective');
  assert.equal(updates[0]!.props.value, false, 'the one update dismisses');

  host.drain();
  assert.deepEqual(picks, ['delete']);
  assert.equal(host.byKind('Alert')[0]!.props.value, false, 'converged dismissed');
});

test('Alert with only onSelect pins the select-before-change order (no re-present flicker)', async () => {
  const { host, renderer, transport } = setup();
  function App() {
    const [open, setOpen] = useState(true);
    return (
      <Alert
        value={open}
        title="t"
        buttons={ALERT_BUTTONS}
        onSelect={() => setOpen(false)}
      />
    );
  }
  renderer.render(<App />);
  await settle();
  host.drain();
  const alert = host.byKind('Alert')[0]!;

  transport.sent.length = 0;
  // Normative order: select first closes the app state; the following
  // change(false) then matches the committed value, so enforcement stays
  // silent. (Change-first would find committed true != false and re-present.)
  host.alertButtonPress(alert.id, 'cancel');
  await settle();

  const updates = updateOpsFor(transport.sent, alert.id);
  assert.equal(updates.length, 1, 'one update, no corrective re-present');
  assert.equal(updates[0]!.props.value, false);
  host.drain();
  assert.equal(host.byKind('Alert')[0]!.props.value, false, 'stays dismissed, never flickered');
});

test('Alert Esc-style dismissal with no handlers snaps back (fully controlled)', async () => {
  const { host, renderer } = setup();
  renderer.render(<Alert value={true} title="stuck" buttons={ALERT_BUTTONS} />);
  await settle();
  host.drain();
  const alert = host.byKind('Alert')[0]!;

  host.dismiss(alert.id);
  await settle();
  host.drain();
  assert.equal(host.byKind('Alert')[0]!.props.value, true, 'no handler: corrective re-presents');
});

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

function PopoverApp({ contentFirst }: { contentFirst: boolean }) {
  const [open, setOpen] = useState(false);
  const content = (
    <PopoverContent key="content" padding={8}>
      <Text>help text</Text>
    </PopoverContent>
  );
  const anchor = (
    <Button key="anchor" onPress={() => setOpen(true)}>
      info
    </Button>
  );
  return (
    <Popover value={open} arrowEdge="bottom" onChange={setOpen}>
      {contentFirst ? [content, anchor] : [anchor, content]}
    </Popover>
  );
}

for (const contentFirst of [false, true]) {
  test(`Popover slot routing is order-independent (content ${contentFirst ? 'first' : 'last'})`, async () => {
    const { host, renderer, transport } = setup();
    renderer.render(<PopoverApp contentFirst={contentFirst} />);
    await settle();
    host.drain();

    const popover = host.byKind('Popover')[0]!;
    assert.equal(popover.props.value, false);
    assert.equal(popover.props.arrowEdge, 'bottom');
    // Both slots exist as protocol children regardless of order; the host
    // routes by kind, not position.
    assert.equal(host.byKind('PopoverContent').length, 1, 'content child materialized eagerly');
    assert.equal(host.textOf(host.byKind('PopoverContent')[0]!.id), 'help text');
    assert.equal(host.byKind('Button').length, 1, 'anchor child present');

    transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
    await settle();
    host.drain();
    assert.equal(host.byKind('Popover')[0]!.props.value, true, 'opened');

    host.dismiss(popover.id);
    await settle();
    host.drain();
    assert.equal(host.byKind('Popover')[0]!.props.value, false, 'dismissal adopted');
  });
}
