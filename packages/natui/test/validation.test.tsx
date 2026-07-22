/**
 * Prop validation: only documented JSON values may cross the wire. Invalid
 * values are reported with node kind and prop path and omitted; a commit is
 * never partially sent; a subsequent valid render recovers cleanly.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Text, VStack } from '../src/components.js';
import { settle, setup } from './helpers.js';

function withConsoleErrorCapture(): { messages: () => string[]; restore: () => void } {
  const captured: string[] = [];
  const mocked = mock.method(console, 'error', (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  });
  return {
    messages: () => captured,
    restore: () => mocked.mock.restore(),
  };
}

test('circular object prop is reported with kind and path, omitted, and the node still mounts', async () => {
  const capture = withConsoleErrorCapture();
  try {
    const { host, renderer } = setup();
    const cyclic: Record<string, unknown> = { a: { b: 1 } };
    (cyclic.a as Record<string, unknown>).back = cyclic;
    renderer.render(<Text {...({ meta: cyclic } as object)}>hello</Text>);
    await settle();
    host.drain();

    const text = host.byKind('Text')[0]!;
    assert.equal(host.textOf(text.id), 'hello', 'node mounted despite invalid prop');
    assert.deepEqual(
      text.props.meta,
      { a: { b: 1 } },
      'cycle stripped at the offending entry, valid remainder kept',
    );
    assert.ok(
      capture.messages().some((m) => m.includes('Text.meta.a.back') && m.includes('circular')),
      `reported kind+path, got: ${capture.messages().join(' | ')}`,
    );
  } finally {
    capture.restore();
  }
});

test('BigInt and non-finite numbers are reported and omitted, valid siblings kept', async () => {
  const capture = withConsoleErrorCapture();
  try {
    const { host, renderer } = setup();
    renderer.render(
      <VStack
        {...({
          big: 10n,
          nan: Number.NaN,
          inf: Infinity,
          nested: { fine: 1, bad: -Infinity },
          list: [1, Number.NaN, 3],
        } as object)}
      >
        <Text>ok</Text>
      </VStack>,
    );
    await settle();
    host.drain();

    const stack = host.byKind('VStack')[0]!;
    assert.ok(!('big' in stack.props), 'BigInt omitted');
    assert.ok(!('nan' in stack.props), 'NaN omitted');
    assert.ok(!('inf' in stack.props), 'Infinity omitted');
    assert.deepEqual(stack.props.nested, { fine: 1 }, 'invalid nested entry omitted, valid kept');
    assert.deepEqual(stack.props.list, [1, 3], 'invalid array item omitted, valid kept');
    const msgs = capture.messages();
    assert.ok(msgs.some((m) => m.includes('VStack.big') && m.includes('BigInt')));
    assert.ok(msgs.some((m) => m.includes('VStack.nested.bad') && m.includes('non-finite')));
    assert.ok(msgs.some((m) => m.includes('VStack.list[1]') && m.includes('non-finite')));
  } finally {
    capture.restore();
  }
});

test('class instances and nested functions are rejected; plain JSON passes through', async () => {
  const capture = withConsoleErrorCapture();
  try {
    const { host, renderer } = setup();
    renderer.render(
      <Text
        {...({
          when: new Date(0),
          actions: { cb: () => {} },
          plain: { list: [{ a: 1 }], flag: true, none: null },
        } as object)}
      >
        x
      </Text>,
    );
    await settle();
    host.drain();

    const text = host.byKind('Text')[0]!;
    assert.ok(!('when' in text.props), 'Date omitted');
    assert.deepEqual(text.props.actions, {}, 'nested function omitted from object');
    assert.deepEqual(text.props.plain, { list: [{ a: 1 }], flag: true, none: null });
    const msgs = capture.messages();
    assert.ok(msgs.some((m) => m.includes('Text.when') && m.includes('Date')));
    assert.ok(msgs.some((m) => m.includes('Text.actions.cb') && m.includes('function')));
  } finally {
    capture.restore();
  }
});

test('recovery: a subsequent valid render updates the previously offending prop', async () => {
  const capture = withConsoleErrorCapture();
  try {
    const { host, renderer } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    renderer.render(<Text {...({ meta: cyclic } as object)}>v1</Text>);
    await settle();
    host.drain();
    assert.deepEqual(host.byKind('Text')[0]!.props.meta, {}, 'cyclic entry stripped');

    renderer.render(<Text {...({ meta: { ok: true } } as object)}>v2</Text>);
    await settle();
    host.drain();

    const text = host.byKind('Text')[0]!;
    assert.deepEqual(text.props.meta, { ok: true }, 'valid render replaces the omitted prop');
    assert.equal(host.textOf(text.id), 'v2');
  } finally {
    capture.restore();
  }
});

test('validated props are deep copies: later app-side mutation cannot leak into commits', async () => {
  const { host, renderer, transport } = setup();
  const shared = { level: 1 };
  function App({ tick }: { tick: number }) {
    return <Text {...({ meta: shared, tick } as object)}>x</Text>;
  }
  renderer.render(<App tick={1} />);
  await settle();
  host.drain();
  assert.deepEqual(host.byKind('Text')[0]!.props.meta, { level: 1 });

  // Mutating the object the app already passed must not corrupt anything
  // retroactively; the next render picks up the new content as a new copy.
  shared.level = 2;
  renderer.render(<App tick={2} />);
  await settle();
  host.drain();
  assert.deepEqual(host.byKind('Text')[0]!.props.meta, { level: 2 });
  assert.equal(transport.sent.length, 0, 'all commits drained');
});
