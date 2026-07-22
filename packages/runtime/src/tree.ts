import type { JsonValue, WireNode } from "./protocol.js";

export type NativeProps = Readonly<Record<string, unknown>>;

export interface HostElement {
  children: HostChild[];
  hidden: boolean;
  id: string;
  kind: "element";
  props: NativeProps;
  type: string;
}

export interface HostText {
  hidden: boolean;
  id: string;
  kind: "text";
  text: string;
}

export type HostChild = HostElement | HostText;
export type EventHandler = (payload?: JsonValue) => void;

export interface RootContainer {
  children: HostChild[];
  handlers: Map<string, EventHandler>;
  nextId: number;
  onCommit: (root: WireNode | null, revision: number) => void;
  revision: number;
}

const EVENT_NAMES: Readonly<Record<string, string>> = {
  onChange: "change",
  onPress: "press",
  onSubmit: "submit",
};

export function createRootContainer(
  onCommit: (root: WireNode | null, revision: number) => void,
): RootContainer {
  return {
    children: [],
    handlers: new Map(),
    nextId: 1,
    onCommit,
    revision: 0,
  };
}

export function allocateId(container: RootContainer, prefix: "n" | "t" = "n"): string {
  const id = `${prefix}${container.nextId}`;
  container.nextId += 1;
  return id;
}

export function appendChild(parent: { children: HostChild[] }, child: HostChild): void {
  const existing = parent.children.indexOf(child);
  if (existing >= 0) parent.children.splice(existing, 1);
  parent.children.push(child);
}

export function insertChildBefore(
  parent: { children: HostChild[] },
  child: HostChild,
  before: HostChild,
): void {
  const existing = parent.children.indexOf(child);
  if (existing >= 0) parent.children.splice(existing, 1);
  const index = parent.children.indexOf(before);
  if (index < 0) throw new Error(`NatUI could not find sibling ${before.id}`);
  parent.children.splice(index, 0, child);
}

export function removeChild(parent: { children: HostChild[] }, child: HostChild): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
}

function jsonValue(value: unknown, path: string, seen: Set<object>): JsonValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error(`NatUI prop ${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const array: JsonValue[] = [];
      value.forEach((item, index) => {
        const serialized = jsonValue(item, `${path}[${index}]`, seen);
        if (serialized !== undefined) array.push(serialized);
      });
      return array;
    }
    if (value instanceof Date) return value.toISOString();
    const object: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const serialized = jsonValue(child, `${path}.${key}`, seen);
      if (serialized !== undefined) object[key] = serialized;
    }
    return object;
  } finally {
    seen.delete(value);
  }
}

function textContent(children: HostChild[]): string {
  let content = "";
  for (const child of children) {
    if (child.kind === "text") content += child.text;
    else if (child.type === "text") content += textContent(child.children);
  }
  return content;
}

function serializeChild(
  child: HostChild,
  handlers: Map<string, EventHandler>,
): WireNode | null {
  if (child.hidden) return null;
  if (child.kind === "text") {
    return {
      children: [],
      events: {},
      id: child.id,
      props: { content: child.text },
      type: "rawText",
    };
  }

  const props: Record<string, JsonValue> = {};
  const events: Record<string, string> = {};
  for (const [name, value] of Object.entries(child.props)) {
    if (name === "children" || value === undefined) continue;
    if (typeof value === "function") {
      const eventName = EVENT_NAMES[name];
      if (eventName !== undefined) {
        const handlerId = `${child.id}:${eventName}`;
        events[eventName] = handlerId;
        handlers.set(handlerId, value as EventHandler);
      }
      continue;
    }
    const serialized = jsonValue(value, `${child.type}.${name}`, new Set());
    if (serialized !== undefined) props[name] = serialized;
  }

  const onlyText = child.type === "text";
  if (onlyText && props.content === undefined) props.content = textContent(child.children);
  if (child.type === "button" && props.title === undefined) props.title = textContent(child.children);
  if (child.type === "toggle" && props.label === undefined) props.label = textContent(child.children);

  const children: WireNode[] = [];
  if (!onlyText) {
    for (const item of child.children) {
      const serialized = serializeChild(item, handlers);
      if (serialized !== null) children.push(serialized);
    }
  }
  return { children, events, id: child.id, props, type: child.type };
}

export function commitSnapshot(container: RootContainer): void {
  const handlers = new Map<string, EventHandler>();
  const children: WireNode[] = [];
  for (const child of container.children) {
    const serialized = serializeChild(child, handlers);
    if (serialized !== null) children.push(serialized);
  }
  container.handlers = handlers;
  container.revision += 1;
  let root: WireNode | null = null;
  if (children.length === 1) root = children[0] ?? null;
  else if (children.length > 1) {
    root = { children, events: {}, id: "__root__", props: {}, type: "vstack" };
  }
  container.onCommit(root, container.revision);
}
