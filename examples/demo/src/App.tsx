import { useRef, useState } from 'react';
// '@natui/core/components' is engine-neutral (no Node built-ins), so this file
// works both under Node (main.tsx) and inside embedded JSC (main-embedded).
import {
  Button,
  Divider,
  HStack,
  Image,
  List,
  ProgressView,
  Slider,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
} from '@natui/core/components';

interface Todo {
  id: number;
  label: string;
  done: boolean;
}

export function App() {
  const nextTodoId = useRef(4);
  const [count, setCount] = useState(0);
  const [draft, setDraft] = useState('');
  const [volume, setVolume] = useState(40);
  const [todos, setTodos] = useState<Todo[]>([
    { id: 1, label: 'Write a React reconciler', done: true },
    { id: 2, label: 'Render real SwiftUI from it', done: true },
    { id: 3, label: 'Port the host to WinUI 3', done: false },
  ]);

  const remaining = todos.filter((t) => !t.done).length;

  const addTodo = () => {
    const label = draft.trim();
    if (!label) return;
    setTodos((prev) => [...prev, { id: nextTodoId.current++, label, done: false }]);
    setDraft('');
  };

  const toggleTodo = (id: number, done: boolean) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done } : t)));

  const removeTodo = (id: number) => setTodos((prev) => prev.filter((t) => t.id !== id));

  return (
    <VStack spacing={14} padding={20} alignment="leading">
      <HStack spacing={8} alignment="center">
        <Image systemName="atom" size={28} color="#e94f37" />
        <Text font="largeTitle" weight="bold">
          NatUI
        </Text>
        <Spacer />
        <Text font="caption" color="#888888">
          React → SwiftUI / WinUI
        </Text>
      </HStack>

      <Text font="callout" color="#666666">
        This window is real native UI rendered by a custom React reconciler.
      </Text>

      <Divider />

      <HStack spacing={10} alignment="center">
        <Button variant="bordered" onPress={() => setCount((c) => c - 1)}>
          −
        </Button>
        <Text font="title2" monospaced>
          {String(count)}
        </Text>
        <Button variant="bordered" onPress={() => setCount((c) => c + 1)}>
          +
        </Button>
        {count !== 0 && (
          <Button variant="plain" onPress={() => setCount(0)}>
            Reset
          </Button>
        )}
        <Spacer />
        {count >= 10 && <Text color="#e94f37">That's a lot of clicks</Text>}
      </HStack>

      <Divider />

      <HStack spacing={8} alignment="center">
        <TextField
          value={draft}
          placeholder="What needs doing?"
          onChange={setDraft}
          onSubmit={addTodo}
          frame={{ maxWidth: 'infinity' }}
        />
        <Button variant="prominent" onPress={addTodo} disabled={draft.trim() === ''}>
          Add
        </Button>
      </HStack>

      <List frame={{ maxHeight: 220, maxWidth: 'infinity' }} cornerRadius={8}>
        {todos.map((todo) => (
          <HStack key={todo.id} spacing={8} alignment="center">
            <Toggle value={todo.done} onChange={(done) => toggleTodo(todo.id, done)}>
              {todo.label}
            </Toggle>
            <Spacer />
            <Button variant="plain" role="destructive" onPress={() => removeTodo(todo.id)}>
              <Image systemName="trash" size={13} />
            </Button>
          </HStack>
        ))}
      </List>

      <Text font="caption" color="#888888">
        {remaining === 0 ? 'All done 🎉' : `${remaining} left to do`}
      </Text>

      <Divider />

      <HStack spacing={10} alignment="center">
        <Image systemName="speaker.wave.2" size={16} color="#666666" />
        <Slider value={volume} min={0} max={100} onChange={setVolume} />
        <Text font="caption" monospaced frame={{ width: 34 }}>
          {String(Math.round(volume))}
        </Text>
      </HStack>
      <ProgressView value={volume / 100} />
    </VStack>
  );
}
