import type { ReactNode } from 'react';
import { Bridge } from './bridge/bridge.js';
import { defaultHostCommand } from './bridge/locate.js';
import { type HostCommand, spawnStdioTransport } from './bridge/transport.js';
import {
  HOST_API_VERSION,
  PROTOCOL_VERSION,
  type TreeNode,
  type WindowProps,
} from './protocol.js';
import { createManagedNatuiRenderer } from './reconciler/renderer.js';

export interface RunOptions extends WindowProps {
  /** Host binary override; defaults to NATUI_HOST env or the in-repo build. */
  host?: string | HostCommand;
  /** Called when the user closes the window. Default: unmount and exit. */
  onClose?: () => void;
  /** Called when React cannot recover from a render error. */
  onUncaughtError?: (error: Error) => void;
  /**
   * Called when the host process exits on its own while the app is running.
   * Default: log and terminate this process with the host's exit code. Provide
   * this to keep the embedding process alive — the dev server does, so a host
   * crash does not take down the watcher and HMR clients with it.
   */
  onHostExit?: (code: number | null) => void;
  /** Startup handshake timeout override (mainly for tests). */
  readyTimeoutMs?: number;
}

export interface NatuiApp {
  /** Debug: ask the host for its current native tree. */
  dump(): Promise<TreeNode>;
  /** Debug: host renders its window content to a PNG at `path`. */
  screenshot(path: string): Promise<string>;
  /** Debug: make the host synthesize a user event on node `id`. */
  emit(id: number, name: string, payload?: Record<string, unknown>): void;
  /**
   * Debug: make the host perform a real optimistic user edit on node `id`
   * (same code path as typing/dragging: local write, seq, change event).
   */
  edit(id: number, value: unknown): void;
  /** Re-render with a new element (e.g. for external hot reload). */
  update(element: ReactNode): Promise<void>;
  /** Unmount, quit the host, close the transport. */
  quit(): void;
}

/** @internal Minimal lifecycle handle exposed while an app is still starting. */
export interface NatuiAppController {
  /** Cancel an initial mount or update that has not committed. */
  cancelPendingUpdate(error: Error): void;
  /** Stop startup or unmount and terminate the host. */
  quit(): void;
}

const READY_TIMEOUT_MS = 10_000;

/** What the `ready` handshake must report for this OS (see docs/protocol.md). */
const EXPECTED_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macos',
  win32: 'windows',
};

const KNOWN_PLATFORMS = new Set(['macos', 'windows']);

/** Render a React element into a native window. Resolves once mounted. */
export async function run(element: ReactNode, options: RunOptions = {}): Promise<NatuiApp> {
  return runWithController(element, options);
}

/** @internal Run with access to a lifecycle handle before the initial mount settles. */
export async function runWithController(
  element: ReactNode,
  options: RunOptions = {},
  onController?: (controller: NatuiAppController) => void,
  runWork?: <T>(work: () => T) => T,
): Promise<NatuiApp> {
  const {
    host,
    onClose,
    onUncaughtError,
    onHostExit,
    readyTimeoutMs,
    ...windowProps
  } = options;

  const hostCmd: HostCommand =
    typeof host === 'string' ? { cmd: host } : (host ?? defaultHostCommand());

  const transport = spawnStdioTransport(hostCmd);
  // The Bridge subscribes immediately: no message can fall between the
  // handshake and regular operation.
  const bridge = new Bridge(transport);

  let phase: 'starting' | 'running' | 'quitting' = 'starting';
  // Must stay `let`: quit() closes over this and can run before the assignment
  // below, where `const` would throw on the temporal dead zone instead of
  // no-op'ing through `renderer?.unmount()`.
  // eslint-disable-next-line prefer-const
  let renderer: ReturnType<typeof createManagedNatuiRenderer> | undefined;
  let startupCancellation: Error | undefined;
  let startupComplete = false;
  let startupCloseError: Error | undefined;
  const quit = () => {
    if (phase === 'quitting') return;
    phase = 'quitting';
    renderer?.unmount();
    bridge.quit();
    bridge.dispose('quit() was called');
    setTimeout(() => transport.close(), 200).unref?.();
  };
  const controller: NatuiAppController = {
    cancelPendingUpdate(error) {
      if (renderer) renderer.cancelPendingRender(error);
      else {
        startupCancellation = error;
        quit();
      }
    },
    quit,
  };
  onController?.(controller);

  transport.onExit((code) => {
    // Rejects the pending ready waiter (startup) and any dump/shot waiters.
    bridge.hostExited(code);
    if (phase !== 'running') return; // startup throws / quit() is intentional
    if (onHostExit) {
      onHostExit(code);
      return;
    }
    if (code === null) {
      // Killed by a signal: never a clean shutdown, say so and fail.
      console.error('[natui] host was terminated by a signal');
      process.exit(1);
    }
    if (code !== 0) console.error(`[natui] host exited with code ${code}`);
    process.exit(code);
  });

  try {
    const ready = await bridge.waitForReady(readyTimeoutMs ?? READY_TIMEOUT_MS);
    if (ready.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `natui: host speaks protocol v${ready.protocol} but this renderer requires ` +
          `v${PROTOCOL_VERSION}; rebuild the host to match`,
      );
    }
    if (!Number.isInteger(ready.hostApi) || ready.hostApi < HOST_API_VERSION) {
      const reported = Number.isInteger(ready.hostApi) ? `v${ready.hostApi}` : 'no API level';
      throw new Error(
        `natui: host reports ${reported} but this renderer requires host API ` +
          `v${HOST_API_VERSION} or newer; rebuild the host to match`,
      );
    }
    if (!KNOWN_PLATFORMS.has(ready.platform)) {
      throw new Error(`natui: host reported unknown platform "${ready.platform}"`);
    }
    const expected = EXPECTED_PLATFORM[process.platform];
    if (expected && ready.platform !== expected) {
      throw new Error(
        `natui: host reported platform "${ready.platform}" but this OS requires "${expected}"`,
      );
    }
  } catch (err) {
    // Don't leak an incompatible or half-started host process.
    bridge.dispose('startup failed');
    // quit() already sent a protocol shutdown and installed a kill backstop.
    // Preserve that clean path when cancellation happened before ready.
    if (!startupCancellation) transport.close();
    throw startupCancellation ?? err;
  }

  phase = 'running';
  renderer = createManagedNatuiRenderer(bridge, { onUncaughtError, runWork });

  const handleWindowClose = () => {
    if (!startupComplete) {
      // run() is about to reject with this error. Still notify onClose (the
      // caller asked to hear about window closes), but never take the default
      // exit branch: process.exit(0) would race that rejection and kill the
      // process with a *success* code while the caller is still handling it.
      startupCloseError ??= new Error('natui: host closed during application startup');
      renderer?.cancelPendingRender(startupCloseError);
      onClose?.();
      return;
    }
    if (onClose) onClose();
    else {
      quit();
      // Give the quit message a beat to reach the host before exiting.
      setTimeout(() => process.exit(0), 250);
    }
  };
  try {
    bridge.onWindowClose(() => {
      if (runWork) runWork(handleWindowClose);
      else handleWindowClose();
    });
    if (startupCloseError) throw startupCloseError;

    bridge.sendWindow(windowProps);
    if (startupCloseError) throw startupCloseError;

    // Resolve once the initial tree is actually committed (and thus flushed).
    await renderer.renderAsync(element);
    if (startupCloseError) throw startupCloseError;
    startupComplete = true;
  } catch (error) {
    quit();
    throw error;
  }

  return {
    dump: () => bridge.requestDump(),
    screenshot: (path) => bridge.requestScreenshot(path),
    emit: (id, name, payload) => bridge.emitDebugEvent(id, name, payload),
    edit: (id, value) => bridge.editDebugValue(id, value),
    update: (el) => renderer.renderAsync(el),
    quit,
  };
}
