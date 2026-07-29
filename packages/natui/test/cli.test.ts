/**
 * CLI argument handling. `natui dev` is the first command every user runs, and
 * none of its failure modes were covered: usage errors printed a Node stack
 * trace, and an unrecognized flag was silently resolved as an entry path.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PACKAGE_ROOT, 'src', 'cli.ts');

async function natui(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: PACKAGE_ROOT },
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
  assert.match(stdout, /Usage: natui dev \[entry\]/);
});

test('--help prints usage and succeeds', async () => {
  const { code, stdout } = await natui(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: natui dev \[entry\]/);
});

test('an unknown command reports the command and shows usage, without a stack', async () => {
  const { code, stderr } = await natui(['bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command "bogus"/);
  assert.match(stderr, /Usage: natui dev \[entry\]/);
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
  assert.match(stderr, /Usage: natui dev \[entry\]/);
});
