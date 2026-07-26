import assert from 'node:assert/strict';
import test from 'node:test';
import { useEffect } from 'react';
import { Text } from '../src/components.js';
import {
  assertEmbeddedRuntimeStarted,
  deferEmbeddedRuntimeFailure,
  prepareEmbeddedRuntime,
  runEmbedded,
} from '../src/inproc.js';
import type { OutboundMessage } from '../src/protocol.js';

interface EmbeddingGlobals {
  __natui_send?: (line: string) => void;
  __natui_recv?: (line: string) => void;
}

const globals = globalThis as EmbeddingGlobals;

async function startEmbedded(
  options: Parameters<typeof runEmbedded>[1] = {},
) {
  const sent: OutboundMessage[] = [];
  globals.__natui_send = (line) => {
    sent.push(JSON.parse(line) as OutboundMessage);
  };
  const pending = runEmbedded(<Text>Hello</Text>, {
    readyTimeoutMs: 1_000,
    ...options,
  });

  for (let index = 0; index < 20 && !globals.__natui_recv; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const receive = globals.__natui_recv;
  assert.ok(receive, 'embedded transport installed its receive hook');
  receive(JSON.stringify({
    t: 'ready',
    platform: 'windows',
    protocol: 1,
    hostApi: 2,
  }));
  return { app: await pending, sent, receive };
}

function resetEmbeddingGlobals() {
  delete globals.__natui_send;
  delete globals.__natui_recv;
}

test('embedded controller updates, unmounts once, and quits idempotently', async () => {
  let cleanups = 0;
  function App({ label }: { label: string }) {
    useEffect(() => () => {
      cleanups += 1;
    }, []);
    return <Text>{label}</Text>;
  }

  try {
    const sent: OutboundMessage[] = [];
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    const pending = runEmbedded(<App label="one" />, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.__natui_recv!(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));
    const app = await pending;
    assert.equal(app.platform, 'windows');
    assert.equal(app.state, 'running');

    app.update(<App label="two" />);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    app.quit();
    app.quit();

    assert.equal(app.state, 'stopped');
    assert.equal(cleanups, 1, 'React effect cleanup ran exactly once');
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(globals.__natui_recv, undefined, 'receive hook was detached');
    assert.throws(() => app.update(<Text>late</Text>), /stopping or stopped/);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a prepared embedded runtime buffers ready while the entry initializes', async () => {
  const sent: OutboundMessage[] = [];
  try {
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    prepareEmbeddedRuntime();
    const receive = globals.__natui_recv;
    assert.ok(receive, 'packaging bootstrap installs the receive hook synchronously');

    receive(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const app = await runEmbedded(<Text>Delayed entry</Text>, { readyTimeoutMs: 1_000 });
    assert.equal(app.platform, 'windows');
    assert.ok(sent.some((message) => message.t === 'window'));
    app.quit();
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a prepared embedded runtime preserves a native close while the entry initializes', async () => {
  const sent: OutboundMessage[] = [];
  let closeCalls = 0;
  try {
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    prepareEmbeddedRuntime();
    const receive = globals.__natui_recv;
    assert.ok(receive, 'packaging bootstrap installs the receive hook synchronously');

    receive(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));
    receive(JSON.stringify({ t: 'window', name: 'close' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      runEmbedded(<Text>Delayed entry</Text>, {
        onClose: () => {
          closeCalls += 1;
        },
        readyTimeoutMs: 1_000,
      }),
      /closed during application startup/,
    );
    assert.equal(closeCalls, 1);
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a prepared embedded runtime leaves startup failures for the host fatal path', async () => {
  const sent: OutboundMessage[] = [];
  const originalConsoleError = console.error;

  function BrokenApp(): never {
    throw new Error('packaged initial render exploded');
  }

  try {
    console.error = () => {};
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    prepareEmbeddedRuntime();
    const receive = globals.__natui_recv;
    assert.ok(receive);

    const pending = runEmbedded(<BrokenApp />, { readyTimeoutMs: 1_000 });
    receive(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));

    await assert.rejects(pending, /packaged initial render exploded/);
    assert.equal(
      sent.filter((message) => message.t === 'quit').length,
      0,
      'normal quit must not cancel the packaging bootstrap fatal timer',
    );
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    console.error = originalConsoleError;
    resetEmbeddingGlobals();
  }
});

test('an asynchronous entry failure is rethrown from a host timer callback', () => {
  const originalSetTimeout = globalThis.setTimeout;
  let scheduled: (() => void) | undefined;
  try {
    globalThis.setTimeout = ((callback: () => void) => {
      scheduled = callback;
      return 1;
    }) as unknown as typeof setTimeout;
    deferEmbeddedRuntimeFailure(new Error('entry exploded'));
    assert.ok(scheduled);
    assert.throws(scheduled, /entry exploded/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a prepared entry must call run before it finishes', () => {
  try {
    globals.__natui_send = () => {};
    prepareEmbeddedRuntime();
    assert.throws(
      () => assertEmbeddedRuntimeStarted(),
      /application entry completed without calling run/,
    );
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('native window close runs the callback and the same shutdown path', async () => {
  let closeCalls = 0;
  try {
    const { app, sent, receive } = await startEmbedded({
      onClose: () => {
        closeCalls += 1;
      },
    });
    receive(JSON.stringify({ t: 'window', name: 'close' }));
    receive(JSON.stringify({ t: 'window', name: 'close' }));

    assert.equal(closeCalls, 1, 'closed transport drops duplicate native requests');
    assert.equal(app.state, 'stopped');
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a synchronous close during window setup never mounts React afterward', async () => {
  let mounts = 0;
  let cleanups = 0;
  const sent: OutboundMessage[] = [];

  function App() {
    useEffect(() => {
      mounts += 1;
      return () => {
        cleanups += 1;
      };
    }, []);
    return <Text>Hello</Text>;
  }

  try {
    globals.__natui_send = (line) => {
      const message = JSON.parse(line) as OutboundMessage;
      sent.push(message);
      if (message.t === 'window') {
        globals.__natui_recv!(JSON.stringify({ t: 'window', name: 'close' }));
      }
    };
    const pending = runEmbedded(<App />, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.__natui_recv!(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));

    await assert.rejects(pending, /closed during application startup/);
    assert.equal(mounts, 0);
    assert.equal(cleanups, 0);
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(sent.filter((message) => message.t === 'commit').length, 0);
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a native close after the first commit still rejects pending startup', async () => {
  const sent: OutboundMessage[] = [];
  let closeScheduled = false;
  try {
    globals.__natui_send = (line) => {
      const message = JSON.parse(line) as OutboundMessage;
      sent.push(message);
      if (message.t === 'commit' && !closeScheduled) {
        closeScheduled = true;
        const receive = globals.__natui_recv;
        setTimeout(() => {
          receive?.(JSON.stringify({ t: 'window', name: 'close' }));
        }, 0);
      }
    };
    const pending = runEmbedded(<Text>Hello</Text>, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.__natui_recv!(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));

    await assert.rejects(pending, /closed during application startup/);
    assert.ok(
      sent.some((message) => message.t === 'commit'),
      'the initial tree committed before the native close',
    );
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a second embedded application cannot replace the active receive hook', async () => {
  try {
    globals.__natui_send = () => {};
    const firstPending = runEmbedded(<Text>First</Text>, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const firstReceive = globals.__natui_recv;
    assert.ok(firstReceive);

    await assert.rejects(
      runEmbedded(<Text>Second</Text>, { readyTimeoutMs: 1_000 }),
      /already active/,
    );
    assert.equal(globals.__natui_recv, firstReceive);

    firstReceive(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));
    const first = await firstPending;
    first.quit();
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('embedded startup incompatibility asks the host to quit and detaches', async () => {
  const sent: OutboundMessage[] = [];
  try {
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    const pending = runEmbedded(<Text>Hello</Text>, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.__natui_recv!(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 0,
    }));

    await assert.rejects(pending, /requires host API v2 or newer/);
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(globals.__natui_recv, undefined);
  } finally {
    resetEmbeddingGlobals();
  }
});

test('a fatal initial render rejects startup, quits, and detaches', async () => {
  const sent: OutboundMessage[] = [];
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;

  function BrokenApp(): never {
    throw new Error('initial render exploded');
  }

  try {
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    globals.__natui_send = (line) => {
      sent.push(JSON.parse(line) as OutboundMessage);
    };
    const pending = runEmbedded(<BrokenApp />, { readyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.__natui_recv!(JSON.stringify({
      t: 'ready',
      platform: 'windows',
      protocol: 1,
      hostApi: 2,
    }));

    await assert.rejects(pending, /initial render exploded/);
    assert.equal(sent.filter((message) => message.t === 'commit').length, 0);
    assert.equal(sent.filter((message) => message.t === 'quit').length, 1);
    assert.equal(globals.__natui_recv, undefined);
    assert.ok(
      logged.some((args) => args.some((value) => String(value).includes('initial render exploded'))),
      'the initial React error was still logged',
    );
  } finally {
    console.error = originalConsoleError;
    resetEmbeddingGlobals();
  }
});

test('a fatal render after startup is logged without changing controller state', async () => {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;

  function BrokenApp(): never {
    throw new Error('update render exploded');
  }

  try {
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const { app } = await startEmbedded();
    app.update(<BrokenApp />);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    assert.equal(app.state, 'running');
    assert.ok(
      logged.some((args) => args.some((value) => String(value).includes('update render exploded'))),
      'the post-start React error was logged',
    );
    app.quit();
  } finally {
    console.error = originalConsoleError;
    resetEmbeddingGlobals();
  }
});
