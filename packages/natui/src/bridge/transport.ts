import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { InboundMessage, OutboundMessage } from '../protocol.js';

/**
 * A bidirectional NDJSON channel to a native host process.
 * `stdio` (default): we spawn the host and speak over its stdin/stdout.
 * `tcp`: we listen on 127.0.0.1, spawn the host with `--tcp <port>`, and it
 * connects back. Useful on Windows where GUI-subsystem stdio can be awkward.
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

interface Channels {
  write(line: string): void;
  child: ChildProcess;
  server?: Server;
  socket?: Socket;
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

  constructor(private channels: Channels) {
    channels.child.on('exit', (code) => {
      if (!this.closed) this.exitCb(code);
    });
  }

  handleMessage(msg: InboundMessage): void {
    if (msg.t === 'log') {
      const fn = msg.level === 'error' ? console.error : console.warn;
      fn(`[natui host] ${msg.message}`);
      return;
    }
    this.messageCb?.(msg);
  }

  bufferOrHandle(msg: InboundMessage): void {
    if (this.messageCb === undefined) this.buffered.push(msg);
    else this.handleMessage(msg);
  }

  send(msg: OutboundMessage): void {
    if (this.closed) return;
    this.channels.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: InboundMessage) => void): void {
    this.messageCb = cb;
    for (const msg of this.buffered.splice(0)) this.handleMessage(msg);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  close(): void {
    this.closed = true;
    this.channels.socket?.destroy();
    this.channels.server?.close();
    if (!this.channels.child.killed) this.channels.child.kill();
  }
}

/** Spawn the host and talk NDJSON over its stdin/stdout. */
export function spawnStdioTransport(host: HostCommand): Transport {
  const child = spawn(host.cmd, host.args ?? [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // A commit racing host shutdown must not crash Node with EPIPE.
  child.stdin!.on('error', () => {});
  const transport = new HostTransport({
    child,
    write: (line) => {
      if (child.stdin?.writable) child.stdin.write(line);
    },
  });
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => parseLine(line, (m) => transport.bufferOrHandle(m)));
  return transport;
}

/**
 * Listen on an ephemeral local port, spawn the host with `--tcp <port>`,
 * and speak NDJSON over the socket the host opens back to us.
 */
export async function spawnTcpTransport(host: HostCommand): Promise<Transport> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('natui: failed to bind TCP port for host transport');
  }
  const port = address.port;

  const child = spawn(host.cmd, [...(host.args ?? []), '--tcp', String(port)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let socket: Socket | undefined;
  const pending: string[] = [];
  const channels: Channels = {
    child,
    server,
    write: (line) => {
      if (socket) socket.write(line);
      else pending.push(line);
    },
  };
  const transport = new HostTransport(channels);

  server.on('connection', (sock) => {
    // Exactly one connection, ours is the host we spawned. Anything else on
    // this port would be able to inject protocol messages (events firing app
    // handlers), so stop listening the moment the host connects.
    if (socket) {
      sock.destroy();
      return;
    }
    socket = sock;
    channels.socket = sock;
    server.close();
    sock.on('error', () => {});
    for (const line of pending.splice(0)) sock.write(line);
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on('line', (line) => parseLine(line, (m) => transport.bufferOrHandle(m)));
  });

  return transport;
}
