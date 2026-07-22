/**
 * End-to-end reconciler test against an in-memory reference host.
 * The MiniHost applies ops exactly as a native host must (same semantics as
 * the SwiftUI/WinUI hosts), so this validates the protocol contract itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { useState } from 'react';
import { Bridge } from '../src/bridge/bridge.js';
import type { Transport } from '../src/bridge/transport.js';
import type { InboundMessage, Op, OutboundMessage, SerializedProps } from '../src/protocol.js';
import { createNatuiRenderer } from '../src/reconciler/renderer.js';
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

class FakeTransport implements Transport {
  sent: OutboundMessage[] = [];
  private cb: (msg: InboundMessage) => void = () => {};
  send(msg: OutboundMessage): void {
    this.sent.push(msg);
  }
  onMessage(cb: (msg: InboundMessage) => void): void {
    this.cb = cb;
  }
  onExit(): void {}
  close(): void {}
  emit(msg: InboundMessage): void {
    this.cb(msg);
  }
}

interface MiniNode {
  id: number;
  kind: string;
  props: SerializedProps;
  text?: string;
  children: number[];
  /** Host-local optimistic edit counter (see protocol seq/ack). */
  lastSentSeq: number;
}

/** Reference implementation of the host-side op semantics. */
class MiniHost {
  nodes = new Map<number, MiniNode>();
  parents = new Map<number, number>();

  constructor(private transport: FakeTransport) {
    this.nodes.set(0, { id: 0, kind: '#root', props: {}, children: [], lastSentSeq: 0 });
  }

  /** Simulate a user edit: optimistic local write + change event with seq. */
  userEdit(id: number, value: unknown): void {
    const node = this.nodes.get(id)!;
    node.props = { ...node.props, value: value as SerializedProps[string] };
    node.lastSentSeq += 1;
    this.transport.emit({
      t: 'event',
      id,
      name: 'change',
      payload: { value: value as never },
      seq: node.lastSentSeq,
    });
  }

  drain(): void {
    for (const msg of this.transport.sent.splice(0)) {
      if (msg.t === 'commit') for (const op of msg.ops) this.apply(op);
    }
  }

  private detach(childId: number): void {
    const parentId = this.parents.get(childId);
    if (parentId === undefined) return;
    const parent = this.nodes.get(parentId)!;
    parent.children = parent.children.filter((id) => id !== childId);
    this.parents.delete(childId);
  }

  private destroy(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const child of node.children) this.destroy(child);
    this.nodes.delete(id);
    this.parents.delete(id);
  }

  private apply(op: Op): void {
    switch (op.op) {
      case 'create':
        assert.ok(!this.nodes.has(op.id), `create: id ${op.id} already exists`);
        this.nodes.set(op.id, { id: op.id, kind: op.kind, props: op.props, children: [], lastSentSeq: 0 });
        break;
      case 'createText':
        assert.ok(!this.nodes.has(op.id), `createText: id ${op.id} already exists`);
        this.nodes.set(op.id, {
          id: op.id,
          kind: '#text',
          props: {},
          text: op.text,
          children: [],
          lastSentSeq: 0,
        });
        break;
      case 'append': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `append: unknown parent ${op.parent}`);
        assert.ok(this.nodes.has(op.child), `append: unknown child ${op.child}`);
        this.detach(op.child);
        parent.children.push(op.child);
        this.parents.set(op.child, op.parent);
        break;
      }
      case 'insert': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `insert: unknown parent ${op.parent}`);
        assert.ok(this.nodes.has(op.child), `insert: unknown child ${op.child}`);
        this.detach(op.child);
        const idx = parent.children.indexOf(op.before);
        assert.notEqual(idx, -1, `insert: before ${op.before} not in parent ${op.parent}`);
        parent.children.splice(idx, 0, op.child);
        this.parents.set(op.child, op.parent);
        break;
      }
      case 'remove': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `remove: unknown parent ${op.parent}`);
        assert.equal(this.parents.get(op.child), op.parent, `remove: ${op.child} not child of ${op.parent}`);
        this.detach(op.child);
        this.destroy(op.child);
        break;
      }
      case 'update': {
        const node = this.nodes.get(op.id);
        assert.ok(node, `update: unknown node ${op.id}`);
        if (op.ack !== undefined && node.lastSentSeq > op.ack) {
          // User edited since JS produced this; keep the local value.
          node.props = { ...op.props, value: node.props.value! };
        } else {
          node.props = op.props;
        }
        break;
      }
      case 'text': {
        const node = this.nodes.get(op.id);
        assert.ok(node && node.kind === '#text', `text: node ${op.id} is not a text node`);
        node.text = op.text;
        break;
      }
      case 'clear': {
        const root = this.nodes.get(0)!;
        for (const child of [...root.children]) {
          this.detach(child);
          this.destroy(child);
        }
        break;
      }
    }
  }

  /** All nodes of a kind, in document order. */
  byKind(kind: string): MiniNode[] {
    const out: MiniNode[] = [];
    const walk = (id: number) => {
      const node = this.nodes.get(id)!;
      if (node.kind === kind) out.push(node);
      for (const c of node.children) walk(c);
    };
    walk(0);
    return out;
  }

  /** Concatenated #text content under a node. */
  textOf(id: number): string {
    const node = this.nodes.get(id)!;
    if (node.kind === '#text') return node.text ?? '';
    return node.children.map((c) => this.textOf(c)).join('');
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const host = new MiniHost(transport);
  const renderer = createNatuiRenderer(bridge);
  return { transport, host, renderer };
}

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

  // First keystroke reaches JS...
  host.userEdit(field.id, 'a');
  await settle();
  // ...but before its echo is applied host-side, the user types again.
  host.userEdit(field.id, 'ab');
  // Now the stale echo (value 'a', ack=1) arrives while lastSentSeq=2.
  host.drain();
  assert.equal(
    host.byKind('TextField')[0]!.props.value,
    'ab',
    'stale echo must not revert the newer local value',
  );

  // The second echo (ack=2) is authoritative and matches.
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
