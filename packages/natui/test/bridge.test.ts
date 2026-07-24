/**
 * Bridge unit tests: atomic flush with created-flag rollback, screenshot
 * error/timeout handling, and the Suspense-hidden update guard.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Bridge } from '../src/bridge/bridge.js';
import { makeHostConfig } from '../src/reconciler/hostConfig.js';
import type { HostInstance, RootContainer } from '../src/reconciler/instances.js';
import { FakeTransport } from './helpers.js';

test('flush is all-or-nothing: an unserializable batch sends nothing and rolls back created flags', () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const errors = mock.method(console, 'error', () => {});
  try {
    // Validation makes this impossible for app data; poison an op directly to
    // exercise the invariant-breach path.
    const poisoned = {
      get bad(): never {
        throw new Error('boom');
      },
    };
    const ref = { id: 7, created: true };
    bridge.push({ op: 'create', id: 7, kind: 'Text', props: poisoned as never });
    bridge.push({ op: 'append', parent: 0, child: 7 });
    bridge.noteCreated(ref);
    bridge.flush();

    assert.equal(transport.sent.length, 0, 'nothing was sent, not even the valid append');
    assert.equal(ref.created, false, 'created flag rolled back');
    assert.ok(
      errors.mock.calls.some((c) => String(c.arguments[0]).includes('dropped the whole batch')),
      'invariant breach reported',
    );

    // The bridge stays usable: a later valid commit goes through.
    bridge.push({ op: 'create', id: 8, kind: 'Text', props: {} });
    bridge.flush();
    assert.equal(transport.sent.length, 1, 'subsequent valid batch sent');
  } finally {
    errors.mock.restore();
  }
});

test('screenshot reply with error rejects the pending promise', async () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const pending = bridge.requestScreenshot('/tmp/out.png');
  transport.emit({ t: 'shot', path: '/tmp/out.png', error: 'no window content view' });
  await assert.rejects(pending, /screenshot failed: no window content view/);
});

test('screenshot and dump time out instead of hanging when the host never replies', async () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport, { requestTimeoutMs: 40 });
  await assert.rejects(bridge.requestScreenshot('/tmp/out.png'), /did not reply to screenshot/);
  await assert.rejects(bridge.requestDump(), /did not reply to dump/);
});

test('a late reply for a timed-out request never resolves the next request', async () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport, { requestTimeoutMs: 40 });
  // First request times out; the host is slow, not dead.
  await assert.rejects(bridge.requestScreenshot('/tmp/a.png'), /did not reply/);
  const second = bridge.requestScreenshot('/tmp/b.png');
  // The host finally replies to BOTH requests, in order. The late first
  // reply must be discarded, not delivered to the second request.
  transport.emit({ t: 'shot', path: '/tmp/a.png' });
  transport.emit({ t: 'shot', path: '/tmp/b.png' });
  assert.equal(await second, '/tmp/b.png', 'second request got its own reply');
});

test('enforcement keeps a Suspense-hidden control hidden', () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  // A hidden controlled instance: instance.props stays un-hidden by design
  // (hostConfig re-adds hidden:true on the wire), so enforcement must too.
  const target = {
    id: 5,
    kind: 'TextField',
    handlers: {},
    props: { value: 'abc' },
    created: true,
    suspenseHidden: true,
  };
  bridge.register(target);
  // Optimistic edit with no handler: enforcement synthesizes a corrective.
  transport.emit({ t: 'event', id: 5, name: 'change', payload: { value: 'xyz' }, seq: 1 });
  const commit = transport.sent.at(-1) as { t: 'commit'; ops: Array<{ op: string; props?: Record<string, unknown>; ack?: number }> };
  assert.ok(commit && commit.t === 'commit', 'corrective update was flushed');
  const op = commit.ops.at(-1)!;
  assert.equal(op.props!.value, 'abc', 'corrective restores the committed value');
  assert.equal(op.props!.hidden, true, 'corrective re-asserts hidden:true');
  assert.equal(op.ack, 1, 'corrective carries the event seq as ack');
});

test('enforcement applies to change events only: sortChange with seq must not flush a corrective', () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  // A Table whose committed selection differs from the event payload value.
  const target = {
    id: 9,
    kind: 'Table',
    handlers: {},
    props: { value: null },
    created: true,
  };
  bridge.register(target);
  // Only change events may carry seq (docs/protocol.md); a host bug that
  // attaches one to a request-semantics event (sortChange) must not trick
  // the bridge into "correcting" the value prop with a sort descriptor.
  transport.emit({
    t: 'event',
    id: 9,
    name: 'sortChange',
    payload: { value: { key: 'qty', order: 'desc' } },
    seq: 1,
  });
  assert.equal(transport.sent.length, 0, 'no corrective commit for a non-change event');
});

test('enforcement corrects boolean values: a refused dismissal snaps back to presented', () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  // A presented Sheet with no change handler: host-side dismissal arrives as
  // an optimistic change {value:false}; the corrective must re-assert true.
  const target = {
    id: 4,
    kind: 'Sheet',
    handlers: {},
    props: { value: true },
    created: true,
  };
  bridge.register(target);
  transport.emit({ t: 'event', id: 4, name: 'change', payload: { value: false }, seq: 1 });
  const commit = transport.sent.at(-1) as {
    t: 'commit';
    ops: Array<{ op: string; props?: Record<string, unknown>; ack?: number }>;
  };
  assert.ok(commit && commit.t === 'commit', 'corrective update was flushed');
  const op = commit.ops.at(-1)!;
  assert.equal(op.props!.value, true, 'corrective re-presents the sheet');
  assert.equal(op.ack, 1, 'corrective carries the event seq as ack');
});

test('dispose rejects pending waiters and later requests fail fast', async () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const pending = bridge.requestDump();
  bridge.dispose('host exited (code 1)');
  await assert.rejects(pending, /host exited \(code 1\)/);
  await assert.rejects(bridge.requestScreenshot('/tmp/x.png'), /host is gone/);
});

test('ready arriving before waitForReady still resolves (no dropped handshake)', async () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  transport.emit({ t: 'ready', platform: 'macos', protocol: 1 });
  const ready = await bridge.waitForReady(50);
  assert.deepEqual(ready, { platform: 'macos', protocol: 1 });
});

// ---------------------------------------------------------------------------
// Suspense hide/unhide: updates while hidden must not reveal the instance.
// ---------------------------------------------------------------------------

test('updates to a Suspense-hidden instance stay hidden until unhide', () => {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const { hostConfig } = makeHostConfig(bridge);
  const container: RootContainer = { isRoot: true, children: [], nextId: 1, bridge };

  const instance = hostConfig.createInstance('Text', { color: '#111111' }, container, {}, null) as HostInstance;
  hostConfig.appendChildToContainer!(container, instance);
  bridge.flush();
  transport.sent.length = 0;

  hostConfig.hideInstance!(instance);
  bridge.flush();
  let commit = transport.sent.at(-1) as { t: 'commit'; ops: Array<{ op: string; props?: Record<string, unknown> }> };
  assert.equal(commit.ops.at(-1)!.props!.hidden, true, 'hide pushes hidden:true');

  hostConfig.commitUpdate!(instance, 'Text', { color: '#111111' }, { color: '#222222' }, null as never);
  bridge.flush();
  commit = transport.sent.at(-1) as typeof commit;
  const updateOp = commit.ops.at(-1)!;
  assert.equal(updateOp.props!.color, '#222222', 'update applied');
  assert.equal(updateOp.props!.hidden, true, 'update while hidden keeps hidden:true');

  hostConfig.unhideInstance!(instance, { color: '#222222' } as never);
  bridge.flush();
  commit = transport.sent.at(-1) as typeof commit;
  assert.ok(!('hidden' in commit.ops.at(-1)!.props!), 'unhide restores un-hidden props');
});
