/**
 * Package a built native host into the release archive that
 * `@natui/core` downloads at runtime (see packages/natui/src/bridge/
 * host-cache.ts, which pins the asset naming this script must match).
 *
 * Usage: node tools/package-host.mjs <target> [--input <path>]
 *   target: macos-universal | windows-x64 | windows-arm64
 *
 * Writes dist-host/natui-host-<version>-<target>.tar.gz and a sibling
 * .sha256 file, and prints both paths.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(REPO_ROOT, 'dist-host');

const TARGETS = new Set(['macos-universal', 'windows-x64', 'windows-arm64']);

function fail(message) {
  console.error(`package-host: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [target, ...rest] = argv;
  if (!target || !TARGETS.has(target)) {
    fail(`expected a target (${[...TARGETS].join(' | ')}), got "${target ?? ''}"`);
  }
  let input;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--input') {
      input = rest[i + 1];
      if (!input) fail('--input needs a path');
      i += 1;
    } else {
      fail(`unknown argument "${rest[i]}"`);
    }
  }
  return { target, input };
}

/** Newest match wins, mirroring the dev-time probe in locate.ts. */
function newestMatch(pattern) {
  let newest;
  for (const match of globSync(pattern, { cwd: REPO_ROOT })) {
    const full = join(REPO_ROOT, match);
    const { mtimeMs } = statSync(full);
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest?.path;
}

/**
 * Resolve what goes into the archive: for macOS the single host binary, for
 * Windows the whole self-contained build folder.
 */
function resolveInput(target, override) {
  if (override) {
    const full = resolve(override);
    if (!existsSync(full)) fail(`--input path does not exist: ${full}`);
    return full;
  }
  if (target === 'macos-universal') {
    // tools/build-host-macos-universal.mjs writes the universal binary
    // under .build/apple; a plain release build is a single-arch fallback for
    // local experiments and gets a loud warning.
    const universal = join(
      REPO_ROOT,
      'hosts/macos/.build/apple/Products/Release/natui-host',
    );
    if (existsSync(universal)) return universal;
    const singleArch = join(REPO_ROOT, 'hosts/macos/.build/release/natui-host');
    if (existsSync(singleArch)) {
      console.error(
        'package-host: WARNING: using a single-architecture macOS build; ' +
          'release archives must come from: node tools/build-host-macos-universal.mjs',
      );
      return singleArch;
    }
    fail('no macOS host build found under hosts/macos/.build');
  }
  const rid = target === 'windows-x64' ? 'win-x64' : 'win-arm64';
  const exe = newestMatch(
    `hosts/windows/NatuiHost/bin/**/Release/**/${rid}/NatuiHost.exe`,
  );
  if (!exe) fail(`no Release ${rid} build found under hosts/windows/NatuiHost/bin`);
  return dirname(exe);
}

function systemTar() {
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

function createArchive(target, input, archivePath) {
  // Archive contents are rooted so extraction lands the executable at the
  // top level, which is what host-cache.ts checks for.
  const args =
    target === 'macos-universal'
      ? ['-czf', archivePath, '-C', dirname(input), 'natui-host']
      : ['-czf', archivePath, '-C', input, '.'];
  const result = spawnSync(systemTar(), args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`tar exited with ${result.status}`);
}

const { target, input: inputOverride } = parseArgs(process.argv.slice(2));
const { version } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const input = resolveInput(target, inputOverride);

mkdirSync(OUTPUT_DIR, { recursive: true });
const assetName = `natui-host-${version}-${target}.tar.gz`;
const archivePath = join(OUTPUT_DIR, assetName);
rmSync(archivePath, { force: true });
createArchive(target, input, archivePath);

const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
const checksumPath = `${archivePath}.sha256`;
writeFileSync(checksumPath, `${digest}  ${assetName}\n`);

console.log(archivePath);
console.log(checksumPath);
