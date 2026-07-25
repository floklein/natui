import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createBundleManifest,
  renderMacInfoPlist,
  validateAppConfig,
} from './package-app.mjs';

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

test('application config resolves safe project-relative paths', () => {
  const config = validateAppConfig(valid, path.resolve('fixture-app'));
  assert.equal(config.id, 'dev.example.ship');
  assert.equal(config.entry, 'src/main.tsx');
  assert.equal(config.executable, 'ShipIt');
  assert.ok(config.entryPath.endsWith(path.join('src', 'main.tsx')));
  assert.ok(config.outputPath.endsWith(path.join('dist', 'package')));
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
