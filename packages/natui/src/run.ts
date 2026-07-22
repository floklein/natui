import type { ReactNode } from 'react';
import { Bridge } from './bridge/bridge.js';
import { defaultHostCommand } from './bridge/locate.js';
import {
  type HostCommand,
  type Transport,
  spawnStdioTransport,
  spawnTcpTransport,
} from './bridge/transport.js';
import type { TreeNode, WindowProps } from './protocol.js';
import { createNatuiRenderer } from './reconciler/renderer.js';

export interface RunOptions extends WindowProps {
  /** Host binary override; defaults to NATUI_HOST env or the in-repo build. */
  host?: string | HostCommand;
  /** 'stdio' (default) or 'tcp' (Windows fallback; see docs/protocol.md). */
  transport?: 'stdio' | 'tcp';
  /** Called when the user closes the window. Default: unmount and exit. */
  onClose?: () => void;
}

export interface NatuiApp {
  /** Debug: ask the host for its current native tree. */
  dump(): Promise<TreeNode>;
  /** Debug: host renders its window content to a PNG at `path`. */
  screenshot(path: string): Promise<string>;
  /** Debug: make the host synthesize a user event on node `id`. */
  emit(id: number, name: string, payload?: Record<string, unknown>): void;
  /** Re-render with a new element (e.g. for external hot reload). */
  update(element: ReactNode): void;
  /** Unmount, quit the host, close the transport. */
  quit(): void;
}

const READY_TIMEOUT_MS = 10_000;

function waitForReady(transport: Transport): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('natui: host did not send ready within 10s')),
      READY_TIMEOUT_MS,
    );
    transport.onMessage((msg) => {
      if (msg.t === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
    transport.onExit((code) => {
      clearTimeout(timer);
      reject(new Error(`natui: host exited before ready (code ${code})`));
    });
  });
}

/** Render a React element into a native window. Resolves once mounted. */
export async function run(element: ReactNode, options: RunOptions = {}): Promise<NatuiApp> {
  const { host, transport: transportKind, onClose, ...windowProps } = options;

  const hostCmd: HostCommand =
    typeof host === 'string' ? { cmd: host } : (host ?? defaultHostCommand());

  const transport =
    transportKind === 'tcp' ? await spawnTcpTransport(hostCmd) : spawnStdioTransport(hostCmd);

  try {
    await waitForReady(transport);
  } catch (err) {
    // Don't leak a spawned host (which would also keep Node alive).
    transport.close();
    throw err;
  }

  // The Bridge takes over the message stream from here.
  const bridge = new Bridge(transport);
  const renderer = createNatuiRenderer(bridge);

  let expectingExit = false;
  const quit = () => {
    expectingExit = true;
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

  transport.onExit((code) => {
    bridge.dispose(`host exited (code ${code})`);
    if (expectingExit) return; // intentional shutdown: let the caller finish
    if (code !== 0 && code !== null) {
      console.error(`[natui] host exited with code ${code}`);
    }
    process.exit(code ?? 0);
  });

  bridge.sendWindow(windowProps);
  // Resolve once the initial tree is actually committed (and thus flushed).
  await new Promise<void>((resolve) => renderer.render(element, resolve));

  return {
    dump: () => bridge.requestDump(),
    screenshot: (path) => bridge.requestScreenshot(path),
    emit: (id, name, payload) => bridge.emitDebugEvent(id, name, payload),
    update: (el) => renderer.render(el),
    quit,
  };
}
