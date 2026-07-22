// Quick protocol smoke test: handshake, window, one commit, dump, screenshot, quit.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'bin/x64/Debug/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe');
const shotPath = join(here, 'smoke-shot.png');

const host = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
host.stderr.on('data', (d) => process.stderr.write(`[host-stderr] ${d}`));

let buffer = '';
const pending = [];
host.stdout.on('data', (d) => {
  buffer += d;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) pending.push(JSON.parse(line));
  }
});

const next = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for host message')), 15000);
    const poll = () => {
      if (pending.length) {
        clearTimeout(timer);
        resolve(pending.shift());
      } else setTimeout(poll, 20);
    };
    poll();
  });

const send = (obj) => host.stdin.write(JSON.stringify(obj) + '\n');

const ready = await next();
console.log('ready:', JSON.stringify(ready));
if (ready.t !== 'ready' || ready.platform !== 'windows' || ready.protocol !== 1) {
  throw new Error('bad handshake');
}

send({ t: 'window', props: { title: 'smoke', width: 320, height: 200 } });
send({
  t: 'commit',
  ops: [
    { op: 'create', id: 1, kind: 'VStack', props: { spacing: 8, padding: 16 } },
    { op: 'create', id: 2, kind: 'Text', props: { font: 'title' } },
    { op: 'createText', id: 3, text: 'hello from smoke test' },
    { op: 'append', parent: 2, child: 3 },
    { op: 'append', parent: 1, child: 2 },
    { op: 'append', parent: 0, child: 1 },
  ],
});
send({ t: 'dump' });
const tree = await next();
console.log('tree:', JSON.stringify(tree));
if (tree.t !== 'tree') throw new Error('expected tree reply');

send({ t: 'screenshot', path: shotPath });
const shot = await next();
console.log('shot:', JSON.stringify(shot));

send({ t: 'quit' });
const code = await new Promise((r) => host.on('exit', r));
console.log('exit code:', code);
console.log('SMOKE OK');
