import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { useState } from 'react';
import { Button, Text, VStack } from '../src/components.js';
import { settle, setup } from './helpers.js';

interface RefreshRuntime {
  injectIntoGlobalHook(target: object): void;
  register(type: unknown, id: string): void;
  setSignature(type: unknown, key: string): void;
  performReactRefresh(): unknown;
}

const require = createRequire(import.meta.url);
const refresh = require('react-refresh/runtime') as RefreshRuntime;
refresh.injectIntoGlobalHook(globalThis);

test('Fast Refresh updates a component while preserving React and native state', async () => {
  const family = 'natui/test/refresh-counter';
  const signature = 'useState{[count, setCount]}(0)';

  function CounterV1() {
    const [count, setCount] = useState(0);
    return (
      <VStack>
        <Text>{`old:${count}`}</Text>
        <Button onPress={() => setCount((value) => value + 1)}>increment</Button>
      </VStack>
    );
  }

  refresh.setSignature(CounterV1, signature);
  refresh.register(CounterV1, family);

  const { transport, host, renderer } = setup();
  renderer.render(<CounterV1 />);
  await settle();
  host.drain();

  const button = host.byKind('Button')[0]!;
  transport.emit({ t: 'event', id: button.id, name: 'press', payload: {} });
  await settle();
  host.drain();

  const textId = host.byKind('Text')[0]!.id;
  const buttonId = host.byKind('Button')[0]!.id;
  assert.equal(host.textOf(textId), 'old:1');

  function CounterV2() {
    const [count, setCount] = useState(0);
    return (
      <VStack>
        <Text>{`new:${count}`}</Text>
        <Button onPress={() => setCount((value) => value + 2)}>increment faster</Button>
      </VStack>
    );
  }

  refresh.setSignature(CounterV2, signature);
  refresh.register(CounterV2, family);
  assert.ok(refresh.performReactRefresh(), 'refresh runtime scheduled an update');
  await settle();
  host.drain();

  assert.equal(host.byKind('Text')[0]!.id, textId, 'native text instance was preserved');
  assert.equal(host.byKind('Button')[0]!.id, buttonId, 'native button instance was preserved');
  assert.equal(host.textOf(textId), 'new:1', 'new component code retained hook state');

  transport.emit({ t: 'event', id: buttonId, name: 'press', payload: {} });
  await settle();
  host.drain();
  assert.equal(host.textOf(textId), 'new:3', 'the refreshed event handler replaced the old closure');

  renderer.unmount();
});
