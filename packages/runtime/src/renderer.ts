import { createContext } from "react";
import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import {
  ConcurrentRoot,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from "react-reconciler/constants.js";
import type { JsonValue, WireNode } from "./protocol.js";
import {
  allocateId,
  appendChild,
  commitSnapshot,
  createRootContainer,
  insertChildBefore,
  removeChild,
} from "./tree.js";
import type { HostChild, HostElement, HostText, NativeProps, RootContainer } from "./tree.js";

type TimeoutHandle = ReturnType<typeof setTimeout>;
type TransitionStatus = null;
type HostContext = Readonly<Record<string, never>>;

let currentUpdatePriority = NoEventPriority;
const HostTransitionContext = createContext<TransitionStatus>(null);
const ROOT_HOST_CONTEXT: HostContext = Object.freeze({});

const hostConfig = {
  rendererVersion: "0.1.0",
  rendererPackageName: "@natui/runtime",
  extraDevToolsConfig: null,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  noTimeout: -1,
  NotPendingTransition: null,
  HostTransitionContext,

  getRootHostContext: () => ROOT_HOST_CONTEXT,
  getChildHostContext: (parent: HostContext) => parent,
  getPublicInstance: (instance: HostElement | HostText) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container: RootContainer) => commitSnapshot(container),
  preparePortalMount: () => undefined,

  createInstance: (type: string, props: NativeProps, root: RootContainer): HostElement => ({
    children: [],
    hidden: false,
    id: allocateId(root),
    kind: "element",
    props,
    type,
  }),
  createTextInstance: (text: string, root: RootContainer): HostText => ({
    hidden: false,
    id: allocateId(root, "t"),
    kind: "text",
    text,
  }),
  appendInitialChild: (parent: HostElement, child: HostChild) => appendChild(parent, child),
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  scheduleMicrotask: queueMicrotask,

  appendChild: (parent: HostElement, child: HostChild) => appendChild(parent, child),
  appendChildToContainer: (container: RootContainer, child: HostChild) => appendChild(container, child),
  insertBefore: (parent: HostElement, child: HostChild, before: HostChild) =>
    insertChildBefore(parent, child, before),
  insertInContainerBefore: (container: RootContainer, child: HostChild, before: HostChild) =>
    insertChildBefore(container, child, before),
  removeChild: (parent: HostElement, child: HostChild) => removeChild(parent, child),
  removeChildFromContainer: (container: RootContainer, child: HostChild) => removeChild(container, child),
  clearContainer: (container: RootContainer) => {
    container.children.length = 0;
  },
  commitUpdate: (instance: HostElement, _type: string, _oldProps: NativeProps, newProps: NativeProps) => {
    instance.props = newProps;
  },
  commitTextUpdate: (instance: HostText, _oldText: string, nextText: string) => {
    instance.text = nextText;
  },
  resetTextContent: (instance: HostElement) => {
    instance.children.length = 0;
  },
  hideInstance: (instance: HostElement) => {
    instance.hidden = true;
  },
  unhideInstance: (instance: HostElement) => {
    instance.hidden = false;
  },
  hideTextInstance: (instance: HostText) => {
    instance.hidden = true;
  },
  unhideTextInstance: (instance: HostText, text: string) => {
    instance.hidden = false;
    instance.text = text;
  },
  detachDeletedInstance: () => undefined,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  prepareScopeUpdate: () => undefined,
  getInstanceFromScope: () => null,
  resetFormInstance: () => undefined,

  setCurrentUpdatePriority: (priority: number) => {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () =>
    currentUpdatePriority === NoEventPriority ? DefaultEventPriority : currentUpdatePriority,
  trackSchedulerEvent: () => undefined,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: (callback: (time: number) => void) => {
    setTimeout(() => callback(Date.now()), 0);
  },

  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  bindToConsole:
    (method: "error" | "warn" | "log", args: unknown[]) =>
    () => {
      const logger = console[method] as (...values: unknown[]) => void;
      logger(...args);
    },

  supportsTestSelectors: false,
  supportsResources: false,
  supportsSingletons: false,
};

type NatReconciler = ReturnType<typeof ReactReconciler<
  string,
  NativeProps,
  RootContainer,
  HostElement,
  HostText,
  never,
  never,
  never,
  HostElement | HostText,
  HostContext,
  never,
  TimeoutHandle,
  -1,
  TransitionStatus
>>;

const reconciler = ReactReconciler(hostConfig as never) as NatReconciler;

export interface NativeRoot {
  dispatch(handlerId: string, payload?: JsonValue): boolean;
  render(element: ReactNode): void;
  unmount(): void;
}

export function createNativeRoot(
  onCommit: (root: WireNode | null, revision: number) => void,
  onError: (error: Error) => void = (error) => console.error(error),
): NativeRoot {
  const container = createRootContainer(onCommit);
  const handle = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "natui-",
    onError,
    onError,
    onError,
    () => undefined,
  );

  return {
    dispatch(handlerId, payload) {
      const handler = container.handlers.get(handlerId);
      if (handler === undefined) return false;
      const previousPriority = currentUpdatePriority;
      currentUpdatePriority = DiscreteEventPriority;
      try {
        reconciler.batchedUpdates(
          (eventPayload: JsonValue | undefined) => handler(eventPayload),
          payload,
        );
        reconciler.flushSyncWork();
      } finally {
        currentUpdatePriority = previousPriority;
      }
      return true;
    },
    render(element) {
      reconciler.updateContainerSync(element, handle, null, null);
      reconciler.flushSyncWork();
    },
    unmount() {
      reconciler.updateContainerSync(null, handle, null, null);
      reconciler.flushSyncWork();
    },
  };
}
