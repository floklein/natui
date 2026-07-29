import type { PluginItem } from '@babel/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

// The development server always needs React's development builds, even when
// the parent shell happens to have NODE_ENV set to another value.
process.env.NODE_ENV = 'development';

const require = createRequire(import.meta.url);

export interface ReactRefreshRuntime {
  injectIntoGlobalHook(target: object): void;
  register(type: unknown, id: string): void;
  createSignatureFunctionForTransform(): (...args: unknown[]) => unknown;
  performReactRefresh(): unknown;
  getFamilyByID(id: string): RefreshFamily | undefined;
}

export const REFRESH_MODULE_RUNTIME_GLOBAL =
  '__natui_react_refresh_module_runtime__';
const REFRESH_INSTALLED_GLOBAL = '__natui_react_refresh_installed__';
const REFRESH_RECOVERY_FAMILY = 'natui:dev-runtime/recovery';

export const refreshRuntime = require('react-refresh/runtime') as ReactRefreshRuntime;
export const refreshBabelPlugin = require('react-refresh/babel') as PluginItem;

interface RefreshFamily {
  current: unknown;
}

interface PendingRegistration {
  id: string;
  type: unknown;
}

const REACT_FORWARD_REF_TYPE = Symbol.for('react.forward_ref');
const REACT_MEMO_TYPE = Symbol.for('react.memo');

function readProperty(value: object, property: PropertyKey): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

export interface RefreshTransaction {
  /** Evaluate module code with registrations isolated to this transaction. */
  run<T>(evaluate: () => T): T;
  /** Publish the component families registered while the module graph loaded. */
  apply(): void;
  /** Keep the published families after the native tree commits successfully. */
  commit(): void;
  /** Restore the family implementations that were active before apply(). */
  rollback(): void;
  /** Buffer late registrations while a replacement generation is pending. */
  pause(): void;
  /** Publish registrations buffered while a replacement generation failed. */
  resume(): void;
  /** Permanently ignore async work that outlives this generation. */
  retire(): void;
}

class RefreshTransactionImpl implements RefreshTransaction {
  private state:
    | 'collecting'
    | 'applied'
    | 'committed'
    | 'paused'
    | 'retired'
    | 'rolled-back' = 'collecting';
  private readonly appliedRegistrations: PendingRegistration[] = [];
  private readonly pausedRegistrations: PendingRegistration[] = [];
  private readonly previousTypes = new Map<RefreshFamily, unknown>();
  private readonly registrations: PendingRegistration[] = [];

  run<T>(evaluate: () => T): T {
    return transactionStorage.run(this, evaluate);
  }

  register(type: unknown, id: string): void {
    if (this.state === 'retired' || this.state === 'rolled-back') return;
    if (this.state === 'paused') {
      this.pausedRegistrations.push({ type, id });
      return;
    }
    if (this.state === 'committed') {
      refreshRuntime.register(type, id);
      scheduleRefresh();
      return;
    }
    if (this.state === 'applied') {
      // The generation has published its initial batch but has not committed.
      // Keep late async registrations private until commit so rollback cannot
      // leave a queued React Refresh update that republishes stale code.
      this.appliedRegistrations.push({ type, id });
      return;
    }
    this.registrations.push({ type, id });
  }

  apply(): void {
    if (this.state !== 'collecting') return;
    this.state = 'applied';
    for (const { type, id } of this.registrations) {
      this.captureFamilyTree(type, id);
      refreshRuntime.register(type, id);
    }
  }

  rollback(): void {
    if (
      this.state === 'committed' ||
      this.state === 'paused' ||
      this.state === 'retired' ||
      this.state === 'rolled-back'
    ) {
      return;
    }
    const wasApplied = this.state === 'applied';
    this.state = 'rolled-back';
    if (!wasApplied) return;

    // React Refresh does not expose an unregister operation. Family objects
    // are deliberately mutable, so restoring their previous current type
    // lets the renderer recover the last successfully committed tree.
    for (const [family, previousType] of this.previousTypes) {
      family.current = previousType;
    }
  }

  commit(): void {
    if (
      this.state === 'committed' ||
      this.state === 'paused' ||
      this.state === 'retired' ||
      this.state === 'rolled-back'
    ) {
      return;
    }
    this.state = 'committed';
    if (this.appliedRegistrations.length === 0) return;
    for (const { type, id } of this.appliedRegistrations) {
      refreshRuntime.register(type, id);
    }
    this.appliedRegistrations.length = 0;
    scheduleRefresh();
  }

  pause(): void {
    if (this.state === 'committed') this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'committed';
    if (this.pausedRegistrations.length === 0) return;
    for (const { type, id } of this.pausedRegistrations) {
      refreshRuntime.register(type, id);
    }
    this.pausedRegistrations.length = 0;
    scheduleRefresh();
  }

  retire(): void {
    if (this.state === 'retired' || this.state === 'rolled-back') return;
    this.state = 'retired';
    this.appliedRegistrations.length = 0;
    this.pausedRegistrations.length = 0;
    this.registrations.length = 0;
  }

  private captureFamily(id: string): void {
    const family = refreshRuntime.getFamilyByID(id);
    if (family && !this.previousTypes.has(family)) {
      this.previousTypes.set(family, family.current);
    }
  }

  private captureFamilyTree(type: unknown, id: string): void {
    this.captureFamily(id);
    if (typeof type !== 'object' || type === null) return;

    const marker = readProperty(type, '$$typeof');

    if (marker === REACT_FORWARD_REF_TYPE) {
      this.captureFamilyTree(readProperty(type, 'render'), `${id}$render`);
    } else if (marker === REACT_MEMO_TYPE) {
      this.captureFamilyTree(readProperty(type, 'type'), `${id}$type`);
    }
  }
}

const transactionStorage = new AsyncLocalStorage<RefreshTransactionImpl>();
let refreshScheduled = false;

function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  queueMicrotask(() => {
    refreshScheduled = false;
    try {
      refreshRuntime.performReactRefresh();
    } catch (error) {
      console.error('[natui] asynchronous React Refresh failed:', error);
    }
  });
}

/**
 * The runtime as module code sees it: registrations are routed into the active
 * transaction, or published immediately when there is none.
 */
export const refreshRuntimeFacade = new Proxy(refreshRuntime, {
  get(target, property, receiver) {
    if (property === 'register') {
      return (type: unknown, id: string) => {
        const transaction = transactionStorage.getStore();
        if (transaction) transaction.register(type, id);
        else {
          target.register(type, id);
          scheduleRefresh();
        }
      };
    }
    return Reflect.get(target, property, receiver) as unknown;
  },
}) as ReactRefreshRuntime;

export function captureRefreshRuntime(): ReactRefreshRuntime {
  const transaction = transactionStorage.getStore();
  if (!transaction) return refreshRuntimeFacade;

  // Bind at module evaluation start. Async module bodies can then finish
  // after another generation commits without being mistaken for current code.
  return new Proxy(refreshRuntime, {
    get(target, property, receiver) {
      if (property === 'register') {
        return (type: unknown, id: string) => transaction.register(type, id);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as ReactRefreshRuntime;
}

export function captureRefreshWorkRunner(): <T>(work: () => T) => T {
  const transaction = transactionStorage.getStore();
  if (!transaction) return (work) => work();
  return (work) => transaction.run(work);
}

type RefreshGlobal = typeof globalThis & {
  [REFRESH_INSTALLED_GLOBAL]?: boolean;
};

export function installRefreshRuntime(): void {
  const target = globalThis as RefreshGlobal;
  if (target[REFRESH_INSTALLED_GLOBAL]) return;

  refreshRuntime.injectIntoGlobalHook(globalThis);
  refreshRuntime.register(function NatuiRefreshRecoveryRoot() {}, REFRESH_RECOVERY_FAMILY);
  target[REFRESH_INSTALLED_GLOBAL] = true;
}

export function beginRefreshTransaction(): RefreshTransaction {
  return new RefreshTransactionImpl();
}

export function recoverRefreshRuntime(): void {
  // A refresh that throws moves the reconciler root into React Refresh's
  // failed-root set. Publishing an unused family update asks the runtime to
  // retry those roots after the transaction restored their prior types.
  refreshRuntime.register(function NatuiRefreshRecoveryRoot() {}, REFRESH_RECOVERY_FAMILY);
  refreshRuntime.performReactRefresh();
}
