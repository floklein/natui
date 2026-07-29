/**
 * Suspense hide/unhide driven by real React, against the reference host.
 *
 * The only previous coverage called hostConfig.hideInstance/unhideInstance by
 * hand, so it could not catch an ordering problem between React's visibility
 * pass and commitUpdate, and it asserted op shape rather than host state.
 * hideTextInstance/unhideTextInstance had no coverage at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Suspense, use } from 'react';
import { Text, VStack } from '../src/components.js';
import { makeHostConfig } from '../src/reconciler/hostConfig.js';
import type { HostInstance, HostTextInstance } from '../src/reconciler/instances.js';
import { settle, setup } from './helpers.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('a suspending boundary commits its fallback to the host', async () => {
  const { host, renderer } = setup();
  const gate = deferred<string>();

  function Pending() {
    return <Text>{use(gate.promise)}</Text>;
  }

  renderer.render(
    <VStack>
      <Text color="#111111">visible</Text>
      <Suspense fallback={<Text>loading</Text>}>
        <Pending />
      </Suspense>
    </VStack>,
  );
  await settle();
  host.drain();

  const stack = host.byKind('VStack')[0];
  assert.ok(stack, 'the stack mounted while the boundary was still pending');
  assert.match(host.textOf(stack.id), /loading/, 'the fallback reached the host');
  assert.match(host.textOf(stack.id), /visible/, 'the non-suspending sibling mounted too');
});

/**
 * Hiding is driven against a tree React actually built and committed (real
 * ids, registered handlers, real text children), then asserted on host state
 * rather than op shape — the previous coverage hand-built a container literal
 * and checked the ops it produced.
 *
 * The visibility hooks are invoked directly because React only calls them for
 * a boundary that re-suspends after committing, and `use()` does not retry
 * inside this in-memory harness. Driving them is exactly what React does; what
 * is under test is NatUI's response.
 */
test('hiding a committed subtree keeps props, blanks text, and restores both', async () => {
  const { bridge, host, renderer } = setup();
  const { hostConfig } = makeHostConfig(bridge);

  renderer.render(
    <VStack>
      <Text accessibilityIdentifier="stable" color="#111111">
        stable
      </Text>
    </VStack>,
  );
  await settle();
  host.drain();

  const stack = renderer.container.children[0] as HostInstance;
  const text = stack.children[0] as HostInstance;
  const textChild = text.children[0] as HostTextInstance;
  assert.equal(text.kind, 'Text', 'found the committed Text instance');
  assert.equal(textChild.kind, '#text', 'found its committed text child');
  assert.equal(host.textOf(text.id), 'stable', 'text starts populated on the host');
  assert.notEqual(host.nodes.get(text.id)?.props.hidden, true, 'starts visible');

  hostConfig.hideInstance!(text);
  hostConfig.hideTextInstance!(textChild);
  bridge.flush();
  host.drain();

  const hidden = host.nodes.get(text.id);
  assert.ok(hidden, 'the instance was hidden, not destroyed');
  assert.equal(hidden.props.hidden, true, 'hideInstance set hidden:true');
  assert.equal(hidden.props.color, '#111111', 'real props survived the hide');
  assert.equal(host.textOf(text.id), '', 'hideTextInstance blanked the text');

  // An update while hidden must not reveal the control.
  hostConfig.commitUpdate!(text, 'Text', {}, { color: '#222222' }, null as never);
  bridge.flush();
  host.drain();
  assert.equal(host.nodes.get(text.id)?.props.hidden, true, 'still hidden after an update');
  assert.equal(host.nodes.get(text.id)?.props.color, '#222222', 'the update still applied');

  hostConfig.unhideInstance!(text, {} as never);
  hostConfig.unhideTextInstance!(textChild, 'stable');
  bridge.flush();
  host.drain();

  const restored = host.nodes.get(text.id);
  assert.ok(restored, 'it is still the same host node');
  assert.notEqual(restored.props.hidden, true, 'unhideInstance cleared the hidden flag');
  assert.equal(restored.props.color, '#222222', 'unhide restored the latest real props');
  assert.equal(host.textOf(text.id), 'stable', 'unhideTextInstance restored the text');
});
