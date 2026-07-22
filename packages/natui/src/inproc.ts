/**
 * In-process entry point (Stage 2): the native host embeds a JS engine
 * (JavaScriptCore on macOS) and evaluates the app bundle directly. There is
 * no child process and no stdio; messages cross the boundary as plain
 * function calls:
 *
 *   JS -> host: the host injects a global `__natui_send(json)` function.
 *   host -> JS: this module registers a global `__natui_recv(json)` function.
 *
 * This file must stay free of Node built-ins so it bundles for a bare engine
 * (esbuild --platform=browser). It deliberately does not import run.ts.
 */
import type { ReactNode } from 'react';
import { Bridge } from './bridge/bridge.js';
import type { Transport } from './bridge/transport.js';
import type { InboundMessage, OutboundMessage, WindowProps } from './protocol.js';
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

  constructor() {
    const g = globalThis as NatuiGlobals;
    if (typeof g.__natui_send !== 'function') {
      throw new Error(
        'natui/inproc: no embedding host detected (__natui_send is missing). ' +
          'Run this bundle inside the natui host with --bundle.',
      );
    }
    this.hostSend = g.__natui_send;
    g.__natui_recv = (line) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(line) as InboundMessage;
      } catch {
        console.error(`natui/inproc: bad message from host: ${line.slice(0, 200)}`);
        return;
      }
      if (this.messageCb) this.messageCb(msg);
      else this.buffered.push(msg);
    };
  }

  send(msg: OutboundMessage): void {
    this.hostSend(JSON.stringify(msg));
  }

  onMessage(cb: (msg: InboundMessage) => void): void {
    this.messageCb = cb;
    for (const msg of this.buffered.splice(0)) cb(msg);
  }

  onExit(): void {
    // The host owns our lifetime; there is no exit event to observe.
  }

  close(): void {}
}

export type RunEmbeddedOptions = WindowProps;

/** Render a React element inside an embedding native host. */
export async function runEmbedded(
  element: ReactNode,
  options: RunEmbeddedOptions = {},
): Promise<void> {
  const transport = new InProcTransport();

  await new Promise<void>((resolve) => {
    transport.onMessage((msg) => {
      if (msg.t === 'ready') resolve();
    });
  });

  const bridge = new Bridge(transport);
  const renderer = createNatuiRenderer(bridge);
  bridge.onWindowClose(() => {
    renderer.unmount();
    bridge.quit();
  });

  bridge.sendWindow(options);
  await new Promise<void>((resolve) => renderer.render(element, resolve));
}
