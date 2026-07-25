import { createContext, version as reactVersion } from 'react';
import type { HostConfig } from 'react-reconciler';
import {
  DefaultEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js';
import type { Bridge } from '../bridge/bridge.js';
import { ROOT_ID } from '../protocol.js';
import {
  type Child,
  type HostInstance,
  type HostTextInstance,
  type RootContainer,
  isTextInstance,
  markDestroyed,
  materialize,
  propsEqual,
  serializeProps,
  shadowAppend,
  shadowInsertBefore,
  shadowRemove,
} from './instances.js';

type Props = Record<string, unknown>;

/** React 19 requires a non-null host context at runtime. */
const HOST_CONTEXT: Record<never, never> = {};

export type NatuiHostConfig = HostConfig<
    string, // Type
    Props, // Props
    RootContainer, // Container
    HostInstance, // Instance
    HostTextInstance, // TextInstance
    never, // SuspenseInstance
    never, // HydratableInstance
    never, // FormInstance
    Child, // PublicInstance
    Record<never, never>, // HostContext
    never, // ChildSet
    ReturnType<typeof setTimeout>, // TimeoutHandle
    -1, // NoTimeout
    null // TransitionStatus
  > & {
    // react-reconciler 0.33 reads these runtime fields when it registers
    // DevTools and React Refresh support. Its public TypeScript HostConfig
    // declaration does not include them yet.
    rendererVersion: string;
    rendererPackageName: string;
    extraDevToolsConfig: null;
  };

export interface HostConfigHandle {
  hostConfig: NatuiHostConfig;
  /** Run fn with a given React update priority (used for host event dispatch). */
  runWithPriority(priority: number, fn: () => void): void;
}

export function makeHostConfig(
  bridge: Bridge,
  onCommit?: () => void,
): HostConfigHandle {
  let currentUpdatePriority: number = NoEventPriority;

  const hostConfig: NatuiHostConfig = {
    rendererVersion: reactVersion,
    rendererPackageName: 'natui',
    extraDevToolsConfig: null,
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    warnsIfNotActing: false,
    noTimeout: -1,

    // -- render phase -------------------------------------------------------

    createInstance(type, props, rootContainer) {
      const { props: serialized, handlers } = serializeProps(props, type);
      return {
        id: rootContainer.nextId++,
        kind: type,
        props: serialized,
        handlers,
        children: [],
        created: false,
      };
    },

    createTextInstance(text, rootContainer) {
      return {
        id: rootContainer.nextId++,
        kind: '#text',
        text,
        created: false,
      };
    },

    appendInitialChild(parent, child) {
      shadowAppend(parent.children, child);
    },

    finalizeInitialChildren() {
      return false;
    },

    shouldSetTextContent() {
      return false;
    },

    getRootHostContext() {
      return HOST_CONTEXT;
    },

    getChildHostContext(parentHostContext) {
      return parentHostContext;
    },

    getPublicInstance(instance) {
      return instance;
    },

    // -- commit phase: attach/detach -----------------------------------------

    appendChild(parent, child) {
      shadowAppend(parent.children, child);
      if (parent.created) {
        materialize(child, bridge);
        bridge.push({ op: 'append', parent: parent.id, child: child.id });
      }
    },

    appendChildToContainer(container, child) {
      shadowAppend(container.children, child);
      materialize(child, bridge);
      bridge.push({ op: 'append', parent: ROOT_ID, child: child.id });
    },

    insertBefore(parent, child, before) {
      shadowInsertBefore(parent.children, child, before as Child);
      if (parent.created) {
        materialize(child, bridge);
        bridge.push({ op: 'insert', parent: parent.id, child: child.id, before: (before as Child).id });
      }
    },

    insertInContainerBefore(container, child, before) {
      shadowInsertBefore(container.children, child, before as Child);
      materialize(child, bridge);
      bridge.push({ op: 'insert', parent: ROOT_ID, child: child.id, before: (before as Child).id });
    },

    removeChild(parent, child) {
      shadowRemove(parent.children, child as Child);
      if (parent.created && (child as Child).created) {
        bridge.push({ op: 'remove', parent: parent.id, child: (child as Child).id });
      }
      markDestroyed(child as Child, bridge);
    },

    removeChildFromContainer(container, child) {
      shadowRemove(container.children, child as Child);
      if ((child as Child).created) {
        bridge.push({ op: 'remove', parent: ROOT_ID, child: (child as Child).id });
      }
      markDestroyed(child as Child, bridge);
    },

    clearContainer(container) {
      if (container.children.length === 0) return;
      for (const child of container.children) markDestroyed(child, bridge);
      container.children = [];
      bridge.push({ op: 'clear' });
    },

    // -- commit phase: updates -----------------------------------------------

    commitUpdate(instance, type, _prevProps, nextProps) {
      const { props, handlers } = serializeProps(nextProps, type);
      instance.handlers = handlers;
      if (!propsEqual(props, instance.props)) {
        instance.props = props;
        if (instance.created) {
          const ack = bridge.latestSeqFor(instance.id);
          // A Suspense-hidden instance must stay hidden through updates;
          // instance.props stays un-hidden so unhideInstance restores it.
          const wireProps = instance.suspenseHidden ? { ...props, hidden: true } : props;
          bridge.push(
            ack === undefined
              ? { op: 'update', id: instance.id, props: wireProps }
              : { op: 'update', id: instance.id, props: wireProps, ack },
          );
        }
      }
    },

    commitTextUpdate(textInstance, _oldText, newText) {
      textInstance.text = newText;
      if (textInstance.created) {
        // Same Suspense guard as commitUpdate: hidden text stays blank.
        const wireText = textInstance.suspenseHidden ? '' : newText;
        bridge.push({ op: 'text', id: textInstance.id, text: wireText });
      }
    },

    commitMount() {},

    resetTextContent() {},

    hideInstance(instance) {
      instance.suspenseHidden = true;
      if (instance.created) {
        const ack = bridge.latestSeqFor(instance.id);
        const props = { ...instance.props, hidden: true };
        bridge.push(
          ack === undefined
            ? { op: 'update', id: instance.id, props }
            : { op: 'update', id: instance.id, props, ack },
        );
      }
    },

    unhideInstance(instance) {
      instance.suspenseHidden = false;
      if (instance.created) {
        const ack = bridge.latestSeqFor(instance.id);
        bridge.push(
          ack === undefined
            ? { op: 'update', id: instance.id, props: instance.props }
            : { op: 'update', id: instance.id, props: instance.props, ack },
        );
      }
    },

    hideTextInstance(textInstance) {
      textInstance.suspenseHidden = true;
      if (textInstance.created) {
        bridge.push({ op: 'text', id: textInstance.id, text: '' });
      }
    },

    unhideTextInstance(textInstance, text) {
      textInstance.suspenseHidden = false;
      textInstance.text = text;
      if (textInstance.created) {
        bridge.push({ op: 'text', id: textInstance.id, text });
      }
    },

    // -- commit lifecycle -----------------------------------------------------

    prepareForCommit() {
      return null;
    },

    resetAfterCommit() {
      bridge.flush();
      onCommit?.();
    },

    preparePortalMount() {},

    // -- scheduling -----------------------------------------------------------

    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,

    setCurrentUpdatePriority(newPriority) {
      currentUpdatePriority = newPriority;
    },
    getCurrentUpdatePriority() {
      return currentUpdatePriority;
    },
    resolveUpdatePriority() {
      return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority;
    },

    shouldAttemptEagerTransition() {
      return false;
    },

    trackSchedulerEvent() {},
    resolveEventType() {
      return null;
    },
    resolveEventTimeStamp() {
      return -1.1;
    },
    requestPostPaintCallback() {},

    // -- suspensey commits (unused) --------------------------------------------

    maySuspendCommit() {
      return false;
    },
    preloadInstance() {
      return true;
    },
    startSuspendingCommit() {},
    suspendInstance() {},
    waitForCommitToBeReady() {
      return null;
    },

    // -- forms / transitions (unused) -------------------------------------------

    NotPendingTransition: null,
    // The reconciler reads this context internally for form status; we never
    // render forms, so a plain context with a null default suffices.
    HostTransitionContext: createContext<null>(null) as unknown as NatuiHostConfig['HostTransitionContext'],
    resetFormInstance() {},

    // -- misc internals -----------------------------------------------------------

    getInstanceFromNode() {
      return null;
    },
    beforeActiveInstanceBlur() {},
    afterActiveInstanceBlur() {},
    prepareScopeUpdate() {},
    getInstanceFromScope() {
      return null;
    },
    detachDeletedInstance() {},
  };

  return {
    hostConfig,
    runWithPriority(priority, fn) {
      const previous = currentUpdatePriority;
      currentUpdatePriority = priority;
      try {
        fn();
      } finally {
        currentUpdatePriority = previous;
      }
    },
  };
}
