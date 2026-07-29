import type { ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import {
  ConcurrentRoot,
  DiscreteEventPriority,
} from 'react-reconciler/constants.js';
import type { Bridge } from '../bridge/bridge.js';
import type { RootContainer } from './instances.js';
import { makeHostConfig } from './hostConfig.js';

export interface NatuiRenderer {
  render(element: ReactNode, onCommitted?: () => void): void;
  unmount(): void;
  container: RootContainer;
}

export interface NatuiRendererOptions {
  /**
   * Observe errors that escape the React tree. NatUI still logs every
   * uncaught error before invoking this callback.
   */
  onUncaughtError?: (error: Error) => void;
}

interface ManagedNatuiRenderer extends NatuiRenderer {
  renderAsync(element: ReactNode): Promise<void>;
  cancelPendingRender(error: Error): void;
}

interface ManagedNatuiRendererOptions extends NatuiRendererOptions {
  /** @internal Establish the current development generation for host events. */
  runWork?: <T>(work: () => T) => T;
}

/** Settle turns allowed before a render is declared a runaway update loop. */
const SETTLE_TURN_LIMIT = 100;

function createRenderer(
  bridge: Bridge,
  options: ManagedNatuiRendererOptions = {},
): ManagedNatuiRenderer {
  let commitVersion = 0;
  const { hostConfig, runWithPriority } = makeHostConfig(bridge, () => {
    commitVersion += 1;
  });
  const reconciler = Reconciler(hostConfig);
  // react-reconciler 0.33 takes its DevTools metadata from HostConfig at
  // runtime, while the current DefinitelyTyped declaration still models the
  // older argument-taking API.
  (reconciler.injectIntoDevTools as unknown as () => boolean)();

  const container: RootContainer = {
    children: [],
    nextId: 1,
    bridge,
  };

  let pendingRender:
    | {
        reject(error: Error): void;
        resolve(): void;
      }
    | undefined;

  const reportError = (error: Error) => {
    console.error('[natui] React error:', error);
  };
  const onUncaughtError = (error: Error) => {
    reportError(error);
    const request = pendingRender;
    pendingRender = undefined;
    // React reports an uncaught render error before its failed-root commit is
    // fully visible to React Refresh. Reject on the next turn so recovery can
    // reliably retry that root.
    if (request) setImmediate(() => request.reject(error));
    try {
      options.onUncaughtError?.(error);
    } catch (handlerError) {
      console.error('[natui] onUncaughtError handler failed:', handlerError);
    }
  };

  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    'natui', // identifierPrefix
    onUncaughtError,
    reportError, // onCaughtError
    reportError, // onRecoverableError
    () => {}, // onDefaultTransitionIndicator
  );

  // Host events run at discrete priority and are flushed synchronously, so
  // the Bridge can check right after each change event whether the app
  // adopted the controlled value (see Bridge enforcement). This includes
  // slider drags: responsiveness during a drag comes from the host's
  // optimistic local value plus seq/ack echo suppression, not from React
  // priority, and enforcement only lands once the drag settles.
  bridge.setPriorityRunner((fn) => {
    const dispatch = () => {
      runWithPriority(DiscreteEventPriority, fn);
      reconciler.flushSyncWork();
    };
    if (options.runWork) options.runWork(dispatch);
    else dispatch();
  });

  return {
    container,
    render(element, onCommitted) {
      reconciler.updateContainer(element, root, null, onCommitted ?? null);
    },
    renderAsync(element) {
      // React's own model is that a newer update supersedes an older one, so
      // overlapping calls coalesce onto the latest element rather than failing.
      // The superseded promise rejects rather than resolving: its element never
      // committed, and silently resolving it would report a render that did not
      // happen.
      if (pendingRender) {
        const superseded = pendingRender;
        pendingRender = undefined;
        superseded.reject(
          new Error('natui: render superseded by a newer render before it committed'),
        );
      }

      return new Promise<void>((resolve, reject) => {
        const request = { resolve, reject };
        let observedCommitVersion = commitVersion;
        let quietTurns = 0;
        let settleTurns = 0;
        const settle = () => {
          if (pendingRender !== request) return;
          const flushedPassiveEffects = reconciler.flushPassiveEffects();
          if (pendingRender !== request) return;

          if (
            !flushedPassiveEffects &&
            observedCommitVersion === commitVersion
          ) {
            quietTurns += 1;
          } else {
            quietTurns = 0;
          }
          observedCommitVersion = commitVersion;
          settleTurns += 1;

          // Passive effects can create arbitrarily long synchronous update
          // chains. Wait until the root stays quiet instead of assuming a
          // fixed number of follow-up renders. The cap prevents a component
          // with a deliberate infinite update loop from blocking startup
          // forever.
          if (quietTurns < 2 && settleTurns < SETTLE_TURN_LIMIT) {
            setImmediate(settle);
            return;
          }

          pendingRender = undefined;
          // "Never quiesced" and "quiesced" must not share an exit: reporting
          // an update loop as a successful startup hides the one thing the cap
          // exists to detect.
          if (quietTurns < 2) {
            reject(
              new Error(
                `natui: the render did not settle within ${SETTLE_TURN_LIMIT} turns; ` +
                  'a component is most likely updating state on every commit',
              ),
            );
            return;
          }
          resolve();
        };

        pendingRender = request;
        reconciler.updateContainer(element, root, null, () => {
          if (pendingRender !== request) return;
          // Effects can enqueue one or more follow-up renders. Let the
          // scheduler drain those turns before the dev server declares the
          // generation committed.
          queueMicrotask(settle);
        });
      });
    },
    cancelPendingRender(error) {
      const request = pendingRender;
      pendingRender = undefined;
      request?.reject(error);
    },
    unmount() {
      pendingRender?.reject(new Error('natui: renderer unmounted before the render committed'));
      pendingRender = undefined;
      // updateContainer alone schedules on the default lane, which
      // flushSyncWork does NOT flush, the unmount commit would race the quit
      // message. updateContainerSync uses the sync lane, making this
      // deterministic: removal ops and effect cleanups all run before return.
      reconciler.updateContainerSync(null, root, null, null);
      reconciler.flushSyncWork();
      reconciler.flushPassiveEffects();
      bridge.flush();
    },
  };
}

export function createNatuiRenderer(
  bridge: Bridge,
  options: NatuiRendererOptions = {},
): NatuiRenderer {
  const { container, render, unmount } = createRenderer(bridge, options);
  return { container, render, unmount };
}

/** @internal Renderer lifecycle controls used by the Node development runtime. */
export function createManagedNatuiRenderer(
  bridge: Bridge,
  options: ManagedNatuiRendererOptions = {},
): ManagedNatuiRenderer {
  return createRenderer(bridge, options);
}
