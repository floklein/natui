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
  /** True while React keeps this instance mounted but hidden (Suspense). */
  suspenseHidden?: boolean;
}

export interface HostTextInstance {
  id: number;
  kind: '#text';
  text: string;
  created: boolean;
  /** True while React keeps this instance mounted but hidden (Suspense). */
  suspenseHidden?: boolean;
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
// Prop validation and serialization
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

function reportInvalid(kind: string, path: string, reason: string): void {
  console.error(`[natui] invalid prop ${kind}.${path}: ${reason}; prop omitted`);
}

/**
 * Validate one prop value against the documented wire format (string, finite
 * number, boolean, null, arrays and plain objects of the same) and return a
 * DEEP COPY, so a later mutation or exotic object can never make a commit
 * batch unserializable. Returns undefined for values that cannot cross the
 * wire; the offense is reported with its node kind and prop path and the
 * prop (or array item / object entry) is omitted.
 */
function normalizeValue(
  value: unknown,
  kind: string,
  path: string,
  seen: Set<object>,
): PropValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      reportInvalid(kind, path, `non-finite number (${String(value)})`);
      return undefined;
    case 'undefined':
      return undefined; // JSON semantics: omitted silently.
    case 'bigint':
      reportInvalid(kind, path, 'BigInt is not a supported prop value');
      return undefined;
    case 'function':
      reportInvalid(kind, path, 'functions are only supported as top-level on* handler props');
      return undefined;
    case 'symbol':
      reportInvalid(kind, path, 'symbols are not supported prop values');
      return undefined;
    case 'object': {
      const obj = value as object;
      if (seen.has(obj)) {
        reportInvalid(kind, path, 'circular reference');
        return undefined;
      }
      seen.add(obj);
      try {
        if (Array.isArray(obj)) {
          const out: PropValue[] = [];
          for (let i = 0; i < obj.length; i++) {
            const item = normalizeValue(obj[i], kind, `${path}[${i}]`, seen);
            if (item !== undefined) out.push(item);
          }
          return out;
        }
        const proto: unknown = Object.getPrototypeOf(obj);
        if (proto !== Object.prototype && proto !== null) {
          const name = (obj.constructor as { name?: string } | undefined)?.name ?? 'object';
          reportInvalid(kind, path, `unsupported object type (${name}); only plain JSON is allowed`);
          return undefined;
        }
        const out: Record<string, PropValue> = {};
        for (const [key, child] of Object.entries(obj)) {
          // Assigning out['__proto__'] would set the copy's prototype instead
          // of creating an entry (silent drop + data-controlled prototype).
          if (key === '__proto__') {
            reportInvalid(kind, `${path}.${key}`, 'unsupported prop key');
            continue;
          }
          const normalized = normalizeValue(child, kind, `${path}.${key}`, seen);
          if (normalized !== undefined) out[key] = normalized;
        }
        return out;
      } finally {
        seen.delete(obj);
      }
    }
    default:
      reportInvalid(kind, path, `unsupported value of type ${typeof value}`);
      return undefined;
  }
}

/** Split raw React props into validated wire-safe props and event handlers. */
export function serializeProps(raw: Record<string, unknown>, kind: string): SerializedNode {
  const props: SerializedProps = {};
  const handlers: Record<string, EventHandler> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || SKIPPED_PROPS.has(name)) continue;
    if (name === '__proto__') {
      reportInvalid(kind, name, 'unsupported prop key');
      continue;
    }
    if (typeof value === 'function') {
      const eventName = eventNameFor(name);
      if (eventName) handlers[eventName] = value as EventHandler;
      else reportInvalid(kind, name, 'function prop without an on* event name');
      continue;
    }
    const normalized = normalizeValue(value, kind, name, new Set());
    if (normalized !== undefined) props[name] = normalized;
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
  // If the whole batch fails to send, the Bridge flips `created` back so the
  // host and the shadow tree never disagree about which nodes exist.
  bridge.noteCreated(node);
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
  // `before` is always a current sibling (React guarantees it); the append
  // fallback matches the hosts' defensive behavior for a malformed insert.
  if (idx === -1) list.push(child);
  else list.splice(idx, 0, child);
}

export function shadowRemove(list: Child[], child: Child): void {
  const idx = list.indexOf(child);
  if (idx !== -1) list.splice(idx, 1);
}
