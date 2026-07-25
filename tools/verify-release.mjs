import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function json(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8'));
}

const manifests = new Map([
  ['package.json', await json('package.json')],
  ['packages/natui/package.json', await json('packages/natui/package.json')],
  ['examples/demo/package.json', await json('examples/demo/package.json')],
  ['examples/kitchen-sink/package.json', await json('examples/kitchen-sink/package.json')],
  ['docs/package.json', await json('docs/package.json')],
  ['examples/demo/natui.app.json', await json('examples/demo/natui.app.json')],
]);

const version = manifests.get('packages/natui/package.json').version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'natui package version must be semantic');

for (const [path, manifest] of manifests) {
  assert.equal(manifest.version, version, `${path} version must be ${version}`);
}

const packageManifest = manifests.get('packages/natui/package.json');
assert.equal(packageManifest.license, 'MIT');
assert.equal(packageManifest.publishConfig?.access, 'public');
assert.equal(
  packageManifest.repository?.url,
  'https://github.com/floklein/natui.git',
  'repository URL must match the GitHub repository used for npm provenance',
);

const requestedTag =
  process.argv[2] ??
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
if (requestedTag) {
  assert.equal(requestedTag, `v${version}`, `release tag must be v${version}`);
}

const npm =
  process.platform === 'win32'
    ? {
        command: process.execPath,
        arguments: [
          resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        ],
      }
    : { command: 'npm', arguments: [] };
const packed = spawnSync(npm.command, [...npm.arguments, 'pack', '--dry-run', '--json'], {
  cwd: resolve(root, 'packages/natui'),
  encoding: 'utf8',
});

if (packed.error) throw packed.error;
assert.equal(packed.status, 0, packed.stderr || 'npm pack failed');

const [tarball] = JSON.parse(packed.stdout);
assert.equal(tarball.name, 'natui');
assert.equal(tarball.version, version);

const files = new Set(tarball.files.map(({ path }) => path.replaceAll('\\', '/')));
const requiredFiles = [
  'LICENSE',
  'README.md',
  'bin/natui.js',
  'dist/cli.js',
  'dist/components.d.ts',
  'dist/components.js',
  'dist/dev/index.d.ts',
  'dist/dev/index.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/inproc.d.ts',
  'dist/inproc.js',
  'package.json',
];

for (const path of requiredFiles) {
  assert(files.has(path), `release tarball is missing ${path}`);
}

const packageDirectory = resolve(root, 'packages/natui');
const exportsSmoke = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    "await Promise.all([import('natui'), import('natui/components'), import('natui/inproc'), import('natui/dev')]);",
  ],
  { cwd: packageDirectory, encoding: 'utf8' },
);
if (exportsSmoke.error) throw exportsSmoke.error;
assert.equal(exportsSmoke.status, 0, exportsSmoke.stderr || 'package exports failed to import');

const cliSmoke = spawnSync(process.execPath, ['bin/natui.js', '--help'], {
  cwd: packageDirectory,
  encoding: 'utf8',
});
if (cliSmoke.error) throw cliSmoke.error;
assert.equal(cliSmoke.status, 0, cliSmoke.stderr || 'natui CLI failed to start');
assert.match(cliSmoke.stdout, /^Usage: natui dev \[entry\]/);

console.log(
  `Verified natui@${version}: ${tarball.entryCount} files, ${tarball.size} packed bytes.`,
);
