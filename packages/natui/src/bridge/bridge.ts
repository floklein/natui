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
  /** True while React keeps the instance mounted but hidden (Suspense). */
  suspenseHidden?: boolean;
}

/** Anything with a `created` flag the Bridge may roll back on a failed flush. */
export interface CreatedRef {
  id: number;
  created: boolean;
}

export interface ReadyInfo {
  platform: string;
  protocol: number;
  hostApi: number;
}

/** Wraps host-event handler invocation, e.g. to set React update priority. */
export type PriorityRunner = (kind: string, fn: () => void) => void;

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Already rejected by timeout; stays in the FIFO as a tombstone. */
  settled: boolean;
}

/** Debug requests (dump/screenshot) fail loudly instead of hanging forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface BridgeOptions {
  /** Dump/screenshot reply timeout override (mainly for tests). */
  requestTimeoutMs?: number;
}

/**
 * The Bridge owns the op buffer (flushed once per React commit), the registry
 * of live instances for event dispatch, the startup handshake, and
 * request/response plumbing for debug tree dumps and screenshots.
 */
export class Bridge {
  private ops: Op[] = [];
  private createdThisFlush: CreatedRef[] = [];
  private targets = new Map<number, EventTarget>();
  private lastSeq = new Map<number, number>();
  private dumpWaiters: Array<Waiter<TreeNode>> = [];
  private shotWaiters: Array<Waiter<string>> = [];
  private readyInfo: ReadyInfo | null = null;
  private readyWaiter: Waiter<ReadyInfo> | null = null;
  private readyPromise: Promise<ReadyInfo> | null = null;
  private windowCloseCb: (() => void) | undefined;
  private pendingWindowClose = false;
  private priorityRunner: PriorityRunner = (_kind, fn) => fn();
  private dead = false;
  private requestTimeoutMs: number;

  constructor(
    private transport: Transport,
    options: BridgeOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    transport.onMessage((msg) => this.handleMessage(msg));
  }

  // -- startup ---------------------------------------------------------------

  /**
   * Resolves with the host's `ready` handshake (which may already have
   * arrived; the Bridge buffers it). The caller validates its contents.
   */
  waitForReady(timeoutMs: number): Promise<ReadyInfo> {
    if (this.readyInfo) return Promise.resolve(this.readyInfo);
    if (this.dead) return Promise.reject(new Error('natui: host is gone'));
    // Concurrent callers share one waiter (the first call's timeout applies).
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      // Deliberately ref'd: the caller is awaiting this promise, and an
      // unref'd timer would let the event loop drain with the promise
      // forever pending. dispose()/the reply clears it, so it holds the
      // process open for at most timeoutMs.
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new Error(`natui: host did not send ready within ${timeoutMs}ms`));
      }, timeoutMs);
      this.readyWaiter = { resolve, reject, timer, settled: false };
    });
    return this.readyPromise;
  }

  /** Called by run() when the host process exits. */
  hostExited(code: number | null): void {
    this.dispose(`host exited (code ${code})`);
  }

  // -- ops ------------------------------------------------------------------

  push(op: Op): void {
    this.ops.push(op);
  }

  /** Record an instance whose create op is part of the current batch. */
  noteCreated(ref: CreatedRef): void {
    this.createdThisFlush.push(ref);
  }

  flush(): void {
    if (this.ops.length === 0) return;
    const ops = this.ops;
    this.ops = [];
    const createdRefs = this.createdThisFlush;
    this.createdThisFlush = [];
    const msg = { t: 'commit', ops } as const;
    // Prop validation (instances.ts) deep-copies every prop into documented
    // JSON, so serialization cannot throw for app data; this guards NatUI
    // bugs. Transports serialize the whole message before writing a single
    // byte, so a throw here means nothing reached the host: a commit is
    // all-or-nothing, and the created flags are rolled back to match.
    try {
      this.transport.send(msg);
    } catch (err) {
      for (const ref of createdRefs) {
        ref.created = false;
        this.unregister(ref.id);
      }
      console.error(
        '[natui] internal error: commit batch is not serializable; dropped the whole batch ' +
          '(the native tree keeps its previous state):',
        err,
      );
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

  private addWaiter<T>(list: Array<Waiter<T>>, what: string): Promise<T> {
    if (this.dead) return Promise.reject(new Error('natui: host is gone'));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          // Reject, but keep the waiter in the FIFO as a tombstone: replies
          // pair with requests by order, so the host's (late) reply to THIS
          // request must consume this slot. Removing it would hand the late
          // reply to the next pending request, silently returning a stale
          // tree or the wrong screenshot path.
          waiter.settled = true;
          reject(
            new Error(`natui: host did not reply to ${what} within ${this.requestTimeoutMs}ms`),
          );
        }, this.requestTimeoutMs),
      };
      // Deliberately ref'd (same as waitForReady): the caller awaits this
      // promise, so the timer must be able to fire even when nothing else
      // holds the event loop; settle/dispose clears it.
      list.push(waiter);
    });
  }

  /** Consume the oldest waiter; discard the reply if it already timed out. */
  private settleWaiter<T>(list: Array<Waiter<T>>, deliver: (w: Waiter<T>) => void): void {
    const waiter = list.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.settled) return; // late reply for a timed-out request
    waiter.settled = true;
    deliver(waiter);
  }

  requestDump(): Promise<TreeNode> {
    const promise = this.addWaiter(this.dumpWaiters, 'dump');
    if (!this.dead) this.transport.send({ t: 'dump' });
    return promise;
  }

  requestScreenshot(path: string): Promise<string> {
    const promise = this.addWaiter(this.shotWaiters, 'screenshot');
    if (!this.dead) this.transport.send({ t: 'screenshot', path });
    return promise;
  }

  /** Reject all pending request/response waiters; called when the host dies. */
  dispose(reason: string): void {
    this.dead = true;
    const err = new Error(`natui: ${reason}`);
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter.reject(err);
      this.readyWaiter = null;
    }
    for (const w of this.dumpWaiters.splice(0)) {
      clearTimeout(w.timer);
      if (!w.settled) w.reject(err);
    }
    for (const w of this.shotWaiters.splice(0)) {
      clearTimeout(w.timer);
      if (!w.settled) w.reject(err);
    }
  }

  /** Debug: ask the host to synthesize a user event (no optimistic state). */
  emitDebugEvent(id: number, name: string, payload?: Record<string, unknown>): void {
    this.transport.send({
      t: 'emit',
      id,
      name,
      payload: payload as Record<string, never> | undefined,
    });
  }

  /** Debug: ask the host to perform a real optimistic user edit (seq/ack path). */
  editDebugValue(id: number, value: unknown): void {
    this.transport.send({ t: 'edit', id, value: value as never });
  }

  quit(): void {
    this.transport.send({ t: 'quit' });
  }

  onWindowClose(cb: () => void): void {
    this.windowCloseCb = cb;
    if (this.pendingWindowClose) {
      this.pendingWindowClose = false;
      cb();
    }
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
        // authoritative value. Change events are flushed synchronously by the
        // priority runner, so target.props is post-commit here. The carried
        // ack makes this safe during rapid edits: the host ignores it while
        // the user is still ahead (lastSentSeq > ack) and applies it once the
        // interaction settles.
        // Enforcement is defined over `change` events only: `seq` never rides
        // any other event (docs/protocol.md), and a request-semantics event
        // (e.g. sortChange) carrying a value must never be "corrected" into
        // the node's value prop.
        if (
          target &&
          target.created &&
          msg.name === 'change' &&
          typeof msg.seq === 'number' &&
          'value' in payload &&
          this.lastSeq.get(msg.id) === msg.seq &&
          'value' in target.props &&
          JSON.stringify(target.props.value) !== JSON.stringify(payload.value)
        ) {
          // Same Suspense guard as hostConfig.commitUpdate: updates replace
          // props wholesale, so a corrective update to a hidden instance must
          // re-assert hidden:true or it would unhide the control.
          const props = target.suspenseHidden
            ? { ...target.props, hidden: true }
            : target.props;
          this.push({
            op: 'update',
            id: msg.id,
            props: props as never,
            ack: msg.seq,
          });
          this.flush();
        }
        break;
      }
      case 'tree': {
        this.settleWaiter(this.dumpWaiters, (w) => w.resolve(msg.root));
        break;
      }
      case 'shot': {
        this.settleWaiter(this.shotWaiters, (w) => {
          if (msg.error) w.reject(new Error(`natui: screenshot failed: ${msg.error}`));
          else w.resolve(msg.path);
        });
        break;
      }
      case 'window': {
        if (msg.name === 'close') {
          if (this.windowCloseCb) this.windowCloseCb();
          else this.pendingWindowClose = true;
        }
        break;
      }
      case 'ready': {
        this.readyInfo = {
          platform: msg.platform,
          protocol: msg.protocol,
          hostApi: msg.hostApi,
        };
        if (this.readyWaiter) {
          clearTimeout(this.readyWaiter.timer);
          this.readyWaiter.resolve(this.readyInfo);
          this.readyWaiter = null;
        }
        break;
      }
      default:
        // Unknown message types are ignored (forward compatibility).
        break;
    }
  }
}
