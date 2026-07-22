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

export function createNatuiRenderer(bridge: Bridge): NatuiRenderer {
  const { hostConfig, runWithPriority } = makeHostConfig(bridge);
  const reconciler = Reconciler(hostConfig);

  const container: RootContainer = {
    isRoot: true,
    children: [],
    nextId: 1,
    bridge,
  };

  const onError = (error: Error) => {
    console.error('[natui] React error:', error);
  };

  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    'natui', // identifierPrefix
    onError, // onUncaughtError
    onError, // onCaughtError
    onError, // onRecoverableError
    () => {}, // onDefaultTransitionIndicator
  );

  // Host events run at discrete priority and are flushed synchronously, so
  // the Bridge can check right after each change event whether the app
  // adopted the controlled value (see Bridge enforcement). This includes
  // slider drags: responsiveness during a drag comes from the host's
  // optimistic local value plus seq/ack echo suppression, not from React
  // priority, and enforcement only lands once the drag settles.
  bridge.setPriorityRunner((_kind, fn) => {
    runWithPriority(DiscreteEventPriority, fn);
    reconciler.flushSyncWork();
  });

  return {
    container,
    render(element, onCommitted) {
      reconciler.updateContainer(element, root, null, onCommitted ?? null);
    },
    unmount() {
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
