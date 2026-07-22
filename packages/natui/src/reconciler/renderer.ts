import type { ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import {
  ConcurrentRoot,
  ContinuousEventPriority,
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

  // Host events run at interactive priority so React treats them like real
  // user input: discrete for clicks/typing, continuous for slider drags.
  // Discrete events are flushed synchronously so the Bridge can immediately
  // check whether the app accepted a controlled value (see Bridge enforcement).
  bridge.setPriorityRunner((kind, fn) => {
    const priority = kind === 'Slider' ? ContinuousEventPriority : DiscreteEventPriority;
    runWithPriority(priority, fn);
    if (priority === DiscreteEventPriority) reconciler.flushSyncWork();
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
