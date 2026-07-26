/**
 * In-process entry point (Stage 2): the native host embeds a JS engine
 * (JavaScriptCore on macOS, V8 on Windows) and evaluates the app bundle
 * directly. There is no child process and no stdio; messages cross the
 * boundary as plain function calls:
 *
 *   JS -> host: the host injects a global `__natui_send(json)` function.
 *   host -> JS: this module registers a global `__natui_recv(json)` function.
 *
 * This file must stay free of Node built-ins so it bundles for a bare engine
 * (esbuild --platform=browser). It deliberately does not import run.ts.
 */
import type { ReactNode } from 'react';
import { Bridge, type ReadyInfo } from './bridge/bridge.js';
import type { Transport } from './bridge/transport.js';
import {
  HOST_API_VERSION,
  PROTOCOL_VERSION,
  type InboundMessage,
  type OutboundMessage,
  type WindowProps,
} from './protocol.js';
import { createNatuiRenderer } from './reconciler/renderer.js';

type SendFn = (line: string) => void;

interface NatuiGlobals {
  __natui_send?: SendFn;
  __natui_recv?: (line: string) => void;
}

class InProcTransport implements Transport {
  private messageCb: ((msg: InboundMessage) => void) | undefined;
  private buffered: InboundMessage[] = [];
  private hostSend: SendFn;
  private globals: NatuiGlobals;
  private receive: (line: string) => void;
  private closed = false;

  constructor() {
    const g = globalThis as NatuiGlobals;
    if (typeof g.__natui_send !== 'function') {
      throw new Error(
        '@natui/core/inproc: no embedding host detected (__natui_send is missing). ' +
        'Run this bundle inside the NatUI host with --bundle.',
      );
    }
    if (typeof g.__natui_recv === 'function') {
      throw new Error(
        '@natui/core/inproc: an embedded application is already active in this JavaScript runtime',
      );
    }
    this.globals = g;
    this.hostSend = g.__natui_send;
    this.receive = (line) => {
      if (this.closed) return;
      let msg: InboundMessage;
      try {
        msg = JSON.parse(line) as InboundMessage;
      } catch {
        console.error(`@natui/core/inproc: bad message from host: ${line.slice(0, 200)}`);
        return;
      }
      if (this.messageCb) this.messageCb(msg);
      else this.buffered.push(msg);
    };
    g.__natui_recv = this.receive;
  }

  send(msg: OutboundMessage): void {
    if (this.closed) {
      throw new Error('@natui/core/inproc: cannot send through a closed embedding transport');
    }
    this.hostSend(JSON.stringify(msg));
  }

  onMessage(cb: (msg: InboundMessage) => void): void {
    this.messageCb = cb;
    for (const msg of this.buffered.splice(0)) cb(msg);
  }

  onExit(): void {
    // The host owns our lifetime; there is no exit event to observe.
  }

  close(): void {
    this.closed = true;
    if (this.globals.__natui_recv === this.receive) {
      delete this.globals.__natui_recv;
    }
    this.buffered = [];
    this.messageCb = undefined;
  }
}

let preparedTransport: InProcTransport | undefined;

/**
 * Install the embedded receive hook before evaluating an application entry.
 *
 * The application packager calls this before its dynamic entry import so host
 * messages can be buffered while the entry performs top-level async work.
 *
 * @internal
 */
export function prepareEmbeddedRuntime(): void {
  preparedTransport ??= new InProcTransport();
}

/** @internal */
export function assertEmbeddedRuntimeStarted(): void {
  if (!preparedTransport) return;
  preparedTransport.close();
  preparedTransport = undefined;
  throw new Error(
    '@natui/core/inproc: application entry completed without calling run()',
  );
}

/**
 * Surface an asynchronous entry failure through the host's normal uncaught
 * exception path. A rejected Promise alone is not reported consistently by
 * the embedded JavaScript engines.
 *
 * @internal
 */
export function deferEmbeddedRuntimeFailure(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

function takeEmbeddedTransport(): {
  prepared: boolean;
  transport: InProcTransport;
} {
  const transport = preparedTransport;
  preparedTransport = undefined;
  return {
    prepared: transport !== undefined,
    transport: transport ?? new InProcTransport(),
  };
}

export interface RunEmbeddedOptions extends WindowProps {
  /** Called once when the native window asks the application to close. */
  onClose?: () => void;
  /** Startup handshake timeout override (mainly for tests). */
  readyTimeoutMs?: number;
}

export type EmbeddedPlatform = 'macos' | 'windows';
export type EmbeddedAppState = 'running' | 'stopping' | 'stopped';

export interface EmbeddedApp {
  readonly platform: EmbeddedPlatform;
  readonly state: EmbeddedAppState;
  /** Re-render with a new element. Throws after shutdown begins. */
  update(element: ReactNode): void;
  /**
   * Synchronously unmount React, flush effect cleanup, ask the host to quit,
   * and detach the in-process receive hook. Safe to call more than once.
   */
  quit(): void;
}

/** How long the embedding host may take to send `ready` after evaluation. */
const EMBEDDED_READY_TIMEOUT_MS = 10_000;

/** Render a React element inside an embedding native host. */
export async function runEmbedded(
  element: ReactNode,
  options: RunEmbeddedOptions = {},
): Promise<EmbeddedApp> {
  const { onClose, readyTimeoutMs, ...windowProps } = options;
  const { prepared, transport } = takeEmbeddedTransport();
  // The Bridge subscribes immediately, so no host message can be dropped
  // between the handshake and regular operation.
  const bridge = new Bridge(transport);

  let state: 'starting' | EmbeddedAppState = 'starting';
  let renderer: ReturnType<typeof createNatuiRenderer> | undefined;
  let rejectInitialRender: ((error: Error) => void) | undefined;

  const stop = (notifyHost: boolean) => {
    if (state === 'stopping' || state === 'stopped') return;
    state = 'stopping';
    let cleanupError: unknown;
    const cleanup = (step: () => void) => {
      try {
        step();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    try {
      const activeRenderer = renderer;
      if (activeRenderer) cleanup(() => activeRenderer.unmount());
      if (notifyHost) cleanup(() => bridge.quit());
      cleanup(() => bridge.dispose('embedded app stopped'));
      cleanup(() => transport.close());
    } finally {
      state = 'stopped';
    }
    if (cleanupError) throw cleanupError;
  };
  const quit = () => stop(true);

  let ready: ReadyInfo;
  try {
    ready = await bridge.waitForReady(readyTimeoutMs ?? EMBEDDED_READY_TIMEOUT_MS);
    if (ready.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `@natui/core/inproc: embedding host speaks protocol v${ready.protocol} but this bundle ` +
          `requires v${PROTOCOL_VERSION}; rebuild the host to match`,
      );
    }
    if (!Number.isInteger(ready.hostApi) || ready.hostApi < HOST_API_VERSION) {
      const reported = Number.isInteger(ready.hostApi) ? `v${ready.hostApi}` : 'no API level';
      throw new Error(
        `@natui/core/inproc: embedding host reports ${reported} but this bundle requires host ` +
          `API v${HOST_API_VERSION} or newer; rebuild the host to match`,
      );
    }
    if (ready.platform !== 'macos' && ready.platform !== 'windows') {
      throw new Error(
        `@natui/core/inproc: embedding host reported unknown platform "${ready.platform}"`,
      );
    }

    // Renderer construction installs bridge callbacks and can itself fail.
    // Keep it inside the protected startup region so every failure asks the
    // native host to quit and releases the global receive hook.
    const createdRenderer = createNatuiRenderer(bridge, {
      onUncaughtError(error) {
        rejectInitialRender?.(error);
      },
    });
    renderer = createdRenderer;
    bridge.onWindowClose(() => {
      try {
        onClose?.();
      } finally {
        quit();
      }
    });

    if (state !== 'starting') {
      throw new Error('@natui/core/inproc: embedding host closed during application startup');
    }
    bridge.sendWindow(windowProps);
    // The embedding host may synchronously deliver a native close while
    // handling the window message. Never mount React after that close path
    // has already unmounted and detached the transport.
    if (state !== 'starting') {
      throw new Error('@natui/core/inproc: embedding host closed during application startup');
    }
    await new Promise<void>((resolve, reject) => {
      rejectInitialRender = reject;
      // React invokes the root update callback before reporting an error that
      // escaped the tree. Keep startup pending through the following host
      // turn so onUncaughtError can reject instead of publishing a broken
      // controller as running.
      createdRenderer.render(element, () => setTimeout(resolve, 0));
    });
    rejectInitialRender = undefined;
    if (state !== 'starting') {
      throw new Error('@natui/core/inproc: embedding host closed during application startup');
    }
  } catch (error) {
    rejectInitialRender = undefined;
    try {
      // The packaging bootstrap converts this rejected startup into an
      // uncaught host exception. Do not race that fatal path with a normal
      // quit acknowledgement. Direct in-process callers retain the original
      // graceful shutdown behavior.
      stop(!prepared);
    } catch (cleanupError) {
      console.error('@natui/core/inproc: startup cleanup failed:', cleanupError);
    }
    throw error;
  }
  if (state === 'starting') state = 'running';

  const platform = ready.platform;
  return {
    platform,
    get state() {
      return state === 'starting' ? 'running' : state;
    },
    update(nextElement) {
      if (state !== 'running') {
        throw new Error('@natui/core/inproc: cannot update an application that is stopping or stopped');
      }
      renderer.render(nextElement);
    },
    quit,
  };
}
