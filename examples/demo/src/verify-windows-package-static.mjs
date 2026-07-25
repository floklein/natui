import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('the Windows package inspection must run on Windows');
}

const exampleDirectory = fileURLToPath(new URL('..', import.meta.url));
const expectedName = 'NatUIDemo-0.1.0-windows-x64.exe';
const packageDirectory = path.join(exampleDirectory, 'dist', 'package');
const artifact = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(packageDirectory, expectedName);

assert.equal(
  path.basename(artifact),
  expectedName,
  `expected the release artifact to be named ${expectedName}`,
);

const artifactInfo = await stat(artifact);
assert.ok(artifactInfo.isFile(), 'Windows package artifact must be a file');
assert.ok(
  artifactInfo.size > 10 * 1024 * 1024,
  'Windows package is too small to contain the self-contained runtime',
);

const packageEntries = await readdir(path.dirname(artifact), { withFileTypes: true });
assert.deepEqual(
  packageEntries.map((entry) => entry.name).sort(),
  [expectedName],
  'the distributable directory must contain one EXE and no runtime sidecars',
);

const bytes = await readFile(artifact);
assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ', 'artifact is not a Windows PE file');

const peOffset = bytes.readUInt32LE(0x3c);
assert.ok(peOffset > 0 && peOffset + 24 < bytes.length, 'PE header offset is invalid');
assert.deepEqual(
  [...bytes.subarray(peOffset, peOffset + 4)],
  [0x50, 0x45, 0x00, 0x00],
  'PE signature is invalid',
);
assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, 'artifact is not an x64 executable');

const optionalHeader = peOffset + 24;
assert.equal(bytes.readUInt16LE(optionalHeader), 0x20b, 'artifact is not a PE32+ executable');
assert.equal(
  bytes.readUInt16LE(optionalHeader + 68),
  2,
  'artifact must use the Windows GUI subsystem',
);

// The .NET app host contains this fixed marker. The eight bytes immediately
// before it point to the bundle header appended near the end of the executable.
const bundleMarker = Buffer.from(
  '8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae',
  'hex',
);
const markerOffset = bytes.indexOf(bundleMarker);
assert.ok(markerOffset >= 8, '.NET single-file bundle marker is missing');

const headerOffsetValue = bytes.readBigUInt64LE(markerOffset - 8);
assert.ok(
  headerOffsetValue <= BigInt(Number.MAX_SAFE_INTEGER),
  'bundle header offset exceeds JavaScript integer precision',
);
const headerOffset = Number(headerOffsetValue);
assert.ok(
  headerOffset > markerOffset && headerOffset + 12 < bytes.length,
  'bundle header offset is outside the executable',
);

const bundleMajorVersion = bytes.readUInt32LE(headerOffset);
const bundledFileCount = bytes.readUInt32LE(headerOffset + 8);
assert.ok(bundleMajorVersion >= 6, `unsupported .NET bundle version ${bundleMajorVersion}`);
assert.ok(bundledFileCount > 20, 'self-contained bundle contains too few files');

// These names are read from the bundle file table, after the header. Checking
// them catches SDK changes that leave a required native or PRI file as an
// unshipped sidecar even though dotnet publish itself succeeded.
const requiredBundleEntries = [
  'NatUIDemo.dll',
  'NatUIDemo.deps.json',
  'NatUIDemo.runtimeconfig.json',
  'ClearScript.Core.dll',
  'ClearScript.V8.dll',
  'ClearScript.V8.ICUData.dll',
  'ClearScriptV8.win-x64.dll',
  'Microsoft.WindowsAppRuntime.dll',
  'Microsoft.ui.xaml.dll',
  'Microsoft.UI.Xaml.Controls.pri',
  'Microsoft.WinUI.dll',
  'resources.pri',
];
for (const entry of requiredBundleEntries) {
  assert.notEqual(
    bytes.indexOf(Buffer.from(entry, 'utf8'), headerOffset),
    -1,
    `single-file bundle is missing ${entry}`,
  );
}

console.log(
  `Windows package verified without launching: ${path.basename(artifact)} `
    + `(${artifactInfo.size} bytes, ${bundledFileCount} bundled files)`,
);
