import type {
  InboundMessage,
  Op,
  TreeNode,
  WindowProps,
} from '../protocol.js';
import type { Transport } from './transport.js';

export type EventHandler = (arg?: unknown) => void;

export interface EventTarget {
  id: number;
  kind: string;
  handlers: Record<string, EventHandler>;
  /** Last committed wire props (used for controlled-value enforcement). */
  props: Record<string, unknown>;
  created: boolean;
}

/** Wraps host-event handler invocation, e.g. to set React update priority. */
export type PriorityRunner = (kind: string, fn: () => void) => void;

/**
 * The Bridge owns the op buffer (flushed once per React commit), the registry
 * of live instances for event dispatch, and request/response plumbing for
 * debug tree dumps.
 */
export class Bridge {
  private ops: Op[] = [];
  private targets = new Map<number, EventTarget>();
  private lastSeq = new Map<number, number>();
  private dumpWaiters: Array<{ resolve: (root: TreeNode) => void; reject: (e: Error) => void }> = [];
  private shotWaiters: Array<{ resolve: (path: string) => void; reject: (e: Error) => void }> = [];
  private windowCloseCb: () => void = () => {};
  private priorityRunner: PriorityRunner = (_kind, fn) => fn();
  private dead = false;

  constructor(private transport: Transport) {
    transport.onMessage((msg) => this.handleMessage(msg));
  }

  // -- ops ------------------------------------------------------------------

  push(op: Op): void {
    this.ops.push(op);
  }

  flush(): void {
    if (this.ops.length === 0) return;
    const ops = this.ops;
    this.ops = [];
    try {
      this.transport.send({ t: 'commit', ops });
    } catch (err) {
      // A single unserializable prop (circular object, BigInt) must not
      // desync the whole tree: salvage the serializable ops.
      const good = ops.filter((op) => {
        try {
          JSON.stringify(op);
          return true;
        } catch {
          return false;
        }
      });
      console.error(`[natui] dropped ${ops.length - good.length} unserializable op(s):`, err);
      if (good.length > 0) this.transport.send({ t: 'commit', ops: good });
    }
  }

  // -- instances ------------------------------------------------------------

  register(target: EventTarget): void {
    this.targets.set(target.id, target);
  }

  unregister(id: number): void {
    this.targets.delete(id);
    this.lastSeq.delete(id);
  }

  /** Highest event seq processed for a node (echo suppression, see protocol). */
  latestSeqFor(id: number): number | undefined {
    return this.lastSeq.get(id);
  }

  // -- messages -------------------------------------------------------------

  sendWindow(props: WindowProps): void {
    this.transport.send({ t: 'window', props });
  }

  requestDump(): Promise<TreeNode> {
    if (this.dead) return Promise.reject(new Error('natui: host is gone'));
    return new Promise((resolve, reject) => {
      this.dumpWaiters.push({ resolve, reject });
      this.transport.send({ t: 'dump' });
    });
  }

  requestScreenshot(path: string): Promise<string> {
    if (this.dead) return Promise.reject(new Error('natui: host is gone'));
    return new Promise((resolve, reject) => {
      this.shotWaiters.push({ resolve, reject });
      this.transport.send({ t: 'screenshot', path });
    });
  }

  /** Reject all pending request/response waiters; called when the host dies. */
  dispose(reason: string): void {
    this.dead = true;
    const err = new Error(`natui: ${reason}`);
    for (const w of this.dumpWaiters.splice(0)) w.reject(err);
    for (const w of this.shotWaiters.splice(0)) w.reject(err);
  }

  /** Debug: ask the host to synthesize a user event. */
  emitDebugEvent(id: number, name: string, payload?: Record<string, unknown>): void {
    this.transport.send({
      t: 'emit',
      id,
      name,
      payload: payload as Record<string, never> | undefined,
    });
  }

  quit(): void {
    this.transport.send({ t: 'quit' });
  }

  onWindowClose(cb: () => void): void {
    this.windowCloseCb = cb;
  }

  setPriorityRunner(runner: PriorityRunner): void {
    this.priorityRunner = runner;
  }

  private handleMessage(msg: InboundMessage): void {
    switch (msg.t) {
      case 'event': {
        const target = this.targets.get(msg.id);
        // Only track seq for live nodes: a late event for a destroyed node
        // must not repopulate the map forever (ids are never reused).
        if (target && typeof msg.seq === 'number') this.lastSeq.set(msg.id, msg.seq);
        const payload = msg.payload ?? {};
        // Wire convention: payloads are `{}` or `{value}`; handlers take the
        // value directly (e.g. `onChange={(text) => ...}`).
        const arg = 'value' in payload ? payload.value : undefined;
        const handler = target?.handlers[msg.name];
        if (target && handler) {
          this.priorityRunner(target.kind, () => handler(arg));
        }
        // Controlled-value enforcement: the host applied this change
        // optimistically. If React did not adopt it (handler bailed out,
        // clamped to the previous value, or no handler at all), no update op
        // was produced, synthesize one so the host settles back to the
        // authoritative value. Discrete events were flushed synchronously by
        // the priority runner, so target.props is post-commit here. Sliders
        // (continuous, deferred flush) are exempt: last-write-wins is fine
        // mid-drag and React's eventual commit reconciles them.
        if (
          target &&
          target.created &&
          typeof msg.seq === 'number' &&
          'value' in payload &&
          target.kind !== 'Slider' &&
          this.lastSeq.get(msg.id) === msg.seq &&
          'value' in target.props &&
          JSON.stringify(target.props.value) !== JSON.stringify(payload.value)
        ) {
          this.push({
            op: 'update',
            id: msg.id,
            props: target.props as never,
            ack: msg.seq,
          });
          this.flush();
        }
        break;
      }
      case 'tree': {
        this.dumpWaiters.shift()?.resolve(msg.root);
        break;
      }
      case 'shot': {
        this.shotWaiters.shift()?.resolve(msg.path);
        break;
      }
      case 'window': {
        if (msg.name === 'close') this.windowCloseCb();
        break;
      }
      case 'ready':
        // Handled during startup by run(); ignore here.
        break;
    }
  }
}
