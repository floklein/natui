import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJavaScript } from '../../../tools/package-app.mjs';

if (process.platform !== 'win32') {
  console.error('[verify-runtime-failure] Windows-only probe skipped');
  process.exit(0);
}

const demoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const repoRoot = path.resolve(demoRoot, '../..');
const hostCandidates = [
  'hosts/windows/NatuiHost/bin/x64/Release/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe',
  'hosts/windows/NatuiHost/bin/x64/Debug/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe',
];
const host = hostCandidates
  .map((candidate) => path.join(repoRoot, candidate))
  .find(existsSync);
assert.ok(host, 'Windows NatUI host is not built');

const fixture = await mkdtemp(path.join(demoRoot, '.natui-runtime-failure-'));
const entry = path.join(fixture, 'main.tsx');
const bundle = path.join(fixture, 'bundle.js');

try {
  await writeFile(entry, "throw new Error('packaged entry failure probe');\n", 'utf8');
  await buildJavaScript({ entryPath: entry, root: fixture }, bundle);

  const child = spawn(host, ['--bundle', bundle], {
    cwd: fixture,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime failure probe timed out\n${output}`));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.equal(exitCode, 1, output);
  assert.match(output, /embedded runtime failed/i);
  assert.match(output, /packaged entry failure probe/);
  console.error('[verify-runtime-failure] fatal entry path verified with exit code 1');
} finally {
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}
