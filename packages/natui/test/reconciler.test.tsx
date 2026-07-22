/**
 * End-to-end reconciler tests against the in-memory reference host.
 * The MiniHost (test/helpers.ts) applies ops exactly as a native host must,
 * so this validates the protocol contract itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Op } from '../src/protocol.js';
import {
  Button,
  HStack,
  Picker,
  ScrollView,
  Slider,
  Text,
  TextField,
  Toggle,
  VStack,
  ZStack,
} from '../src/components.js';
import { settle, setup } from './helpers.js';

// ---------------------------------------------------------------------------

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <VStack spacing={8}>
      <Text font="title">{String(count)}</Text>
      <Button onPress={() => setCount((c) => c + 1)}>increment</Button>
      {count > 0 && <Button onPress={() => setCount(0)}>reset</Button>}
    </VStack>
  );
}

test('mount, press, conditional insert, unmount', async () => {
  const { transport, host, renderer } = setup();
  renderer.render(<Counter />);
  await settle();
  host.drain();

  const stacks = host.byKind('VStack');
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0]!.props.spacing, 8);
  const texts = host.byKind('Text');
  assert.equal(texts.length, 1);
  assert.equal(host.textOf(texts[0]!.id), '0');
  assert.equal(host.byKind('Button').length, 1, 'reset button hidden at count=0');

  // Press increment.
  const button = host.byKind('Button')[0]!;
  transport.emit({ t: 'event', id: button.id, name: 'press', payload: {} });
  await settle();
  host.drain();

  assert.equal(host.textOf(host.byKind('Text')[0]!.id), '1');
  assert.equal(host.byKind('Button').length, 2, 'reset button appears at count=1');

  // Press reset (second button in document order).
  const reset = host.byKind('Button')[1]!;
  transport.emit({ t: 'event', id: reset.id, name: 'press', payload: {} });
  await settle();
  host.drain();

  assert.equal(host.textOf(host.byKind('Text')[0]!.id), '0');
  assert.equal(host.byKind('Button').length, 1, 'reset button removed again');

  renderer.unmount();
  await settle();
  host.drain();
  assert.equal(host.byKind('VStack').length, 0, 'tree removed on unmount');
});

// ---------------------------------------------------------------------------

function Todos() {
  const [todos, setTodos] = useState([
    { id: 'a', label: 'alpha', done: false },
    { id: 'b', label: 'beta', done: false },
    { id: 'c', label: 'gamma', done: false },
  ]);
  return (
    <VStack>
      {todos.map((t) => (
        <HStack key={t.id}>
          <Toggle value={t.done} onChange={(done) => setTodos((p) => p.map((x) => (x.id === t.id ? { ...x, done } : x)))}>
            {t.label}
          </Toggle>
          <Button onPress={() => setTodos((p) => p.filter((x) => x.id !== t.id))}>x</Button>
        </HStack>
      ))}
      <Button onPress={() => setTodos((p) => [p[p.length - 1]!, ...p.slice(0, -1)])}>rotate</Button>
    </VStack>
  );
}

test('keyed list: toggle, remove middle, reorder', async () => {
  const { transport, host, renderer } = setup();
  renderer.render(<Todos />);
  await settle();
  host.drain();

  assert.equal(host.byKind('HStack').length, 3);
  const labels = () => host.byKind('Toggle').map((t) => host.textOf(t.id));
  assert.deepEqual(labels(), ['alpha', 'beta', 'gamma']);

  // Toggle beta on.
  const beta = host.byKind('Toggle')[1]!;
  transport.emit({ t: 'event', id: beta.id, name: 'change', payload: { value: true } });
  await settle();
  host.drain();
  assert.equal(host.byKind('Toggle')[1]!.props.value, true);
  assert.equal(host.byKind('Toggle')[0]!.props.value, false);

  // Remove beta via its row button.
  const betaRemove = host.byKind('Button')[1]!;
  transport.emit({ t: 'event', id: betaRemove.id, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.deepEqual(labels(), ['alpha', 'gamma']);

  // Rotate: gamma moves to front (reorder via insertBefore, not recreate).
  const idsBefore = host.byKind('Toggle').map((t) => t.id);
  const rotate = host.byKind('Button').at(-1)!;
  transport.emit({ t: 'event', id: rotate.id, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.deepEqual(labels(), ['gamma', 'alpha']);
  const idsAfter = host.byKind('Toggle').map((t) => t.id);
  assert.deepEqual(new Set(idsAfter), new Set(idsBefore), 'keyed rows were moved, not recreated');
});

// ---------------------------------------------------------------------------

function Form() {
  const [text, setText] = useState('');
  return (
    <VStack>
      <TextField value={text} onChange={(v) => setText(v.toUpperCase())} />
      <Text>{text}</Text>
    </VStack>
  );
}

test('controlled TextField round-trip transforms value', async () => {
  const { host, renderer } = setup();
  renderer.render(<Form />);
  await settle();
  host.drain();

  const field = host.byKind('TextField')[0]!;
  assert.equal(field.props.value, '');

  host.userEdit(field.id, 'hello');
  await settle();
  host.drain();

  // Controlled component is authoritative: JS transformed the value, and the
  // update carried ack == seq, so the transform wins over the optimistic echo.
  assert.equal(host.byKind('TextField')[0]!.props.value, 'HELLO');
  assert.equal(host.textOf(host.byKind('Text')[0]!.id), 'HELLO');
});

// ---------------------------------------------------------------------------

function PlainForm() {
  const [text, setText] = useState('');
  return <TextField value={text} onChange={setText} />;
}

test('stale echo does not revert fast typing (seq/ack)', async () => {
  const { host, renderer } = setup();
  renderer.render(<PlainForm />);
  await settle();
  host.drain();

  const field = host.byKind('TextField')[0]!;

  // Two keystrokes before any echo lands: the host is at seq=2, value 'ab',
  // and JS has queued two echoes (value 'a' ack=1, value 'ab' ack=2).
  host.userEdit(field.id, 'a');
  host.userEdit(field.id, 'ab');

  // Apply ONLY the first echo. Without suppression this step visibly reverts
  // the field to 'a' (deleting the suppression logic makes this fail).
  assert.ok(host.drainOne(), 'first echo was queued');
  assert.equal(
    host.byKind('TextField')[0]!.props.value,
    'ab',
    'stale echo (ack=1 < lastSentSeq=2) must not revert the newer local value',
  );

  // The second echo (ack=2) is authoritative and matches.
  host.drain();
  await settle();
  host.drain();
  assert.equal(host.byKind('TextField')[0]!.props.value, 'ab');
});

// ---------------------------------------------------------------------------

function MaxLenForm() {
  const [text, setText] = useState('abcde');
  return <TextField value={text} onChange={(v) => setText(v.slice(0, 5))} />;
}

test('controlled-value enforcement corrects rejected edits', async () => {
  const { host, renderer } = setup();
  renderer.render(<MaxLenForm />);
  await settle();
  host.drain();

  const field = host.byKind('TextField')[0]!;
  // 6th char: handler clamps to previous state, React bails out, no commit.
  // The bridge must synthesize a corrective update (with ack) anyway.
  host.userEdit(field.id, 'abcdef');
  await settle();
  host.drain();
  assert.equal(host.byKind('TextField')[0]!.props.value, 'abcde', 'clamped value enforced');
});

function StubbornToggle() {
  return <Toggle value={false} onChange={() => {}} />;
}

test('controlled-value enforcement flips a refused Toggle back', async () => {
  const { host, renderer } = setup();
  renderer.render(<StubbornToggle />);
  await settle();
  host.drain();

  const toggle = host.byKind('Toggle')[0]!;
  host.userEdit(toggle.id, true);
  await settle();
  host.drain();
  assert.equal(host.byKind('Toggle')[0]!.props.value, false, 'no-op handler keeps value false');
});

test('controlled-value enforcement snaps a refused Picker back', async () => {
  const { host, renderer } = setup();
  renderer.render(
    <Picker
      value="a"
      options={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]}
      onChange={() => {}}
    />,
  );
  await settle();
  host.drain();

  const picker = host.byKind('Picker')[0]!;
  host.userEdit(picker.id, 'b');
  await settle();
  host.drain();
  assert.equal(host.byKind('Picker')[0]!.props.value, 'a', 'no-op handler keeps selection a');
});

// ---------------------------------------------------------------------------

function Kitchen() {
  const [pick, setPick] = useState('a');
  const [level, setLevel] = useState(0.5);
  return (
    <ScrollView>
      <ZStack>
        <Picker
          value={pick}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
          onChange={setPick}
        />
        <Slider value={level} min={0} max={1} onChange={setLevel} />
      </ZStack>
    </ScrollView>
  );
}

test('ScrollView/ZStack/Picker/Slider mount, change, and clear on unmount', async () => {
  const { host, renderer } = setup();
  renderer.render(<Kitchen />);
  await settle();
  host.drain();

  assert.equal(host.byKind('ScrollView').length, 1);
  assert.equal(host.byKind('ZStack').length, 1);
  const picker = host.byKind('Picker')[0]!;
  assert.deepEqual(picker.props.options, [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ]);

  host.userEdit(picker.id, 'b');
  await settle();
  host.drain();
  assert.equal(host.byKind('Picker')[0]!.props.value, 'b', 'picker change round-trips');

  // Slider changes are continuous: accepted values flow back with ack.
  const slider = host.byKind('Slider')[0]!;
  host.userEdit(slider.id, 0.9);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 0.9, 'slider change round-trips');

  renderer.unmount();
  await settle();
  host.drain();
  assert.equal(host.nodes.size, 1, 'only the root remains after unmount');
});

// ---------------------------------------------------------------------------
// Controlled Slider: every path a handler can take (accept, reject, clamp,
// missing) must leave the host at React's authoritative value, without
// breaking responsiveness during rapid sequential changes.
// ---------------------------------------------------------------------------

function AcceptingSlider() {
  const [v, setV] = useState(10);
  return <Slider value={v} min={0} max={100} onChange={setV} />;
}

test('controlled Slider: accepted change round-trips', async () => {
  const { host, renderer } = setup();
  renderer.render(<AcceptingSlider />);
  await settle();
  host.drain();

  host.userEdit(host.byKind('Slider')[0]!.id, 60);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 60);
});

test('controlled Slider: rejected change snaps back', async () => {
  const { host, renderer } = setup();
  renderer.render(<Slider value={25} min={0} max={100} onChange={() => {}} />);
  await settle();
  host.drain();

  host.userEdit(host.byKind('Slider')[0]!.id, 90);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 25, 'no-op handler keeps 25');
});

function ClampingSlider() {
  const [v, setV] = useState(10);
  return <Slider value={v} min={0} max={100} onChange={(x) => setV(Math.min(x, 50))} />;
}

test('controlled Slider: clamped change settles on the clamp', async () => {
  const { host, renderer } = setup();
  renderer.render(<ClampingSlider />);
  await settle();
  host.drain();

  host.userEdit(host.byKind('Slider')[0]!.id, 80);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 50, '80 clamped to 50');
});

test('controlled Slider: missing handler snaps back', async () => {
  const { host, renderer } = setup();
  renderer.render(<Slider value={25} min={0} max={100} />);
  await settle();
  host.drain();

  host.userEdit(host.byKind('Slider')[0]!.id, 90);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 25, 'no handler keeps 25');
});

test('controlled Slider: rapid sequential changes stay responsive and converge', async () => {
  const { host, renderer } = setup();
  renderer.render(<ClampingSlider />);
  await settle();
  host.drain();
  const slider = host.byKind('Slider')[0]!;

  // Accepted rapid drag: a stale echo (ack=1) landing after the user reached
  // seq=2 must not yank the thumb backwards. Apply only the first echo so
  // the suppression itself is observable, not just the final convergence.
  host.userEdit(slider.id, 20);
  host.userEdit(slider.id, 40);
  assert.ok(host.drainOne(), 'first echo was queued');
  assert.equal(
    host.byKind('Slider')[0]!.props.value,
    40,
    'stale echo suppressed mid-drag (lastSentSeq > ack)',
  );
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 40, 'authoritative echo matches');

  // Drag past the clamp: enforcement converges on the clamped value once the
  // drag settles.
  host.userEdit(slider.id, 80);
  host.userEdit(slider.id, 95);
  await settle();
  host.drain();
  assert.equal(host.byKind('Slider')[0]!.props.value, 50, 'converged to clamp after drag');
});

// ---------------------------------------------------------------------------
// Hooks beyond useState: context propagation, effects, and effect cleanup.
// ---------------------------------------------------------------------------

const LabelContext = createContext('none');
const effectLog: string[] = [];

function EffectChild() {
  const label = useContext(LabelContext);
  useEffect(() => {
    effectLog.push(`mounted:${label}`);
    return () => {
      effectLog.push(`cleanup:${label}`);
    };
  }, [label]);
  return <Text>{label}</Text>;
}

function EffectApp() {
  const [label, setLabel] = useState('first');
  return (
    <LabelContext.Provider value={label}>
      <VStack>
        <EffectChild />
        <Button onPress={() => setLabel('second')}>relabel</Button>
      </VStack>
    </LabelContext.Provider>
  );
}

test('useContext propagates and useEffect runs with cleanup', async () => {
  effectLog.length = 0;
  const { transport, host, renderer } = setup();
  renderer.render(<EffectApp />);
  await settle();
  host.drain();

  assert.equal(host.textOf(host.byKind('Text')[0]!.id), 'first', 'context value rendered');
  assert.deepEqual(effectLog, ['mounted:first'], 'mount effect ran');

  transport.emit({ t: 'event', id: host.byKind('Button')[0]!.id, name: 'press', payload: {} });
  await settle();
  host.drain();

  assert.equal(host.textOf(host.byKind('Text')[0]!.id), 'second', 'context update re-rendered');
  assert.deepEqual(
    effectLog,
    ['mounted:first', 'cleanup:first', 'mounted:second'],
    'effect cleanup ran before re-run',
  );

  renderer.unmount();
  await settle();
  assert.deepEqual(
    effectLog,
    ['mounted:first', 'cleanup:first', 'mounted:second', 'cleanup:second'],
    'unmount runs final cleanup',
  );
});

// ---------------------------------------------------------------------------

test('ops arrive as atomic commit batches with creates before appends', async () => {
  const { transport, renderer } = setup();
  renderer.render(
    <VStack>
      <Text>one</Text>
      <Text>two</Text>
    </VStack>,
  );
  await settle();

  const commits = transport.sent.filter((m) => m.t === 'commit');
  assert.equal(commits.length, 1, 'initial mount is a single commit');
  const ops = (commits[0] as { t: 'commit'; ops: Op[] }).ops;
  const seen = new Set<number>([0]);
  for (const op of ops) {
    if (op.op === 'create' || op.op === 'createText') seen.add(op.id);
    if (op.op === 'append') {
      assert.ok(seen.has(op.parent), 'append parent created first');
      assert.ok(seen.has(op.child), 'append child created first');
    }
  }
});
