import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBundleManifest,
  packageApplication,
  renderMacInfoPlist,
  validateAppConfig,
} from './package-app.mjs';

const appSchema = JSON.parse(
  await readFile(new URL('../schemas/natui-app.schema.json', import.meta.url), 'utf8'),
);
const bundleSchema = JSON.parse(
  await readFile(new URL('../schemas/natui-bundle.schema.json', import.meta.url), 'utf8'),
);

const valid = {
  schemaVersion: 1,
  id: 'dev.example.ship',
  name: 'Ship It',
  version: '1.2.3',
  buildNumber: '42',
  entry: 'src/main.tsx',
  executable: 'ShipIt',
  output: 'dist/package',
};

function schemaPatternAccepts(definition, value) {
  if (definition.minLength !== undefined && [...value].length < definition.minLength) {
    return false;
  }
  if (definition.maxLength !== undefined && [...value].length > definition.maxLength) {
    return false;
  }
  return definition.pattern === undefined || new RegExp(definition.pattern, 'u').test(value);
}

async function makeFilesystemFixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'natui-package-test-'));
  const app = path.join(temporary, 'app');
  const external = path.join(temporary, 'external');
  await mkdir(path.join(app, 'src'), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(path.join(app, 'src', 'main.tsx'), 'export {};\n', 'utf8');
  return { temporary, app, external };
}

async function writeConfig(directory, overrides = {}) {
  const configPath = path.join(directory, 'natui.app.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ ...valid, ...overrides }, null, 2)}\n`,
    'utf8',
  );
  return configPath;
}

async function createDirectoryLink(target, link) {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('application config resolves safe project-relative paths', () => {
  const config = validateAppConfig(valid, path.resolve('fixture-app'));
  assert.equal(config.id, 'dev.example.ship');
  assert.equal(config.entry, 'src/main.tsx');
  assert.equal(config.executable, 'ShipIt');
  assert.ok(config.entryPath.endsWith(path.join('src', 'main.tsx')));
  assert.ok(config.outputPath.endsWith(path.join('dist', 'package')));
  assert.equal(
    validateAppConfig({ ...valid, name: '😀'.repeat(80) }).name,
    '😀'.repeat(80),
  );
});

test('application config rejects unknown fields, traversal, and unsafe identity', () => {
  assert.throws(
    () => validateAppConfig({ ...valid, typo: true }),
    /unknown top-level property "typo"/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, entry: '../outside.tsx' }),
    /entry must stay inside/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, id: 'Example App' }),
    /lowercase reverse-DNS identifier/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, executable: 'Ship It' }),
    /executable must start with a letter/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, name: ' Ship It' }),
    /without outer whitespace/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, name: `Ship\u0001It` }),
    /not valid in XML 1\.0/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, name: '😀'.repeat(81) }),
    /80 characters or fewer/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, version: '65536.0.0' }),
    /65535 or lower/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, buildNumber: '65536' }),
    /1 through 65535/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, entry: 'src/../outside.tsx' }),
    /entry must stay inside/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, entry: 'D:main.tsx' }),
    /entry must be relative/,
  );
});

test('application and bundle schemas match runtime string constraints', () => {
  const name = appSchema.properties.name;
  const version = appSchema.properties.version;
  const buildNumber = appSchema.properties.buildNumber;
  const relativePath = appSchema.$defs.relativePath;

  for (const accepted of ['Ship It', 'Éditeur 😀', 'x'.repeat(80), '😀'.repeat(80)]) {
    assert.equal(schemaPatternAccepts(name, accepted), true, accepted);
  }
  for (const rejected of [
    ' Ship It',
    'Ship It ',
    `Ship\u0001It`,
    'x'.repeat(81),
    '😀'.repeat(81),
  ]) {
    assert.equal(schemaPatternAccepts(name, rejected), false, JSON.stringify(rejected));
  }

  for (const accepted of ['0.0.0', '1.2.3', '65535.00065535.42']) {
    assert.equal(schemaPatternAccepts(version, accepted), true, accepted);
  }
  for (const rejected of ['1.2', '65536.0.0', '1.2.99999']) {
    assert.equal(schemaPatternAccepts(version, rejected), false, rejected);
  }

  for (const accepted of ['1', '9999', '65535']) {
    assert.equal(schemaPatternAccepts(buildNumber, accepted), true, accepted);
  }
  for (const rejected of ['0', '01', '65536']) {
    assert.equal(schemaPatternAccepts(buildNumber, rejected), false, rejected);
  }

  for (const accepted of ['src/main.tsx', './src/main.tsx', 'dist\\package']) {
    assert.equal(schemaPatternAccepts(relativePath, accepted), true, accepted);
  }
  for (const rejected of [
    '.',
    '..',
    '../main.tsx',
    'src/../main.tsx',
    '/tmp/main.tsx',
    'C:\\tmp\\main.tsx',
    'D:main.tsx',
  ]) {
    assert.equal(schemaPatternAccepts(relativePath, rejected), false, rejected);
  }

  assert.equal(bundleSchema.properties.name.pattern, name.pattern);
  assert.equal(bundleSchema.properties.version.pattern, version.pattern);
  assert.equal(bundleSchema.properties.buildNumber.pattern, buildNumber.pattern);
  assert.equal(bundleSchema.properties.entry.const, 'main.js');
  assert.equal(bundleSchema.properties.protocolVersion.const, 1);
  assert.equal(bundleSchema.properties.minHostApi.const, 1);
});

test('generated bundle manifest is stable and carries compatibility gates', () => {
  const config = validateAppConfig(valid, path.resolve('fixture-app'));
  const manifest = createBundleManifest(config, {
    platform: 'windows',
    architecture: 'x64',
    entrySha256: 'a'.repeat(64),
  });
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    id: 'dev.example.ship',
    name: 'Ship It',
    version: '1.2.3',
    buildNumber: '42',
    entry: 'main.js',
    entrySha256: 'a'.repeat(64),
    protocolVersion: 1,
    minHostApi: 1,
    platform: 'windows',
    architecture: 'x64',
  });
});

test('macOS Info.plist contains native identity and escapes app metadata', () => {
  const config = validateAppConfig(
    { ...valid, name: 'Ship & Share', id: 'dev.example.ship-share' },
    path.resolve('fixture-app'),
  );
  const plist = renderMacInfoPlist(config, true);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>ShipIt<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.example\.ship-share<\/string>/);
  assert.match(plist, /<string>Ship &amp; Share<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>42<\/string>/);
});

test('packaging rejects entry, output, and icon junctions that escape the app', async (t) => {
  await t.test('entry junction', async () => {
    const fixture = await makeFilesystemFixture();
    try {
      const externalSource = path.join(fixture.external, 'source');
      await mkdir(externalSource, { recursive: true });
      await writeFile(path.join(externalSource, 'main.tsx'), 'export {};\n', 'utf8');
      await createDirectoryLink(externalSource, path.join(fixture.app, 'linked-source'));
      const configPath = await writeConfig(fixture.app, {
        entry: 'linked-source/main.tsx',
      });

      await assert.rejects(
        packageApplication({ configPath }),
        /entry must stay inside the application directory/,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  });

  await t.test('output junction with a missing leaf', async () => {
    const fixture = await makeFilesystemFixture();
    try {
      const externalOutput = path.join(fixture.external, 'output');
      await mkdir(externalOutput, { recursive: true });
      await createDirectoryLink(externalOutput, path.join(fixture.app, 'linked-output'));
      const configPath = await writeConfig(fixture.app, {
        output: 'linked-output/new-package-directory',
      });

      await assert.rejects(
        packageApplication({ configPath }),
        /output must stay inside the application directory/,
      );
      await assert.rejects(
        stat(path.join(externalOutput, 'new-package-directory')),
        /ENOENT/,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  });

  await t.test('icon junction', async () => {
    const fixture = await makeFilesystemFixture();
    try {
      const externalIcons = path.join(fixture.external, 'icons');
      await mkdir(externalIcons, { recursive: true });
      await writeFile(path.join(externalIcons, 'app.ico'), 'not-an-icon', 'utf8');
      await createDirectoryLink(externalIcons, path.join(fixture.app, 'linked-icons'));
      const configPath = await writeConfig(fixture.app, {
        icons: { windows: 'linked-icons/app.ico' },
      });

      await assert.rejects(
        packageApplication({ configPath }),
        /icons\.windows must stay inside the application directory/,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  });
});
