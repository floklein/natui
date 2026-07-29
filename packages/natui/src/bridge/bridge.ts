import type {
  InboundMessage,
  Op,
  RequestId,
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
export type PriorityRunner = (fn: () => void) => void;

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  /**
   * Node ids that got an `update` op while the current host event was being
   * dispatched. Cleared per event, so it never grows: it exists only to tell
   * "React adopted the change" from "React never responded".
   */
  private updatedDuringDispatch = new Set<number>();
  /**
   * Outstanding dump/screenshot requests, keyed by the id echoed on the reply.
   * A timed-out request simply removes its entry: a late reply then finds no
   * waiter and is dropped, instead of being handed to the next pending caller.
   */
  private pendingRequests = new Map<RequestId, Waiter<never>>();
  private nextRequestId = 1;
  private readyInfo: ReadyInfo | null = null;
  private readyWaiter: Waiter<ReadyInfo> | null = null;
  private readyPromise: Promise<ReadyInfo> | null = null;
  private windowCloseCb: (() => void) | undefined;
  private pendingWindowClose = false;
  private priorityRunner: PriorityRunner = (fn) => fn();
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
      this.readyWaiter = { resolve, reject, timer };
    });
    return this.readyPromise;
  }

  /** Called by run() when the host process exits. */
  hostExited(code: number | null): void {
    this.dispose(`host exited (code ${code})`);
  }

  // -- ops ------------------------------------------------------------------

  push(op: Op): void {
    if (op.op === 'update') this.updatedDuringDispatch.add(op.id);
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
      // The rollback only restores the shadow tree's agreement with the host
      // about which nodes exist. It does NOT re-create them: React will not
      // call appendChild again for an already-mounted fiber, so the dropped
      // subtree stays missing on the host until something remounts it.
      console.error(
        '[natui] internal error: commit batch is not serializable; dropped the whole batch. ' +
          'The nodes in it were never created on the host and will not be retried, ' +
          'so the native tree is now missing that subtree:',
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

  /**
   * Register a waiter and hand back its request id. `send` runs only after the
   * entry exists, so a synchronous transport cannot reply before it is there.
   */
  private request<T>(
    what: string,
    send: (rid: RequestId) => void,
  ): Promise<T> {
    if (this.dead) return Promise.reject(new Error('natui: host is gone'));
    const rid = this.nextRequestId++;
    const promise = new Promise<T>((resolve, reject) => {
      // Deliberately ref'd (same as waitForReady): the caller awaits this
      // promise, so the timer must be able to fire even when nothing else
      // holds the event loop; the reply or dispose() clears it.
      const timer = setTimeout(() => {
        this.pendingRequests.delete(rid);
        reject(
          new Error(`natui: host did not reply to ${what} within ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      this.pendingRequests.set(rid, {
        resolve,
        reject,
        timer,
      } as unknown as Waiter<never>);
    });
    send(rid);
    return promise;
  }

  /** Deliver a reply to the request that asked for it, if it is still waiting. */
  private settleRequest<T>(
    rid: RequestId | undefined,
    deliver: (w: Waiter<T>) => void,
  ): void {
    if (typeof rid !== 'number') return;
    const waiter = this.pendingRequests.get(rid) as Waiter<T> | undefined;
    if (!waiter) return; // late reply for a request that already timed out
    this.pendingRequests.delete(rid);
    clearTimeout(waiter.timer);
    deliver(waiter);
  }

  requestDump(): Promise<TreeNode> {
    return this.request<TreeNode>('dump', (rid) => {
      if (!this.dead) this.transport.send({ t: 'dump', rid });
    });
  }

  requestScreenshot(path: string): Promise<string> {
    return this.request<string>('screenshot', (rid) => {
      if (!this.dead) this.transport.send({ t: 'screenshot', path, rid });
    });
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
    for (const waiter of this.pendingRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pendingRequests.clear();
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
        this.updatedDuringDispatch.clear();
        if (target && handler) {
          this.priorityRunner(() => handler(arg));
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
        // If React already committed an update for this node during the
        // handler, that op carries the authoritative value: a corrective here
        // would be a byte-identical duplicate.
        if (
          target &&
          target.created &&
          msg.name === 'change' &&
          typeof msg.seq === 'number' &&
          'value' in payload &&
          !this.updatedDuringDispatch.has(msg.id) &&
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
        this.settleRequest<TreeNode>(msg.rid, (w) => w.resolve(msg.root));
        break;
      }
      case 'shot': {
        this.settleRequest<string>(msg.rid, (w) => {
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
