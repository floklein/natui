import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyMacPackage } from './verify-macos-package-static.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'natui-macos-package-test-'));
  const app = path.join(root, 'NatUIDemo.app');
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const natui = path.join(resources, 'NatUI');
  await mkdir(macos, { recursive: true });
  await mkdir(natui, { recursive: true });

  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const executable = Buffer.alloc(8);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
  await writeFile(path.join(macos, 'NatUIDemo'), executable);

  await writeFile(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>NatUI Demo</string>
  <key>CFBundleExecutable</key><string>NatUIDemo</string>
  <key>CFBundleIdentifier</key><string>dev.natui.demo</string>
  <key>CFBundleName</key><string>NatUI Demo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict>
</plist>
`,
  );

  const entry = Buffer.from('globalThis.__natui_fixture = true;\n');
  await writeFile(path.join(natui, 'main.js'), entry);
  const manifest = {
    schemaVersion: 1,
    id: 'dev.natui.demo',
    name: 'NatUI Demo',
    version: '0.1.0',
    buildNumber: '1',
    entry: 'main.js',
    entrySha256: createHash('sha256').update(entry).digest('hex'),
    protocolVersion: 1,
    minHostApi: 1,
    platform: 'macos',
    architecture,
  };
  await writeFile(path.join(natui, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await copyFile(path.join(repoRoot, 'LICENSE'), path.join(resources, 'LICENSE.txt'));
  return { root, app, architecture, manifestPath: path.join(natui, 'manifest.json') };
}

test('macOS package verifier accepts the complete application layout', async () => {
  const fixture = await makeFixture();
  try {
    const result = await verifyMacPackage(fixture.app, {
      expectedArchitecture: fixture.architecture,
      enforceExecutableMode: false,
      lintPlist: false,
    });
    assert.equal(result.architecture, fixture.architecture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('macOS package verifier rejects an entry integrity mismatch', async () => {
  const fixture = await makeFixture();
  try {
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
    manifest.entrySha256 = '0'.repeat(64);
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      verifyMacPackage(fixture.app, {
        expectedArchitecture: fixture.architecture,
        enforceExecutableMode: false,
        lintPlist: false,
      }),
      /main\.js SHA-256 does not match/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
