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
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  buildJavaScript,
  createBundleManifest,
  escapeMsbuildPropertyValue,
  inspectMacIcon,
  inspectWindowsIcon,
  packageApplication,
  renderMacInfoPlist,
  resolveOutputOverride,
  validateAppConfig,
} from './package-app.mjs';
import { writeDemoIcons } from './package-demo.mjs';

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

test('built bootstrap retains its deferred fatal entry handler', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'natui-bootstrap-test-'));
  const entry = path.join(temporary, 'main.tsx');
  const output = path.join(temporary, 'bundle.mjs');
  const inprocPackage = path.join(temporary, 'node_modules', '@natui', 'core');
  const scheduled = [];
  const originalSend = globalThis.__natui_send;
  const originalReceive = globalThis.__natui_recv;
  const originalSetTimeout = globalThis.setTimeout;

  try {
    await mkdir(inprocPackage, { recursive: true });
    await Promise.all([
      writeFile(entry, "throw new Error('bundled entry exploded');\n", 'utf8'),
      writeFile(
        path.join(inprocPackage, 'package.json'),
        JSON.stringify({
          name: '@natui/core',
          type: 'module',
          exports: {
            './inproc': './inproc.js',
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(inprocPackage, 'inproc.js'),
        [
          'export function prepareEmbeddedRuntime() {',
          '  globalThis.__natui_recv = () => {};',
          '}',
          'export function assertEmbeddedRuntimeStarted() {}',
          'export function deferEmbeddedRuntimeFailure(error) {',
          '  setTimeout(() => { throw error; }, 0);',
          '}',
        ].join('\n'),
        'utf8',
      ),
    ]);

    await buildJavaScript({ entryPath: entry, root: temporary }, output);
    globalThis.__natui_send = () => {};
    globalThis.setTimeout = (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    };
    await import(`${pathToFileURL(output).href}?probe=${Date.now()}`);
    for (let turn = 0; turn < 10 && scheduled.length === 0; turn += 1) {
      await Promise.resolve();
    }

    assert.equal(scheduled.length, 1);
    assert.throws(scheduled[0], /bundled entry exploded/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (originalSend === undefined) delete globalThis.__natui_send;
    else globalThis.__natui_send = originalSend;
    if (originalReceive === undefined) delete globalThis.__natui_recv;
    else globalThis.__natui_recv = originalReceive;
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

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

test('output overrides resolve Windows separators consistently on every platform', () => {
  const root = path.resolve('fixture-app');
  assert.equal(
    resolveOutputOverride(root, 'custom\\package'),
    path.join(root, 'custom', 'package'),
  );
});

test('application config rejects unknown fields, traversal, and unsafe identity', () => {
  assert.throws(
    () => validateAppConfig({ ...valid, typo: true }),
    /unknown top-level property "typo"/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, $schema: 1 }),
    /\$schema must be a non-empty string/,
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
  assert.throws(
    () => validateAppConfig({ ...valid, icons: { macos: 'assets/icon.png' } }),
    /icons\.macos must use the native \.icns format/,
  );
  assert.throws(
    () => validateAppConfig({ ...valid, icons: { windows: 'assets/icon.icns' } }),
    /icons\.windows must use the native \.ico format/,
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

  const macIconPattern = appSchema.properties.icons.properties.macos.allOf[1].pattern;
  const windowsIconPattern = appSchema.properties.icons.properties.windows.allOf[1].pattern;
  assert.match('assets/AppIcon.icns', new RegExp(macIconPattern));
  assert.doesNotMatch('assets/AppIcon.png', new RegExp(macIconPattern));
  assert.match('assets/AppIcon.ico', new RegExp(windowsIconPattern));
  assert.doesNotMatch('assets/AppIcon.icns', new RegExp(windowsIconPattern));
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

test('MSBuild property values escape metacharacters without double decoding', () => {
  assert.equal(
    escapeMsbuildPropertyValue("Research; $Preview% @(x)*?'"),
    'Research%3B %24Preview%25 %40%28x%29%2A%3F%27',
  );
  assert.equal(
    escapeMsbuildPropertyValue('C:\\Apps\\100% ready;preview\\App.ico'),
    'C:\\Apps\\100%25 ready%3Bpreview\\App.ico',
  );
});

const TEST_PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEST_JP2_128 = Buffer.from(
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAgAAAAIAABAcHAAAAAAAPY29scgEAAAAAABAAAADOanAyY/9P/1EAMgAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABAcBAQcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAARAAB/5PPtCgUAFyg4qAAAvxP34AgEVBJn9+AIBFQSZ/PtBAUAFyvgICAgICAgICAgICAgICAgICAgID/2Q==',
  'base64',
);

function jp2WithComponentDepths(depths) {
  const source = Buffer.from(TEST_JP2_128);
  source[58] = 0xff;
  const componentDepth = Buffer.alloc(8 + depths.length);
  componentDepth.writeUInt32BE(componentDepth.length, 0);
  componentDepth.write('bpcc', 4, 4, 'ascii');
  Buffer.from(depths).copy(componentDepth, 8);
  const result = Buffer.concat([
    source.subarray(0, 62),
    componentDepth,
    source.subarray(62),
  ]);
  result.writeUInt32BE(source.readUInt32BE(32) + componentDepth.length, 32);
  return result;
}

const TEST_PNG_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < TEST_PNG_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  TEST_PNG_CRC_TABLE[index] = value >>> 0;
}

function testPngCrc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = TEST_PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function testPngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  name.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(testPngCrc32(Buffer.concat([name, payload])), 8 + payload.length);
  return chunk;
}

function pngFixture(size) {
  const rowLength = size * 4;
  const raw = Buffer.alloc((rowLength + 1) * size, 0x7f);
  for (let row = 0; row < size; row += 1) {
    raw[row * (rowLength + 1)] = 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    TEST_PNG_SIGNATURE,
    testPngChunk('IHDR', header),
    testPngChunk('IDAT', deflateSync(raw)),
    testPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function indexedPngFixture(size, bitDepth, paletteEntries) {
  const rowLength = Math.ceil((size * bitDepth) / 8);
  const raw = Buffer.alloc((rowLength + 1) * size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = bitDepth;
  header[9] = 3;
  return Buffer.concat([
    TEST_PNG_SIGNATURE,
    testPngChunk('IHDR', header),
    testPngChunk('PLTE', Buffer.alloc(paletteEntries * 3)),
    testPngChunk('IDAT', deflateSync(raw)),
    testPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function dibFixture(size) {
  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const payload = Buffer.alloc(40 + pixelBytes + maskStride * size);
  payload.writeUInt32LE(40, 0);
  payload.writeInt32LE(size, 4);
  payload.writeInt32LE(size * 2, 8);
  payload.writeUInt16LE(1, 12);
  payload.writeUInt16LE(32, 14);
  payload.writeUInt32LE(pixelBytes, 20);
  for (let offset = 40; offset < 40 + pixelBytes; offset += 4) {
    payload[offset] = 0x7f;
    payload[offset + 1] = 0x7f;
    payload[offset + 2] = 0x7f;
    payload[offset + 3] = 0xff;
  }
  return payload;
}

function coreDibFixture(size, bitDepth) {
  const paletteEntries = bitDepth <= 8 ? 2 ** bitDepth : 0;
  const colorStride = Math.ceil((size * bitDepth) / 32) * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const payload = Buffer.alloc(
    12 + paletteEntries * 3 + (colorStride + maskStride) * size,
  );
  payload.writeUInt32LE(12, 0);
  payload.writeUInt16LE(size, 4);
  payload.writeUInt16LE(size * 2, 6);
  payload.writeUInt16LE(1, 8);
  payload.writeUInt16LE(bitDepth, 10);
  return payload;
}

function macIconFixture(chunkTypes, payloadForType = (_type, size) => pngFixture(size)) {
  const sizeByType = new Map([
    ['is32', 16],
    ['icp4', 16],
    ['il32', 32],
    ['icp5', 32],
    ['ic11', 32],
    ['icp6', 64],
    ['ic12', 64],
    ['it32', 128],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256],
    ['ic09', 512],
    ['ic14', 512],
    ['ic10', 1024],
  ]);
  const chunks = chunkTypes.map((type) => {
    const size = sizeByType.get(type);
    assert.notEqual(size, undefined);
    const payload = payloadForType(type, size);
    const chunk = Buffer.alloc(8 + payload.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    payload.copy(chunk, 8);
    return chunk;
  });
  const bytes = Buffer.concat([Buffer.alloc(8), ...chunks]);
  bytes.write('icns', 0, 4, 'ascii');
  bytes.writeUInt32BE(bytes.length, 4);
  return bytes;
}

function windowsIconFixture(sizes, payloadForSize = (size) => (
  size === 256 ? pngFixture(size) : dibFixture(size)
)) {
  const directoryLength = 6 + sizes.length * 16;
  const payloads = sizes.map(payloadForSize);
  const bytes = Buffer.alloc(directoryLength + payloads.reduce(
    (total, payload) => total + payload.length,
    0,
  ));
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(sizes.length, 4);
  let imageOffset = directoryLength;
  sizes.forEach((size, index) => {
    const entryOffset = 6 + index * 16;
    bytes[entryOffset] = size === 256 ? 0 : size;
    bytes[entryOffset + 1] = size === 256 ? 0 : size;
    bytes.writeUInt16LE(1, entryOffset + 4);
    bytes.writeUInt16LE(32, entryOffset + 6);
    bytes.writeUInt32LE(payloads[index].length, entryOffset + 8);
    bytes.writeUInt32LE(imageOffset, entryOffset + 12);
    payloads[index].copy(bytes, imageOffset);
    imageOffset += payloads[index].length;
  });
  return bytes;
}

test('native icon inspection accepts standard representation sets', () => {
  assert.deepEqual(
    inspectMacIcon(macIconFixture(['icp4', 'icp5', 'ic07', 'ic08', 'ic09', 'ic10'])).sizes,
    [16, 32, 128, 256, 512, 1024],
  );
  assert.deepEqual(
    inspectWindowsIcon(windowsIconFixture([16, 24, 32, 48, 256])).sizes,
    [16, 24, 32, 48, 256],
  );
  assert.deepEqual(
    inspectMacIcon(macIconFixture(['ic07'], () => TEST_JP2_128)).sizes,
    [128],
  );
  assert.deepEqual(
    inspectMacIcon(macIconFixture(
      ['ic07'],
      () => jp2WithComponentDepths([7, 7, 7, 7]),
    )).sizes,
    [128],
  );
});

test('Windows icon inspection enforces BITMAPCOREHEADER bit depths', () => {
  for (const bitDepth of [1, 4, 8, 24]) {
    const icon = windowsIconFixture([16], () => coreDibFixture(16, bitDepth));
    icon.writeUInt16LE(bitDepth, 6 + 6);
    assert.deepEqual(inspectWindowsIcon(icon).sizes, [16]);
  }

  for (const bitDepth of [16, 32]) {
    const icon = windowsIconFixture([16], () => coreDibFixture(16, bitDepth));
    icon.writeUInt16LE(bitDepth, 6 + 6);
    assert.throws(
      () => inspectWindowsIcon(icon),
      /invalid DIB dimensions or pixel format/,
    );
  }
});

test('native icon inspection rejects malformed containers and image bounds', () => {
  assert.throws(() => inspectMacIcon(Buffer.from('not an icon')), /valid ICNS container/);
  const truncatedMac = macIconFixture(['ic10']);
  truncatedMac.writeUInt32BE(truncatedMac.length + 1, 4);
  assert.throws(() => inspectMacIcon(truncatedMac), /declares .* contains/);
  const emptyMacPayload = macIconFixture(['ic10']);
  emptyMacPayload.writeUInt32BE(8, 12);
  emptyMacPayload.writeUInt32BE(16, 4);
  assert.throws(
    () => inspectMacIcon(emptyMacPayload.subarray(0, 16)),
    /ic10 image payload must use complete PNG or JPEG 2000 image data/,
  );
  const fakeMacPayload = macIconFixture(['ic10']);
  fakeMacPayload.fill(0, 16);
  TEST_PNG_SIGNATURE.copy(fakeMacPayload, 16);
  assert.throws(() => inspectMacIcon(fakeMacPayload), /PNG (?:image|checksum|chunk type)/);
  const headerOnlyJpeg2000 = macIconFixture(
    ['ic10'],
    () => Buffer.from([
      0, 0, 0, 12, 106, 80, 32, 32, 13, 10, 135, 10,
      0, 0, 0, 30, 106, 112, 50, 104, 0, 0, 0, 22,
      105, 104, 100, 114, 0, 0, 4, 0, 0, 0, 4, 0,
      3, 7, 0, 0, 0, 0,
    ]),
  );
  assert.throws(
    () => inspectMacIcon(headerOnlyJpeg2000),
    /JPEG 2000|JP2/,
  );
  const missingJpeg2000End = Buffer.from(TEST_JP2_128);
  missingJpeg2000End.fill(0, missingJpeg2000End.length - 2);
  assert.throws(
    () => inspectMacIcon(macIconFixture(['ic07'], () => missingJpeg2000End)),
    /EOC marker/,
  );
  const emptyColorBox = Buffer.alloc(8);
  emptyColorBox.writeUInt32BE(8, 0);
  emptyColorBox.write('colr', 4, 4, 'ascii');
  const emptyJpeg2000Color = Buffer.concat([
    TEST_JP2_128.subarray(0, 62),
    emptyColorBox,
    TEST_JP2_128.subarray(77),
  ]);
  emptyJpeg2000Color.writeUInt32BE(38, 32);
  assert.throws(
    () => inspectMacIcon(macIconFixture(['ic07'], () => emptyJpeg2000Color)),
    /invalid JP2 image header/,
  );
  const uniformDepthMismatch = Buffer.from(TEST_JP2_128);
  uniformDepthMismatch[58] = 6;
  assert.throws(
    () => inspectMacIcon(macIconFixture(['ic07'], () => uniformDepthMismatch)),
    /component depths that disagree/,
  );
  assert.throws(
    () => inspectMacIcon(macIconFixture(
      ['ic07'],
      () => jp2WithComponentDepths([6, 7, 7, 7]),
    )),
    /component depths that disagree/,
  );

  assert.throws(() => inspectWindowsIcon(Buffer.alloc(6)), /valid ICO container/);
  const invalidWindows = windowsIconFixture([256]);
  invalidWindows.writeUInt32LE(invalidWindows.length + 1, 6 + 12);
  assert.throws(() => inspectWindowsIcon(invalidWindows), /invalid ICO image/);
  const fakeWindowsPng = windowsIconFixture(
    [256],
    () => Buffer.concat([TEST_PNG_SIGNATURE, Buffer.alloc(37)]),
  );
  assert.throws(
    () => inspectWindowsIcon(fakeWindowsPng),
    /PNG (?:image|checksum|chunk type)/,
  );
  const validWindowsPng = pngFixture(256);
  const unknownCriticalPng = Buffer.concat([
    validWindowsPng.subarray(0, 33),
    testPngChunk('ABCD', Buffer.alloc(0)),
    validWindowsPng.subarray(33),
  ]);
  assert.throws(
    () => inspectWindowsIcon(windowsIconFixture([256], () => unknownCriticalPng)),
    /unknown critical PNG chunk ABCD/,
  );
  assert.throws(
    () => inspectWindowsIcon(windowsIconFixture(
      [256],
      () => indexedPngFixture(256, 1, 3),
    )),
    /invalid PNG PLTE chunk/,
  );
  const splitIdatPng = Buffer.concat([
    validWindowsPng.subarray(0, 33),
    testPngChunk('IDAT', Buffer.alloc(0)),
    testPngChunk('tEXt', Buffer.from('note')),
    validWindowsPng.subarray(33),
  ]);
  assert.throws(
    () => inspectWindowsIcon(windowsIconFixture([256], () => splitIdatPng)),
    /non-consecutive PNG IDAT chunks/,
  );
  const mismatchedWindowsDib = windowsIconFixture([32]);
  const dibOffset = mismatchedWindowsDib.readUInt32LE(6 + 12);
  mismatchedWindowsDib.writeInt32LE(31, dibOffset + 4);
  assert.throws(
    () => inspectWindowsIcon(mismatchedWindowsDib),
    /invalid DIB dimensions or pixel format/,
  );
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

test('demo icon generation rejects linked destinations before writing', async (t) => {
  await t.test('icon directory junction', async () => {
    const fixture = await makeFilesystemFixture();
    try {
      const externalIcons = path.join(fixture.external, 'icons');
      await Promise.all([
        mkdir(path.join(fixture.app, '.natui'), { recursive: true }),
        mkdir(externalIcons, { recursive: true }),
      ]);
      await createDirectoryLink(externalIcons, path.join(fixture.app, '.natui', 'icons'));

      await assert.rejects(
        writeDemoIcons({
          repositoryDirectory: fixture.temporary,
          applicationDirectory: fixture.app,
        }),
        /generated icon directory must stay inside the application directory/,
      );
      await assert.rejects(
        stat(path.join(externalIcons, 'AppIcon.ico')),
        /ENOENT/,
      );
      await assert.rejects(
        stat(path.join(externalIcons, 'AppIcon.icns')),
        /ENOENT/,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  });

  await t.test('individual icon symbolic link', async (subtest) => {
    const fixture = await makeFilesystemFixture();
    try {
      const iconDirectory = path.join(fixture.app, '.natui', 'icons');
      const externalIcon = path.join(fixture.external, 'AppIcon.ico');
      const sentinel = 'external icon remains unchanged';
      await mkdir(iconDirectory, { recursive: true });
      await writeFile(externalIcon, sentinel, 'utf8');
      try {
        await symlink(externalIcon, path.join(iconDirectory, 'AppIcon.ico'), 'file');
      } catch (error) {
        if (
          process.platform === 'win32'
          && error !== null
          && typeof error === 'object'
          && 'code' in error
          && error.code === 'EPERM'
        ) {
          subtest.skip('file symbolic links require an unavailable Windows privilege');
          return;
        }
        throw error;
      }

      await assert.rejects(
        writeDemoIcons({
          repositoryDirectory: fixture.temporary,
          applicationDirectory: fixture.app,
        }),
        /generated icon AppIcon\.ico must stay inside the application directory/,
      );
      assert.equal(await readFile(externalIcon, 'utf8'), sentinel);
      await assert.rejects(
        stat(path.join(iconDirectory, 'AppIcon.icns')),
        /ENOENT/,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  });
});
