/**
 * Startup handshake validation, against fake hosts implemented as small
 * `node -e` scripts. No GUI, runs on every platform.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import {
  run,
  runWithController,
  type NatuiAppController,
} from '../src/run.js';
import { Text } from '../src/components.js';

/**
 * A fake host that prints `ready` and, when told to quit, optionally writes
 * a marker file before exiting 0, so tests can distinguish a processed quit
 * message from the transport's SIGTERM backstop.
 */
function fakeHost(
  ready: Record<string, unknown>,
  quitMarkerPath?: string,
): { cmd: string; args: string[] } {
  const marker = quitMarkerPath ? JSON.stringify(quitMarkerPath) : 'null';
  const script = `
    const readline = require('node:readline');
    process.stdout.write(JSON.stringify(${JSON.stringify(ready)}) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      try {
        if (JSON.parse(line).t === 'quit') {
          const marker = ${marker};
          if (marker) require('node:fs').writeFileSync(marker, 'quit');
          process.exit(0);
        }
      } catch {}
    });
  `;
  return { cmd: process.execPath, args: ['-e', script] };
}

function silentFakeHost(quitMarkerPath: string): { cmd: string; args: string[] } {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      try {
        if (JSON.parse(line).t === 'quit') {
          require('node:fs').writeFileSync(${JSON.stringify(quitMarkerPath)}, 'quit');
          process.exit(0);
        }
      } catch {}
    });
  `;
  return { cmd: process.execPath, args: ['-e', script] };
}

const element = createElement(Text, null, 'hi');

const thisPlatform = process.platform === 'win32' ? 'windows' : 'macos';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('handshake success: matching protocol and platform mounts and quits cleanly', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'natui-run-test-')), 'quit-received');
  const app = await run(element, {
    host: fakeHost(
      { t: 'ready', platform: thisPlatform, protocol: 1, hostApi: 1 },
      marker,
    ),
    readyTimeoutMs: 5000,
  });
  assert.deepEqual(
    Object.keys(app).sort(),
    ['dump', 'edit', 'emit', 'quit', 'screenshot', 'update'],
  );
  app.quit();
  // Prove the host received the quit MESSAGE and exited on its own; the
  // transport's kill() backstop (SIGTERM at 200ms) must not be what ends it.
  for (let i = 0; i < 40 && !existsSync(marker); i++) await sleep(50);
  assert.ok(existsSync(marker), 'host processed the quit message (clean shutdown, not SIGTERM)');
});

test('handshake rejects a protocol version mismatch and terminates the host', async () => {
  await assert.rejects(
    run(element, {
      host: fakeHost({ t: 'ready', platform: thisPlatform, protocol: 99 }),
      readyTimeoutMs: 5000,
    }),
    /host speaks protocol v99 but this renderer requires v1/,
  );
});

test('handshake rejects a host API older than the renderer requires', async () => {
  await assert.rejects(
    run(element, {
      host: fakeHost({
        t: 'ready',
        platform: thisPlatform,
        protocol: 1,
        hostApi: 0,
      }),
      readyTimeoutMs: 5000,
    }),
    /requires host API v1 or newer/,
  );
});

test('handshake rejects an unknown platform', async () => {
  await assert.rejects(
    run(element, {
      host: fakeHost({ t: 'ready', platform: 'beos', protocol: 1, hostApi: 1 }),
      readyTimeoutMs: 5000,
    }),
    /unknown platform "beos"/,
  );
});

test('handshake rejects the wrong platform for this OS', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const wrong = process.platform === 'darwin' ? 'windows' : 'macos';
  await assert.rejects(
    run(element, {
      host: fakeHost({ t: 'ready', platform: wrong, protocol: 1, hostApi: 1 }),
      readyTimeoutMs: 5000,
    }),
    /but this OS requires/,
  );
});

test('handshake times out when the host never sends ready', async () => {
  const silent = { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] };
  await assert.rejects(
    run(element, { host: silent, readyTimeoutMs: 250 }),
    /did not send ready within 250ms/,
  );
});

test('handshake fails fast when the host exits before ready', async () => {
  const dying = { cmd: process.execPath, args: ['-e', 'process.exit(3)'] };
  await assert.rejects(
    run(element, { host: dying, readyTimeoutMs: 5000 }),
    /host exited \(code 3\)/,
  );
});

test('the early controller cancels startup and terminates a host before ready', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'natui-run-test-')), 'quit-received');
  const cancellation = new Error('test canceled before ready');
  let controller: NatuiAppController | undefined;
  const starting = runWithController(
    element,
    {
      host: silentFakeHost(marker),
      readyTimeoutMs: 5000,
    },
    (value) => {
      controller = value;
    },
  );

  assert.ok(controller, 'the lifecycle controller is available synchronously');
  controller.cancelPendingUpdate(cancellation);
  await assert.rejects(starting, (error) => error === cancellation);
  for (let i = 0; i < 40 && !existsSync(marker); i++) await sleep(50);
  assert.ok(existsSync(marker), 'the host processed quit during startup cancellation');
});

test('the early controller rejects a suspended initial render with the exact reason', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'natui-run-test-')), 'quit-received');
  const cancellation = new Error('test canceled suspended render');
  const never = new Promise<never>(() => {});
  let renderStarted = false;
  let controller: NatuiAppController | undefined;
  function Suspended(): never {
    renderStarted = true;
    throw never;
  }

  const starting = runWithController(
    createElement(Suspended),
    {
      host: fakeHost(
        { t: 'ready', platform: thisPlatform, protocol: 1, hostApi: 1 },
        marker,
      ),
      readyTimeoutMs: 5000,
    },
    (value) => {
      controller = value;
    },
  );
  for (let i = 0; i < 100 && !renderStarted; i++) await sleep(10);
  assert.ok(renderStarted, 'the initial React render reached the suspended component');
  assert.ok(controller);

  controller.cancelPendingUpdate(cancellation);
  await assert.rejects(starting, (error) => error === cancellation);
  for (let i = 0; i < 40 && !existsSync(marker); i++) await sleep(50);
  assert.ok(existsSync(marker), 'the host processed quit after render cancellation');
});
