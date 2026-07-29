/**
 * Startup handshake validation, against fake hosts implemented as small
 * `node -e` scripts. No GUI, runs on every platform.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function closingFakeHost(messageLogPath: string): { cmd: string; args: string[] } {
  const script = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    process.stdout.write(
      JSON.stringify({
        t: 'ready',
        platform: ${JSON.stringify(thisPlatform)},
        protocol: 1,
        hostApi: 2,
      }) + '\\n' +
      JSON.stringify({ t: 'window', name: 'close' }) + '\\n'
    );
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(messageLogPath)}, JSON.stringify(message) + '\\n');
        if (message.t === 'quit') process.exit(0);
      } catch {}
    });
  `;
  return { cmd: process.execPath, args: ['-e', script] };
}

function closeAfterWindowFakeHost(
  messageLogPath: string,
  renderMarkerPath: string,
): { cmd: string; args: string[] } {
  const script = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    process.stdout.write(JSON.stringify({
      t: 'ready',
      platform: ${JSON.stringify(thisPlatform)},
      protocol: 1,
      hostApi: 2,
    }) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(messageLogPath)}, JSON.stringify(message) + '\\n');
        if (message.t === 'window') {
          const closeWhenRenderingStarts = () => {
            if (fs.existsSync(${JSON.stringify(renderMarkerPath)})) {
              process.stdout.write(JSON.stringify({ t: 'window', name: 'close' }) + '\\n');
            } else {
              setTimeout(closeWhenRenderingStarts, 5);
            }
          };
          closeWhenRenderingStarts();
        }
        if (message.t === 'quit') process.exit(0);
      } catch {}
    });
  `;
  return { cmd: process.execPath, args: ['-e', script] };
}

const element = createElement(Text, null, 'hi');

const thisPlatform = process.platform === 'win32' ? 'windows' : 'macos';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function assertLoggedMessageTypes(
  messageLogPath: string,
  expected: string[],
): Promise<void> {
  let actual: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(messageLogPath)) {
      actual = readFileSync(messageLogPath, 'utf8')
        .split('\n')
        .slice(0, -1)
        .map((line) => (JSON.parse(line) as { t: string }).t);
      if (actual.length >= expected.length) break;
    }
    await sleep(50);
  }
  assert.deepEqual(actual, expected);
}

test('handshake success: matching protocol and platform mounts and quits cleanly', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'natui-run-test-')), 'quit-received');
  const app = await run(element, {
    host: fakeHost(
      { t: 'ready', platform: thisPlatform, protocol: 1, hostApi: 2 },
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

test('a buffered native close rejects startup before sending the window or rendering', async () => {
  const messageLog = join(mkdtempSync(join(tmpdir(), 'natui-run-test-')), 'messages');
  let closeCalls = 0;
  let renders = 0;

  function App() {
    renders += 1;
    return createElement(Text, null, 'never mounted');
  }

  const starting = run(createElement(App), {
    host: closingFakeHost(messageLog),
    onClose() {
      closeCalls += 1;
    },
    readyTimeoutMs: 5000,
  }).then((app) => {
    app.quit();
    throw new Error('startup resolved after the native close');
  });

  await assert.rejects(starting, /host closed during application startup/);

  await assertLoggedMessageTypes(messageLog, ['quit']);
  assert.equal(closeCalls, 1);
  assert.equal(renders, 0);
});

test('a native close rejects an initial render that remains suspended', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'natui-run-test-'));
  const messageLog = join(temporary, 'messages');
  const renderMarker = join(temporary, 'render-started');
  const never = new Promise<never>(() => {});
  let closeCalls = 0;
  let controller: NatuiAppController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function Suspended(): never {
    writeFileSync(renderMarker, 'started');
    throw never;
  }

  const starting = runWithController(
    createElement(Suspended),
    {
      host: closeAfterWindowFakeHost(messageLog, renderMarker),
      onClose() {
        closeCalls += 1;
      },
      readyTimeoutMs: 5000,
    },
    (value) => {
      controller = value;
    },
  );
  const timeoutFailure = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller?.quit();
      reject(new Error('startup remained pending after the native close'));
    }, 3000);
  });

  try {
    await assert.rejects(
      Promise.race([starting, timeoutFailure]),
      /host closed during application startup/,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    controller?.quit();
  }

  assert.ok(existsSync(renderMarker), 'the initial render suspended before the host closed');
  await assertLoggedMessageTypes(messageLog, ['window', 'quit']);
  assert.equal(closeCalls, 1);
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
    /requires host API v2 or newer/,
  );
});

test('handshake rejects an unknown platform', async () => {
  await assert.rejects(
    run(element, {
      host: fakeHost({ t: 'ready', platform: 'beos', protocol: 1, hostApi: 2 }),
      readyTimeoutMs: 5000,
    }),
    /unknown platform "beos"/,
  );
});

test('handshake rejects the wrong platform for this OS', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const wrong = process.platform === 'darwin' ? 'windows' : 'macos';
  await assert.rejects(
    run(element, {
      host: fakeHost({ t: 'ready', platform: wrong, protocol: 1, hostApi: 2 }),
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
        { t: 'ready', platform: thisPlatform, protocol: 1, hostApi: 2 },
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
