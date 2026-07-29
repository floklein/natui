import { useState } from 'react';
import {
  Button,
  HStack,
  Spacer,
  Text,
  VStack,
} from '@natui/core/components';

export function App() {
  const [count, setCount] = useState(0);

  return (
    <VStack spacing={16} padding={24} alignment="leading">
      <Text font="largeTitle" weight="bold">
        Welcome to NatUI
      </Text>
      <Text>
        This React tree is rendered with native platform controls.
      </Text>
      <HStack spacing={12} alignment="center">
        <Button style="bordered" onPress={() => setCount((value) => value - 1)}>
          Decrement
        </Button>
        <Text font="title2" monospaced>
          {String(count)}
        </Text>
        <Button style="prominent" onPress={() => setCount((value) => value + 1)}>
          Increment
        </Button>
        <Spacer />
      </HStack>
    </VStack>
  );
}
