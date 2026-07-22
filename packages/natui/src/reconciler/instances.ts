import type { PropValue, SerializedProps } from '../protocol.js';
import type { Bridge, EventHandler } from '../bridge/bridge.js';

/**
 * Shadow tree kept on the JS side. React builds/mutates this tree through the
 * host config; nodes are "materialized" on the native host (create ops) only
 * once they are attached to the visible tree, because render-phase instances
 * may be discarded before ever being committed.
 */

export interface HostInstance {
  id: number;
  kind: string;
  props: SerializedProps;
  handlers: Record<string, EventHandler>;
  children: Child[];
  /** True once the native host has been told to create this node. */
  created: boolean;
}

export interface HostTextInstance {
  id: number;
  kind: '#text';
  text: string;
  created: boolean;
}

export type Child = HostInstance | HostTextInstance;

export interface RootContainer {
  isRoot: true;
  children: Child[];
  nextId: number;
  bridge: Bridge;
}

export function isTextInstance(node: Child): node is HostTextInstance {
  return node.kind === '#text';
}

// ---------------------------------------------------------------------------
// Prop serialization
// ---------------------------------------------------------------------------

const SKIPPED_PROPS = new Set(['children', 'key', 'ref']);

/** `onPress` -> `press`, `onSubmitEditing` -> `submitEditing`. */
function eventNameFor(propName: string): string | null {
  if (propName.length > 2 && propName.startsWith('on') && propName[2] === propName[2]!.toUpperCase()) {
    return propName[2]!.toLowerCase() + propName.slice(3);
  }
  return null;
}

export interface SerializedNode {
  props: SerializedProps;
  handlers: Record<string, EventHandler>;
}

/** Split raw React props into wire-safe props and local event handlers. */
export function serializeProps(raw: Record<string, unknown>): SerializedNode {
  const props: SerializedProps = {};
  const handlers: Record<string, EventHandler> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || SKIPPED_PROPS.has(name)) continue;
    if (typeof value === 'function') {
      const eventName = eventNameFor(name);
      if (eventName) handlers[eventName] = value as EventHandler;
      continue;
    }
    props[name] = value as PropValue;
  }
  return { props, handlers };
}

export function propsEqual(a: SerializedProps, b: SerializedProps): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Materialization (shadow tree -> create/append ops)
// ---------------------------------------------------------------------------

/** Emit create ops for a node and its whole subtree, depth-first. */
export function materialize(node: Child, bridge: Bridge): void {
  if (node.created) return;
  if (isTextInstance(node)) {
    bridge.push({ op: 'createText', id: node.id, text: node.text });
  } else {
    bridge.push({ op: 'create', id: node.id, kind: node.kind, props: node.props });
    bridge.register(node);
    for (const child of node.children) {
      materialize(child, bridge);
      bridge.push({ op: 'append', parent: node.id, child: child.id });
    }
  }
  node.created = true;
}

/** Mark a subtree as destroyed on the host side and drop event registrations. */
export function markDestroyed(node: Child, bridge: Bridge): void {
  node.created = false;
  if (!isTextInstance(node)) {
    bridge.unregister(node.id);
    for (const child of node.children) markDestroyed(child, bridge);
  }
}

// ---------------------------------------------------------------------------
// Shadow children bookkeeping
// ---------------------------------------------------------------------------

export function shadowAppend(list: Child[], child: Child): void {
  const idx = list.indexOf(child);
  if (idx !== -1) list.splice(idx, 1);
  list.push(child);
}

export function shadowInsertBefore(list: Child[], child: Child, before: Child): void {
  const existing = list.indexOf(child);
  if (existing !== -1) list.splice(existing, 1);
  const idx = list.indexOf(before);
  if (idx === -1) list.push(child);
  else list.splice(idx, 0, child);
}

export function shadowRemove(list: Child[], child: Child): void {
  const idx = list.indexOf(child);
  if (idx !== -1) list.splice(idx, 1);
}
