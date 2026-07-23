/**
 * Shared test infrastructure: a FakeTransport capturing outbound messages,
 * and MiniHost, the in-memory REFERENCE implementation of the host-side op
 * semantics (same behavior the SwiftUI/WinUI hosts must implement), so the
 * contract tests validate the protocol itself.
 */
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge/bridge.js';
import type { Transport } from '../src/bridge/transport.js';
import type {
  AlertButtonSpec,
  MenuItemSpec,
  MenuSpec,
  SortDescriptor,
  TableColumnSpec,
  ToolbarItemSpec,
} from '../src/components.js';
import type { InboundMessage, Op, OutboundMessage, SerializedProps } from '../src/protocol.js';
import { createNatuiRenderer, type NatuiRenderer } from '../src/reconciler/renderer.js';

export class FakeTransport implements Transport {
  sent: OutboundMessage[] = [];
  private cb: (msg: InboundMessage) => void = () => {};
  send(msg: OutboundMessage): void {
    // Wire fidelity: real transports serialize every message, so no object
    // reference ever crosses to the host. Round-tripping here makes aliasing
    // bugs observable in tests (and throws on unserializable messages before
    // anything is "sent", exactly like the stdio transport).
    this.sent.push(JSON.parse(JSON.stringify(msg)) as OutboundMessage);
  }
  onMessage(cb: (msg: InboundMessage) => void): void {
    this.cb = cb;
  }
  onExit(): void {}
  close(): void {}
  emit(msg: InboundMessage): void {
    this.cb(msg);
  }
}

export interface MiniNode {
  id: number;
  kind: string;
  props: SerializedProps;
  text?: string;
  children: number[];
  /** Host-local optimistic edit counter (see protocol seq/ack). */
  lastSentSeq: number;
}

/** Reference implementation of the host-side op semantics. */
export class MiniHost {
  nodes = new Map<number, MiniNode>();
  parents = new Map<number, number>();

  constructor(private transport: FakeTransport) {
    this.nodes.set(0, { id: 0, kind: '#root', props: {}, children: [], lastSentSeq: 0 });
  }

  /** Simulate a user edit: optimistic local write + change event with seq. */
  userEdit(id: number, value: unknown): void {
    const node = this.nodes.get(id)!;
    node.props = { ...node.props, value: value as SerializedProps[string] };
    node.lastSentSeq += 1;
    this.transport.emit({
      t: 'event',
      id,
      name: 'change',
      payload: { value: value as never },
      seq: node.lastSentSeq,
    });
  }

  /** Apply the next queued message only; false when the queue is empty. */
  drainOne(): boolean {
    const msg = this.transport.sent.shift();
    if (!msg) return false;
    if (msg.t === 'commit') for (const op of msg.ops) this.apply(op);
    return true;
  }

  drain(): void {
    while (this.drainOne()) {
      // apply everything queued
    }
  }

  private detach(childId: number): void {
    const parentId = this.parents.get(childId);
    if (parentId === undefined) return;
    const parent = this.nodes.get(parentId)!;
    parent.children = parent.children.filter((id) => id !== childId);
    this.parents.delete(childId);
  }

  private destroy(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const child of node.children) this.destroy(child);
    this.nodes.delete(id);
    this.parents.delete(id);
  }

  private apply(op: Op): void {
    switch (op.op) {
      case 'create':
        assert.ok(!this.nodes.has(op.id), `create: id ${op.id} already exists`);
        this.nodes.set(op.id, { id: op.id, kind: op.kind, props: op.props, children: [], lastSentSeq: 0 });
        break;
      case 'createText':
        assert.ok(!this.nodes.has(op.id), `createText: id ${op.id} already exists`);
        this.nodes.set(op.id, {
          id: op.id,
          kind: '#text',
          props: {},
          text: op.text,
          children: [],
          lastSentSeq: 0,
        });
        break;
      case 'append': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `append: unknown parent ${op.parent}`);
        assert.ok(this.nodes.has(op.child), `append: unknown child ${op.child}`);
        this.detach(op.child);
        parent.children.push(op.child);
        this.parents.set(op.child, op.parent);
        break;
      }
      case 'insert': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `insert: unknown parent ${op.parent}`);
        assert.ok(this.nodes.has(op.child), `insert: unknown child ${op.child}`);
        this.detach(op.child);
        const idx = parent.children.indexOf(op.before);
        assert.notEqual(idx, -1, `insert: before ${op.before} not in parent ${op.parent}`);
        parent.children.splice(idx, 0, op.child);
        this.parents.set(op.child, op.parent);
        break;
      }
      case 'remove': {
        const parent = this.nodes.get(op.parent);
        assert.ok(parent, `remove: unknown parent ${op.parent}`);
        assert.equal(this.parents.get(op.child), op.parent, `remove: ${op.child} not child of ${op.parent}`);
        this.detach(op.child);
        this.destroy(op.child);
        break;
      }
      case 'update': {
        const node = this.nodes.get(op.id);
        assert.ok(node, `update: unknown node ${op.id}`);
        if (op.ack !== undefined && node.lastSentSeq > op.ack) {
          // User edited since JS produced this; keep the local value.
          node.props = { ...op.props, value: node.props.value! };
        } else {
          node.props = op.props;
        }
        break;
      }
      case 'text': {
        const node = this.nodes.get(op.id);
        assert.ok(node && node.kind === '#text', `text: node ${op.id} is not a text node`);
        node.text = op.text;
        break;
      }
      case 'clear': {
        const root = this.nodes.get(0)!;
        for (const child of [...root.children]) {
          this.detach(child);
          this.destroy(child);
        }
        break;
      }
    }
  }

  /** All nodes of a kind, in document order. */
  byKind(kind: string): MiniNode[] {
    const out: MiniNode[] = [];
    const walk = (id: number) => {
      const node = this.nodes.get(id)!;
      if (node.kind === kind) out.push(node);
      for (const c of node.children) walk(c);
    };
    walk(0);
    return out;
  }

  /** Concatenated #text content under a node. */
  textOf(id: number): string {
    const node = this.nodes.get(id)!;
    if (node.kind === '#text') return node.text ?? '';
    return node.children.map((c) => this.textOf(c)).join('');
  }

  // -- kitchen-sink reference semantics ---------------------------------------
  // These mirror what native hosts must do for the data-driven kinds: resolve
  // the JSON spec tree from props and emit the documented events. select /
  // action / search / sortChange never carry seq; only change does.

  /** Depth-first search of a MenuItemSpec tree for an action item by id. */
  findMenuItem(items: MenuItemSpec[], id: string): MenuItemSpec | undefined {
    for (const item of items) {
      if ('divider' in item) continue;
      if (item.id === id) return item;
      if (item.children) {
        const found = this.findMenuItem(item.children, id);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Simulate choosing a menu item on a MenuBar / Menu / ContextMenu node.
   * Returns false (no event) for unknown ids, dividers, disabled items,
   * submenu parents, and command-role items, exactly like real hosts.
   */
  menuSelect(id: number, itemId: string): boolean {
    const node = this.nodes.get(id)!;
    const items: MenuItemSpec[] =
      node.kind === 'MenuBar'
        ? (node.props.menus as unknown as MenuSpec[]).flatMap((m) => m.items)
        : (node.props.items as unknown as MenuItemSpec[]);
    const item = this.findMenuItem(items, itemId);
    if (!item || 'divider' in item) return false;
    if (item.disabled || item.children) return false;
    if (item.role && item.role !== 'destructive') return false; // native command
    this.transport.emit({ t: 'event', id, name: 'select', payload: { value: itemId } });
    return true;
  }

  /**
   * Simulate a toolbar interaction: a button/toggle click or a choice inside
   * a menu toolbar item. Returns false when nothing may fire.
   */
  toolbarAction(id: number, itemId: string): boolean {
    const node = this.nodes.get(id)!;
    const items = node.props.items as unknown as ToolbarItemSpec[];
    for (const item of items) {
      if (item.type === 'button' || item.type === 'toggle') {
        if (item.id !== itemId) continue;
        if (item.disabled) return false;
        this.transport.emit({ t: 'event', id, name: 'action', payload: { value: itemId } });
        return true;
      }
      if (item.type === 'menu') {
        if (item.disabled) continue;
        const found = this.findMenuItem(item.items, itemId);
        if (!found || 'divider' in found) continue;
        if (found.disabled || found.children) return false;
        this.transport.emit({ t: 'event', id, name: 'action', payload: { value: itemId } });
        return true;
      }
    }
    return false;
  }

  /** Toolbar search field input: fire-and-forget, never echoed into props. */
  toolbarSearch(id: number, value: string): void {
    this.transport.emit({ t: 'event', id, name: 'search', payload: { value } });
  }

  /**
   * Press an Alert button: asserts the alert is presented, then emits the
   * NORMATIVE event order: `select` (no seq) followed by the dismissal
   * change(false) as a real optimistic edit.
   */
  alertButtonPress(id: number, buttonId: string): void {
    const node = this.nodes.get(id)!;
    assert.equal(node.props.value, true, `alertButtonPress: alert ${id} is not presented`);
    const buttons = node.props.buttons as unknown as AlertButtonSpec[];
    assert.ok(
      buttons.some((b) => b.id === buttonId),
      `alertButtonPress: no button "${buttonId}"`,
    );
    this.transport.emit({ t: 'event', id, name: 'select', payload: { value: buttonId } });
    this.userEdit(id, false);
  }

  /** Host-side dismissal of a Sheet/Popover/Alert: optimistic change(false). */
  dismiss(id: number): void {
    this.userEdit(id, false);
  }

  /**
   * Click a Table column header. Emits sortChange (request semantics, no
   * seq, no optimistic state); returns false for unknown or non-sortable
   * columns. The host never sorts: JS reorders rows and echoes `sort`.
   */
  sortClick(id: number, key: string): boolean {
    const node = this.nodes.get(id)!;
    const columns = node.props.columns as unknown as TableColumnSpec[];
    const column = columns.find((c) => c.key === key);
    if (!column || column.sortable === false) return false;
    const sort = node.props.sort as unknown as SortDescriptor | undefined;
    const order: SortDescriptor['order'] =
      sort && sort.key === key && sort.order === 'asc' ? 'desc' : 'asc';
    this.transport.emit({
      t: 'event',
      id,
      name: 'sortChange',
      payload: { value: { key, order } },
    });
    return true;
  }
}

export const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 30));

export interface TestSetup {
  transport: FakeTransport;
  bridge: Bridge;
  host: MiniHost;
  renderer: NatuiRenderer;
}

export function setup(): TestSetup {
  const transport = new FakeTransport();
  const bridge = new Bridge(transport);
  const host = new MiniHost(transport);
  const renderer = createNatuiRenderer(bridge);
  return { transport, bridge, host, renderer };
}
