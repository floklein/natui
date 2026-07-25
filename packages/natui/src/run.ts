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
import { createNatuiRenderer } from './reconciler/renderer.js';

export interface RunOptions extends WindowProps {
  /** Host binary override; defaults to NATUI_HOST env or the in-repo build. */
  host?: string | HostCommand;
  /** Called when the user closes the window. Default: unmount and exit. */
  onClose?: () => void;
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
  update(element: ReactNode): void;
  /** Unmount, quit the host, close the transport. */
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
  const { host, onClose, readyTimeoutMs, ...windowProps } = options;

  const hostCmd: HostCommand =
    typeof host === 'string' ? { cmd: host } : (host ?? defaultHostCommand());

  const transport = spawnStdioTransport(hostCmd);
  // The Bridge subscribes immediately: no message can fall between the
  // handshake and regular operation.
  const bridge = new Bridge(transport);

  let phase: 'starting' | 'running' | 'quitting' = 'starting';
  transport.onExit((code) => {
    // Rejects the pending ready waiter (startup) and any dump/shot waiters.
    bridge.hostExited(code);
    if (phase !== 'running') return; // startup throws / quit() is intentional
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
    transport.close();
    throw err;
  }

  phase = 'running';
  const renderer = createNatuiRenderer(bridge);

  const quit = () => {
    phase = 'quitting';
    renderer.unmount();
    bridge.quit();
    bridge.dispose('quit() was called');
    setTimeout(() => transport.close(), 200).unref?.();
  };

  bridge.onWindowClose(() => {
    if (onClose) onClose();
    else {
      quit();
      // Give the quit message a beat to reach the host before exiting.
      setTimeout(() => process.exit(0), 250);
    }
  });

  bridge.sendWindow(windowProps);
  // Resolve once the initial tree is actually committed (and thus flushed).
  await new Promise<void>((resolve) => renderer.render(element, resolve));

  return {
    dump: () => bridge.requestDump(),
    screenshot: (path) => bridge.requestScreenshot(path),
    emit: (id, name, payload) => bridge.emitDebugEvent(id, name, payload),
    edit: (id, value) => bridge.editDebugValue(id, value),
    update: (el) => renderer.render(el),
    quit,
  };
}
