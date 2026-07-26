import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMacIcon } from '../../../tools/package-app.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const demoDirectory = fileURLToPath(new URL('..', import.meta.url));
const demoConfig = path.join(demoDirectory, 'natui.app.json');
const defaultApp = fileURLToPath(new URL('../dist/package/NatUIDemo.app', import.meta.url));

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseStringPlist(source) {
  const values = new Map();
  for (const match of source.matchAll(
    /<key>\s*([^<]*?)\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/gs,
  )) {
    values.set(decodeXml(match[1].trim()), decodeXml(match[2].trim()));
  }
  return values;
}

async function assertDirectory(directory, expectedEntries, label) {
  const info = await stat(directory);
  assert.ok(info.isDirectory(), `${label} must be a directory`);
  const entries = await readdir(directory);
  assert.deepEqual(entries.sort(), [...expectedEntries].sort(), `${label} layout is invalid`);
}

async function assertRegularFile(file, label) {
  const info = await stat(file);
  assert.ok(info.isFile(), `${label} must be a regular file`);
  return info;
}

function executableArchitecture(bytes) {
  assert.ok(bytes.length >= 8, 'packaged executable is empty');
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'packaged executable is not 64-bit Mach-O');
  const cpuType = bytes.readUInt32LE(4);
  if (cpuType === 0x01000007) return 'x64';
  if (cpuType === 0x0100000c) return 'arm64';
  throw new Error(`packaged executable has unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

let demoConfigCache;

// The packaged version is whatever natui.app.json declared at package time, so
// read it from there instead of repeating the literal in the expectations.
async function readDemoConfig() {
  demoConfigCache ??= JSON.parse(await readFile(demoConfig, 'utf8'));
  return demoConfigCache;
}

async function configuredMacIconPath() {
  const config = await readDemoConfig();
  assert.equal(
    typeof config.icons?.macos,
    'string',
    'natui.app.json must configure icons.macos',
  );
  return path.resolve(demoDirectory, config.icons.macos);
}

export async function verifyMacPackage(appPath = defaultApp, {
  expectedArchitecture = process.arch,
  expectedIconPath,
  expectedVersion,
  enforceExecutableMode = process.platform !== 'win32',
  lintPlist = process.platform === 'darwin',
} = {}) {
  const version = expectedVersion ?? (await readDemoConfig()).version;
  const absoluteApp = path.resolve(appPath);
  assert.equal(path.basename(absoluteApp), 'NatUIDemo.app', 'package must be NatUIDemo.app');

  const contents = path.join(absoluteApp, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const natuiResources = path.join(resources, 'NatUI');
  await assertDirectory(absoluteApp, ['Contents'], 'application bundle');
  await assertDirectory(contents, ['Info.plist', 'MacOS', 'Resources'], 'Contents');
  await assertDirectory(macos, ['NatUIDemo'], 'Contents/MacOS');
  await assertDirectory(resources, ['AppIcon.icns', 'LICENSE.txt', 'NatUI'], 'Contents/Resources');
  await assertDirectory(
    natuiResources,
    ['main.js', 'manifest.json'],
    'Contents/Resources/NatUI',
  );

  const executable = path.join(macos, 'NatUIDemo');
  const executableInfo = await assertRegularFile(executable, 'packaged executable');
  if (enforceExecutableMode) {
    assert.notEqual(
      executableInfo.mode & 0o111,
      0,
      'packaged executable has no executable permission bit',
    );
  }
  const executableBytes = await readFile(executable);
  assert.equal(
    executableArchitecture(executableBytes),
    expectedArchitecture,
    'Mach-O architecture does not match the current runner',
  );

  const infoPlist = path.join(contents, 'Info.plist');
  await assertRegularFile(infoPlist, 'Info.plist');
  if (lintPlist) {
    await execFileAsync('/usr/bin/plutil', ['-lint', infoPlist]);
  }
  const plist = parseStringPlist(await readFile(infoPlist, 'utf8'));
  const expectedPlist = {
    CFBundleDisplayName: 'NatUI Demo',
    CFBundleExecutable: 'NatUIDemo',
    CFBundleIconFile: 'AppIcon',
    CFBundleIdentifier: 'dev.natui.demo',
    CFBundleName: 'NatUI Demo',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: '1',
    LSMinimumSystemVersion: '14.0',
  };
  for (const [key, expected] of Object.entries(expectedPlist)) {
    assert.equal(plist.get(key), expected, `Info.plist ${key} is invalid`);
  }

  const packagedIconPath = path.join(resources, 'AppIcon.icns');
  await assertRegularFile(packagedIconPath, 'packaged macOS icon');
  const packagedIcon = await readFile(packagedIconPath);
  const icon = inspectMacIcon(packagedIcon);
  assert.deepEqual(
    icon.sizes,
    [16, 32, 64, 128, 256, 512, 1024],
    'packaged macOS icon representation set is incomplete',
  );
  const configuredIcon = await readFile(expectedIconPath ?? await configuredMacIconPath());
  assert.deepEqual(
    packagedIcon,
    configuredIcon,
    'packaged AppIcon.icns differs from the configured icon',
  );

  const manifestPath = path.join(natuiResources, 'manifest.json');
  const entryPath = path.join(natuiResources, 'main.js');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, expectedPlist.CFBundleIdentifier);
  assert.equal(manifest.name, expectedPlist.CFBundleDisplayName);
  assert.equal(manifest.version, expectedPlist.CFBundleShortVersionString);
  assert.equal(manifest.buildNumber, expectedPlist.CFBundleVersion);
  assert.equal(manifest.entry, 'main.js');
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.minHostApi, 2);
  assert.equal(manifest.platform, 'macos');
  assert.equal(manifest.architecture, expectedArchitecture);
  assert.match(manifest.entrySha256, /^[a-f0-9]{64}$/);

  const entry = await readFile(entryPath);
  const entrySha256 = createHash('sha256').update(entry).digest('hex');
  assert.equal(manifest.entrySha256, entrySha256, 'main.js SHA-256 does not match the manifest');

  const packagedLicense = await readFile(path.join(resources, 'LICENSE.txt'));
  const repositoryLicense = await readFile(path.join(repoRoot, 'LICENSE'));
  assert.deepEqual(packagedLicense, repositoryLicense, 'packaged LICENSE differs from the repository');

  return {
    appPath: absoluteApp,
    architecture: expectedArchitecture,
    entryBytes: entry.length,
    iconSizes: icon.sizes,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await verifyMacPackage(process.argv[2] ?? defaultApp);
  console.log(
    `macOS package verified without launching: ${path.basename(result.appPath)} `
      + `(${result.architecture}, ${result.entryBytes} JavaScript bytes)`,
  );
}
