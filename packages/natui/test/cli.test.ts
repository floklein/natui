/**
 * CLI argument handling. `natui dev` is the first command every user runs, and
 * none of its failure modes were covered: usage errors printed a Node stack
 * trace, and an unrecognized flag was silently resolved as an entry path.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PACKAGE_ROOT, 'src', 'cli.ts');
// An absolute specifier keeps the loader resolvable from any working
// directory the test picks.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

async function natui(
  args: string[],
  env?: Record<string, string>,
  cwd: string = PACKAGE_ROOT,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', TSX, CLI, ...args],
      { cwd, env: env ? { ...process.env, ...env } : undefined },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

test('no arguments prints usage and succeeds', async () => {
  const { code, stdout } = await natui([]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: natui <command>/);
});

test('--help prints usage and succeeds', async () => {
  const { code, stdout } = await natui(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: natui <command>/);
});

test('an unknown command reports the command and shows usage, without a stack', async () => {
  const { code, stderr } = await natui(['bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command "bogus"/);
  assert.match(stderr, /Usage: natui <command>/);
  assert.doesNotMatch(stderr, /at ModuleJob|at async|\.ts:\d+:\d+/);
});

test('an unknown option is rejected instead of being treated as the entry path', async () => {
  const { code, stderr } = await natui(['dev', '--watch']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown option "--watch"/);
  assert.doesNotMatch(stderr, /at ModuleJob|at async/);
});

test('an unknown option after an entry is also rejected', async () => {
  const { code, stderr } = await natui(['dev', 'src/main.tsx', '--port']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown option "--port"/);
});

test('a second positional argument is reported as unexpected', async () => {
  const { code, stderr } = await natui(['dev', 'a.tsx', 'b.tsx']);
  assert.equal(code, 1);
  assert.match(stderr, /unexpected argument "b.tsx"/);
  assert.match(stderr, /Usage: natui <command>/);
});

test('host path prints the resolved executable', async () => {
  const { code, stdout } = await natui(['host', 'path'], {
    NATUI_HOST: '/custom/host-binary',
  });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '/custom/host-binary');
});

test('host without an action explains the choices', async () => {
  const { code, stderr } = await natui(['host']);
  assert.equal(code, 1);
  assert.match(stderr, /"host" needs an action: install or path/);
});

test('an unknown host action is rejected', async () => {
  const { code, stderr } = await natui(['host', 'bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown host action "bogus"/);
});

test('host install rejects unknown options before touching the network', async () => {
  const { code, stderr } = await natui(['host', 'install', '--offline']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown option "--offline"/);
});

test('host path without any host prints guidance, not a stack', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no host resolution on this platform');
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), 'natui-cli-nohost-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'natui-cli-nocache-'));
  const { code, stderr } = await natui(
    ['host', 'path'],
    { NATUI_HOST: '', NATUI_HOST_CACHE_DIR: cacheDir },
    workDir,
  );
  assert.equal(code, 1);
  assert.match(stderr, /host binary not found/);
  assert.doesNotMatch(stderr, /at ModuleJob|at async|\.ts:\d+:\d+/);
});
