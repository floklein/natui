import { createContext, createElement, useContext, useEffect, useState } from "react";
import { Button, HStack, Text, TextField, VStack } from "@natui/core";
import { describe, expect, it } from "vitest";
import type { JsonValue, WireNode } from "./protocol.js";
import { createNativeRoot } from "./renderer.js";

function child(node: WireNode | null, index: number): WireNode {
  const value = node?.children[index];
  if (value === undefined) throw new Error(`Missing child at index ${index}`);
  return value;
}

describe("NatUI React renderer", () => {
  it("serializes a native tree after a React commit", () => {
    const snapshots: WireNode[] = [];
    const root = createNativeRoot((tree) => {
      if (tree !== null) snapshots.push(tree);
    });
    root.render(
      <VStack spacing={12}>
        <Text fontWeight="bold">Hello</Text>
        <Button onPress={() => undefined} title="Continue" />
      </VStack>,
    );

    const snapshot = snapshots.at(-1);
    expect(snapshot).toMatchObject({ props: { spacing: 12 }, type: "vstack" });
    expect(child(snapshot ?? null, 0)).toMatchObject({ props: { content: "Hello" }, type: "text" });
    expect(child(snapshot ?? null, 1).events.press).toMatch(/^n\d+:press$/);
  });

  it("roundtrips a native event into useState and a new commit", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <VStack>
          <Text>{count}</Text>
          <Button onPress={() => setCount((value) => value + 1)} title="Increment" />
        </VStack>
      );
    }

    const snapshots: WireNode[] = [];
    const root = createNativeRoot((tree) => {
      if (tree !== null) snapshots.push(tree);
    });
    root.render(<Counter />);
    const button = child(snapshots.at(-1) ?? null, 1);
    expect(root.dispatch(button.events.press ?? "missing")).toBe(true);

    expect(child(snapshots.at(-1) ?? null, 0).props.content).toBe("1");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves context and passive effect semantics", async () => {
    const Greeting = createContext("missing");
    function Effectful() {
      const greeting = useContext(Greeting);
      const [phase, setPhase] = useState("mounting");
      useEffect(() => setPhase("ready"), []);
      return <Text>{greeting}:{phase}</Text>;
    }

    let latest: WireNode | null = null;
    const root = createNativeRoot((tree) => {
      latest = tree;
    });
    root.render(
      <Greeting.Provider value="hello">
        <Effectful />
      </Greeting.Provider>,
    );

    await expect.poll(() => (latest as WireNode | null)?.props.content).toBe("hello:ready");
  });

  it("passes controlled text input payloads to React", () => {
    function Form() {
      const [value, setValue] = useState("first");
      return (
        <VStack>
          <TextField onChange={setValue} value={value} />
          <Text>{value}</Text>
        </VStack>
      );
    }

    const snapshots: WireNode[] = [];
    const root = createNativeRoot((tree) => {
      if (tree !== null) snapshots.push(tree);
    });
    root.render(<Form />);
    const field = child(snapshots.at(-1) ?? null, 0);
    root.dispatch(field.events.change ?? "missing", "edited");
    expect(child(snapshots.at(-1) ?? null, 0).props.value).toBe("edited");
    expect(child(snapshots.at(-1) ?? null, 1).props.content).toBe("edited");
  });

  it("preserves keyed host identities when children reorder", () => {
    function List() {
      const [items, setItems] = useState(["b", "c"]);
      return (
        <VStack>
          <Button onPress={() => setItems((current) => ["a", ...current])} title="Prepend" />
          <HStack>
            {items.map((item) => (
              <Text key={item}>{item}</Text>
            ))}
          </HStack>
        </VStack>
      );
    }

    const snapshots: WireNode[] = [];
    const root = createNativeRoot((tree) => {
      if (tree !== null) snapshots.push(tree);
    });
    root.render(<List />);
    const before = child(snapshots.at(-1) ?? null, 1).children;
    const identity = new Map(before.map((node) => [node.props.content, node.id]));
    root.dispatch(child(snapshots.at(-1) ?? null, 0).events.press ?? "missing");
    const after = child(snapshots.at(-1) ?? null, 1).children;

    expect(after.map((node) => node.props.content)).toEqual(["a", "b", "c"]);
    expect(after[1]?.id).toBe(identity.get("b"));
    expect(after[2]?.id).toBe(identity.get("c"));
  });

  it("drops stale handlers after a commit", () => {
    let oldHandler = "";
    function Swap() {
      const [visible, setVisible] = useState(true);
      return visible ? (
        <Button onPress={() => setVisible(false)} title="Remove" />
      ) : (
        <Text>Gone</Text>
      );
    }
    let latest: WireNode | null = null;
    const root = createNativeRoot((tree) => {
      latest = tree;
    });
    root.render(<Swap />);
    oldHandler = (latest as WireNode | null)?.events.press ?? "missing";
    expect(root.dispatch(oldHandler)).toBe(true);
    expect((latest as WireNode | null)?.type).toBe("text");
    expect(root.dispatch(oldHandler)).toBe(false);
  });

  it("keeps a stable event token through rapid sequential commits", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <VStack>
          <Button onPress={() => setCount((value) => value + 1)} title="Increment" />
          <Text>{count}</Text>
        </VStack>
      );
    }
    let latest: WireNode | null = null;
    const root = createNativeRoot((tree) => {
      latest = tree;
    });
    root.render(<Counter />);
    const handler = child(latest, 0).events.press ?? "missing";
    for (let index = 0; index < 100; index += 1) {
      expect(root.dispatch(handler)).toBe(true);
    }
    expect(child(latest, 0).events.press).toBe(handler);
    expect(child(latest, 1).props.content).toBe("100");
  });

  it("serializes nested data and rejects cycles", () => {
    let latest: WireNode | null = null;
    const root = createNativeRoot((tree) => {
      latest = tree;
    });
    const metadata: Record<string, JsonValue> = { flags: [true, null], nested: { answer: 42 } };
    root.render(createElement("native", { name: "Map", props: metadata }));
    expect((latest as WireNode | null)?.props.props).toEqual(metadata);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => root.render(createElement("native", { name: "Bad", props: cyclic }))).toThrow(
      /contains a cycle/,
    );
  });
});
