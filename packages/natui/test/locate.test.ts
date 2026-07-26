/**
 * Host-binary discovery. `defaultHostCommand` is publicly exported and is the
 * first thing every user hits, but nothing exercised its env override, its
 * unsupported-platform branch, or its not-found message.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { defaultHostCommand } from '../src/bridge/locate.js';

/**
 * A temp directory whose path matches what `process.cwd()` will report. On
 * macOS `/var/folders` is a symlink to `/private/var/folders`, so chdir'ing
 * into a raw mkdtemp path and reading cwd back gives a different string.
 */
function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function withCwd<T>(directory: string, work: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return work();
  } finally {
    process.chdir(previous);
  }
}

function withEnv<T>(key: string, value: string | undefined, work: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return work();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test('NATUI_HOST wins over any discovered binary', () => {
  withEnv('NATUI_HOST', '/custom/host-binary', () => {
    assert.deepEqual(defaultHostCommand(), { cmd: '/custom/host-binary' });
  });
});

test('a planted build is found by walking up from the working directory', (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no candidate layout for this platform');
    return;
  }
  const root = tempRoot('natui-locate-');
  const relative =
    process.platform === 'darwin'
      ? join('hosts', 'macos', '.build', 'release', 'natui-host')
      : join(
          'hosts',
          'windows',
          'NatuiHost',
          'bin',
          'Release',
          'net8.0-windows10.0.19041.0',
          'win-x64',
          'NatuiHost.exe',
        );
  const planted = join(root, relative);
  mkdirSync(dirname(planted), { recursive: true });
  writeFileSync(planted, '');

  // Start two directories deeper so the upward walk is what finds it.
  const nested = join(root, 'examples', 'demo');
  mkdirSync(nested, { recursive: true });

  withEnv('NATUI_HOST', undefined, () => {
    withCwd(nested, () => {
      assert.equal(defaultHostCommand().cmd, planted);
    });
  });
});

test('an arm64 Windows build is found even though it is not a literal candidate', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only layout');
    return;
  }
  const root = tempRoot('natui-locate-arm-');
  const planted = join(
    root,
    'hosts',
    'windows',
    'NatuiHost',
    'bin',
    'ARM64',
    'Release',
    'net8.0-windows10.0.19041.0',
    'win-arm64',
    'NatuiHost.exe',
  );
  mkdirSync(dirname(planted), { recursive: true });
  writeFileSync(planted, '');

  withEnv('NATUI_HOST', undefined, () => {
    withCwd(root, () => {
      assert.equal(defaultHostCommand().cmd, planted);
    });
  });
});

test('a checkout with no build reports that the host has not been built', (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no candidate layout for this platform');
    return;
  }
  const root = tempRoot('natui-locate-empty-');
  mkdirSync(join(root, 'hosts'), { recursive: true });

  withEnv('NATUI_HOST', undefined, () => {
    withCwd(root, () => {
      assert.throws(() => defaultHostCommand(), /has not been built yet/);
    });
  });
});
