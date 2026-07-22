import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { InboundMessage, OutboundMessage } from '../protocol.js';

/**
 * A bidirectional NDJSON channel to a native host process, over the host's
 * stdin/stdout (we spawn the host and pipe both ends). This is the only
 * supported transport; see docs/protocol.md.
 */
export interface Transport {
  send(msg: OutboundMessage): void;
  onMessage(cb: (msg: InboundMessage) => void): void;
  onExit(cb: (code: number | null) => void): void;
  close(): void;
}

export interface HostCommand {
  cmd: string;
  args?: string[];
}

function parseLine(line: string, onMessage: (msg: InboundMessage) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: InboundMessage;
  try {
    msg = JSON.parse(trimmed) as InboundMessage;
  } catch {
    // Anything non-JSON on the protocol channel is host noise; surface it.
    console.error(`[natui host] ${trimmed}`);
    return;
  }
  onMessage(msg);
}

class HostTransport implements Transport {
  private messageCb: ((msg: InboundMessage) => void) | undefined;
  private exitCb: (code: number | null) => void = () => {};
  private buffered: InboundMessage[] = [];
  private closed = false;

  constructor(
    private child: ChildProcess,
    private write: (line: string) => void,
  ) {
    child.on('exit', (code) => {
      if (!this.closed) this.exitCb(code);
    });
    // Spawn failures (e.g. host binary missing) emit 'error' with no 'exit';
    // surface them as an exit so startup fails fast instead of timing out.
    child.on('error', (err) => {
      console.error(`[natui] failed to start host: ${err.message}`);
      if (!this.closed) this.exitCb(null);
    });
  }

  bufferOrHandle(msg: InboundMessage): void {
    if (this.messageCb === undefined) this.buffered.push(msg);
    else this.messageCb(msg);
  }

  send(msg: OutboundMessage): void {
    if (this.closed) return;
    this.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: InboundMessage) => void): void {
    this.messageCb = cb;
    for (const msg of this.buffered.splice(0)) cb(msg);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  close(): void {
    this.closed = true;
    if (!this.child.killed) this.child.kill();
  }
}

/** Spawn the host and talk NDJSON over its stdin/stdout. */
export function spawnStdioTransport(host: HostCommand): Transport {
  const child = spawn(host.cmd, host.args ?? [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // A commit racing host shutdown must not crash Node with EPIPE.
  child.stdin!.on('error', () => {});
  const transport = new HostTransport(child, (line) => {
    if (child.stdin?.writable) child.stdin.write(line);
  });
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => parseLine(line, (m) => transport.bufferOrHandle(m)));
  return transport;
}
