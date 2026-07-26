import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CONFIG_FILE,
  loadAppConfig,
  validateAppConfig,
} from '../app-config.js';

const validConfig = {
  schemaVersion: 1 as const,
  id: 'dev.example.hello',
  name: 'Hello NatUI',
  version: '0.1.0',
  buildNumber: '1',
  entry: 'src/main.tsx',
  executable: 'HelloNatUI',
  output: 'dist/package',
  icons: {
    macos: 'assets/AppIcon.icns',
    windows: 'assets/AppIcon.ico',
  },
};

test('NatUI app config resolves entry and platform icons from the config directory', () => {
  const root = path.resolve('fixtures', 'hello-app');
  const config = validateAppConfig(validConfig, root);

  assert.equal(config.entry, 'src/main.tsx');
  assert.equal(config.entryPath, path.join(root, 'src', 'main.tsx'));
  assert.equal(config.icons.macos, path.join(root, 'assets', 'AppIcon.icns'));
  assert.equal(config.icons.windows, path.join(root, 'assets', 'AppIcon.ico'));
});

test('NatUI app config resolves Windows separators consistently on every platform', () => {
  const root = path.resolve('fixtures', 'hello-app');
  const config = validateAppConfig(
    {
      ...validConfig,
      entry: 'src\\main.tsx',
      output: 'dist\\package',
      icons: {
        macos: 'assets\\AppIcon.icns',
        windows: 'assets\\AppIcon.ico',
      },
    },
    root,
  );

  assert.equal(config.entry, 'src/main.tsx');
  assert.equal(config.output, 'dist/package');
  assert.equal(config.entryPath, path.join(root, 'src', 'main.tsx'));
  assert.equal(config.outputPath, path.join(root, 'dist', 'package'));
  assert.equal(config.icons.macos, path.join(root, 'assets', 'AppIcon.icns'));
  assert.equal(config.icons.windows, path.join(root, 'assets', 'AppIcon.ico'));
});

test('NatUI app config loads from disk and can be optional for development', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'natui-config-test-'));
  try {
    await mkdir(path.join(temporary, 'src'), { recursive: true });
    const configPath = path.join(temporary, DEFAULT_CONFIG_FILE);
    await writeFile(configPath, `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');

    const config = await loadAppConfig(configPath);
    assert.equal(config?.root, temporary);
    assert.equal(config?.entryPath, path.join(temporary, 'src', 'main.tsx'));
    assert.equal(
      await loadAppConfig(path.join(temporary, 'missing.json'), { allowMissing: true }),
      undefined,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('NatUI app config reports malformed JSON and does not hide other read failures', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'natui-config-test-'));
  try {
    const invalidPath = path.join(temporary, DEFAULT_CONFIG_FILE);
    await writeFile(invalidPath, '{ nope', 'utf8');
    await assert.rejects(loadAppConfig(invalidPath), /natui config: cannot parse/);

    const directoryPath = path.join(temporary, 'not-a-file');
    await mkdir(directoryPath);
    await assert.rejects(
      loadAppConfig(directoryPath, { allowMissing: true }),
      /natui config: cannot read/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
