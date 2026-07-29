import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_APP_VERSION = '0.1.0';

async function json(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8'));
}

const manifests = new Map([
  ['package.json', await json('package.json')],
  ['packages/natui/package.json', await json('packages/natui/package.json')],
  ['packages/natui-dev/package.json', await json('packages/natui-dev/package.json')],
  [
    'packages/create-natui-app/package.json',
    await json('packages/create-natui-app/package.json'),
  ],
  ['examples/demo/package.json', await json('examples/demo/package.json')],
  ['examples/kitchen-sink/package.json', await json('examples/kitchen-sink/package.json')],
  ['docs/package.json', await json('docs/package.json')],
  ['examples/demo/natui.app.json', await json('examples/demo/natui.app.json')],
  ['examples/kitchen-sink/natui.app.json', await json('examples/kitchen-sink/natui.app.json')],
]);

const version = manifests.get('packages/natui/package.json').version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'natui package version must be semantic');

for (const [path, manifest] of manifests) {
  assert.equal(manifest.version, version, `${path} version must be ${version}`);
}

const DOCUMENTATION_SOURCES = ['README.md', 'docs/content'];
const ARTIFACT_VERSION_LITERALS = [
  /[A-Za-z0-9_.-]*-\d+\.\d+\.\d+-(?:windows|macos)-(?:x64|arm64)\S*/,
  /[A-Za-z0-9_.-]*-\d+\.\d+\.\d+\.tgz/,
];

async function documentationFiles(relativePath) {
  const info = await stat(resolve(root, relativePath));
  if (!info.isDirectory()) return /\.mdx?$/.test(relativePath) ? [relativePath] : [];
  const entries = await readdir(resolve(root, relativePath), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => documentationFiles(`${relativePath}/${entry.name}`)),
  );
  return nested.flat();
}

for (const source of DOCUMENTATION_SOURCES) {
  for (const relativePath of await documentationFiles(source)) {
    const lines = (await readFile(resolve(root, relativePath), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const pattern of ARTIFACT_VERSION_LITERALS) {
        const match = pattern.exec(line);
        assert.equal(
          match,
          null,
          `${relativePath}:${index + 1} hardcodes the artifact version literal `
            + `"${match?.[0]}"; use a <version> placeholder so docs survive a release bump`,
        );
      }
    });
  }
}

const packageManifest = manifests.get('packages/natui/package.json');
assert.equal(packageManifest.license, 'MIT');
assert.equal(packageManifest.publishConfig?.access, 'public');
assert.equal(
  packageManifest.repository?.url,
  'git+https://github.com/floklein/natui.git',
  'repository URL must match the GitHub repository used for npm provenance',
);

const createPackageManifest = manifests.get('packages/create-natui-app/package.json');
assert.equal(createPackageManifest.license, 'MIT');
assert.equal(createPackageManifest.publishConfig?.access, 'public');
assert.equal(
  createPackageManifest.repository?.url,
  'git+https://github.com/floklein/natui.git',
  'create-natui-app repository URL must match the GitHub repository used for npm provenance',
);
assert.equal(
  createPackageManifest.repository?.directory,
  'packages/create-natui-app',
  'create-natui-app repository directory must identify its workspace package',
);
assert.equal(
  createPackageManifest.bin?.['create-natui-app'],
  './bin/create-natui-app.js',
  'create-natui-app must map its executable to bin/create-natui-app.js',
);
const createBinSource = await readFile(
  resolve(root, 'packages/create-natui-app/bin/create-natui-app.js'),
  'utf8',
);
assert.match(
  createBinSource,
  /^#!\/usr\/bin\/env node\r?\n/,
  'create-natui-app executable must start with the portable Node shebang',
);

const createTemplateManifest = JSON.parse(
  (
    await readFile(
      resolve(root, 'packages/create-natui-app/template/package.json.tmpl'),
      'utf8',
    )
  ).replace('__PACKAGE_NAME_JSON__', JSON.stringify('release-check')),
);
assert.equal(
  createTemplateManifest.version,
  GENERATED_APP_VERSION,
  `create-natui-app template version must be ${GENERATED_APP_VERSION}`,
);
assert.equal(
  createTemplateManifest.dependencies?.['@natui/core'],
  `^${version}`,
  `create-natui-app template must depend on @natui/core@^${version}`,
);
assert.equal(
  createTemplateManifest.devDependencies?.['@natui/dev'],
  `^${version}`,
  `create-natui-app template must devDepend on @natui/dev@^${version}; `
    + 'without it the generated project cannot run `natui dev`',
);
const createTemplateConfig = JSON.parse(
  (
    await readFile(
      resolve(root, 'packages/create-natui-app/template/natui.app.json.tmpl'),
      'utf8',
    )
  )
    .replace('__APP_ID_JSON__', JSON.stringify('dev.example.releasecheck'))
    .replace('__DISPLAY_NAME_JSON__', JSON.stringify('Release Check'))
    .replace('__EXECUTABLE_JSON__', JSON.stringify('ReleaseCheck')),
);
assert.equal(
  createTemplateConfig.version,
  GENERATED_APP_VERSION,
  `create-natui-app config template version must be ${GENERATED_APP_VERSION}`,
);

const requestedTag =
  process.argv[2] ??
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
if (requestedTag) {
  assert.equal(requestedTag, `v${version}`, `release tag must be v${version}`);
}

// Windows runs npm-cli.js under the current Node rather than spawning npm.cmd:
// the shim needs an elevated shell on the maintainer's nvm-windows setup and
// fails with "Access denied" otherwise. Keep the explicit path.
const npm =
  process.platform === 'win32'
    ? {
        command: process.execPath,
        arguments: [
          resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        ],
      }
    : { command: 'npm', arguments: [] };

function packDryRun(relativeDirectory) {
  const packed = spawnSync(
    npm.command,
    [...npm.arguments, 'pack', '--dry-run', '--json'],
    {
      cwd: resolve(root, relativeDirectory),
      encoding: 'utf8',
    },
  );

  if (packed.error) throw packed.error;
  assert.equal(
    packed.status,
    0,
    packed.stderr || `npm pack failed in ${relativeDirectory}`,
  );
  const output = JSON.parse(packed.stdout);
  assert.equal(output.length, 1, `npm pack must produce one tarball in ${relativeDirectory}`);
  return output[0];
}

const coreTarball = packDryRun('packages/natui');
assert.equal(coreTarball.name, '@natui/core');
assert.equal(coreTarball.version, version);
assert.equal(coreTarball.filename, `natui-core-${version}.tgz`);

const files = new Set(coreTarball.files.map(({ path }) => path.replaceAll('\\', '/')));
const requiredFiles = [
  'LICENSE',
  'README.md',
  'app-config.d.ts',
  'app-config.js',
  'bin/natui.js',
  'dist/cli.js',
  'dist/components.d.ts',
  'dist/components.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/inproc.d.ts',
  'dist/inproc.js',
  'dist/internal.d.ts',
  'dist/internal.js',
  'package.json',
];

for (const path of requiredFiles) {
  assert(files.has(path), `release tarball is missing ${path}`);
}

// The build toolchain must not ride along with the runtime package; that is
// the whole point of @natui/dev being separate.
const CORE_FORBIDDEN_DEPENDENCIES = ['@babel/core', 'rollup', 'esbuild', 'react-refresh'];
const corePackage = manifests.get('packages/natui/package.json');
for (const name of CORE_FORBIDDEN_DEPENDENCIES) {
  assert(
    corePackage.dependencies?.[name] === undefined,
    `@natui/core must not depend on ${name}; it belongs to @natui/dev`,
  );
}

const devTarball = packDryRun('packages/natui-dev');
assert.equal(devTarball.name, '@natui/dev');
assert.equal(devTarball.version, version);
const devFiles = new Set(devTarball.files.map(({ path }) => path.replaceAll('\\', '/')));
for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/server.js', 'package.json']) {
  assert(devFiles.has(path), `@natui/dev tarball is missing ${path}`);
}

const createTarball = packDryRun('packages/create-natui-app');
assert.equal(createTarball.name, 'create-natui-app');
assert.equal(createTarball.version, version);
assert.equal(createTarball.filename, `create-natui-app-${version}.tgz`);

const createFiles = createTarball.files
  .map(({ path }) => path.replaceAll('\\', '/'))
  .sort();
const expectedCreateFiles = [
  'LICENSE',
  'README.md',
  'bin/create-natui-app.js',
  'package.json',
  'src/icons.mjs',
  'src/index.mjs',
  'template/_gitignore',
  'template/natui.app.json.tmpl',
  'template/package.json.tmpl',
  'template/pnpm-workspace.yaml',
  'template/README.md.tmpl',
  'template/src/App.tsx',
  'template/src/main.tsx.tmpl',
  'template/tsconfig.json',
].sort();
assert.deepEqual(
  createFiles,
  expectedCreateFiles,
  'create-natui-app release tarball contents must match the reviewed package surface',
);

function assertIndexedExecutable(relativePath) {
  const indexedBin = spawnSync(
    'git',
    ['ls-files', '--stage', '--', relativePath],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (indexedBin.error) throw indexedBin.error;
  assert.equal(indexedBin.status, 0, indexedBin.stderr || 'git ls-files failed');
  const indexedEntry = indexedBin.stdout.trim();
  assert.notEqual(
    indexedEntry,
    '',
    `${relativePath} is untracked; run git add --chmod=+x ${relativePath}`,
  );
  assert.match(
    indexedEntry,
    /^100755 /,
    `${relativePath} must be executable in the git index; `
      + `run git add --chmod=+x ${relativePath}`,
  );
}

assertIndexedExecutable('packages/natui/bin/natui.js');
assertIndexedExecutable('packages/create-natui-app/bin/create-natui-app.js');

const packageDirectory = resolve(root, 'packages/natui');
const exportsSmoke = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    "await Promise.all([import('@natui/core'), import('@natui/core/components'), import('@natui/core/inproc'), import('@natui/core/internal'), import('@natui/core/config')]);",
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
assert.match(cliSmoke.stdout, /natui\.app\.json/);

const createPackageDirectory = resolve(root, 'packages/create-natui-app');
const createHelpSmoke = spawnSync(
  process.execPath,
  ['bin/create-natui-app.js', '--help'],
  {
    cwd: createPackageDirectory,
    encoding: 'utf8',
  },
);
if (createHelpSmoke.error) throw createHelpSmoke.error;
assert.equal(
  createHelpSmoke.status,
  0,
  createHelpSmoke.stderr || 'create-natui-app CLI help failed',
);
assert.match(
  createHelpSmoke.stdout,
  /^Usage: create-natui-app \[project-directory\] \[options\]/,
);
assert.match(createHelpSmoke.stdout, /--no-install/);

const createVersionSmoke = spawnSync(
  process.execPath,
  ['bin/create-natui-app.js', '--version'],
  {
    cwd: createPackageDirectory,
    encoding: 'utf8',
  },
);
if (createVersionSmoke.error) throw createVersionSmoke.error;
assert.equal(
  createVersionSmoke.status,
  0,
  createVersionSmoke.stderr || 'create-natui-app CLI version failed',
);
assert.equal(createVersionSmoke.stdout.trim(), version);

console.log(
  `Verified @natui/core@${version} (${coreTarball.entryCount} files, ${coreTarball.size} packed bytes) and ` +
    `create-natui-app@${version} (${createTarball.entryCount} files, ${createTarball.size} packed bytes).`,
);
