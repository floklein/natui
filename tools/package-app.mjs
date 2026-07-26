#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { build as buildWithEsbuild } from 'esbuild';
import {
  APP_SCHEMA_VERSION,
  loadAppConfig,
  validateAppConfig,
} from '../packages/natui/app-config.js';

export { APP_SCHEMA_VERSION, validateAppConfig };
export const BUNDLE_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const HOST_API_VERSION = 1;

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..');
const DEFAULT_CONFIG = 'natui.app.json';
const SHA256 = /^[a-f0-9]{64}$/;

function configurationError(message) {
  return new Error(`natui package: ${message}`);
}

export function escapeMsbuildPropertyValue(value) {
  return String(value).replace(/[%$@'();?*]/g, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  ));
}

function assertRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${field} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    /^[A-Za-z]:/.test(value)
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(value)
  ) {
    throw configurationError(`${field} must be relative to natui.app.json`);
  }
  if (
    normalized === '.'
    || normalized.split('/').includes('..')
  ) {
    throw configurationError(`${field} must stay inside the application directory`);
  }
}

export function resolveOutputOverride(root, outDir) {
  assertRelativePath(outDir, 'out-dir');
  const resolved = path.resolve(root, outDir.replaceAll('\\', '/'));
  assertContained(root, resolved, 'out-dir');
  return resolved;
}

function assertContained(root, candidate, field) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '.') return;
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw configurationError(`${field} must stay inside the application directory`);
  }
}

function isMissingPathError(error) {
  return (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT'
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

/**
 * Resolve every existing path component while retaining a missing suffix.
 *
 * realpath() fails for a legitimate new output leaf. Walking upward finds the
 * nearest existing parent, including any junction or symbolic-link target,
 * before the missing suffix is appended to that physical location.
 */
async function resolveFromExistingParent(candidate, field) {
  let current = path.resolve(candidate);
  const missing = [];

  while (true) {
    try {
      const existing = await realpath(current);
      return path.resolve(existing, ...missing);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw configurationError(`cannot resolve ${field}: ${errorMessage(error)}`);
      }

      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw configurationError(`${field} contains a broken symbolic link: ${current}`);
        }
      } catch (linkError) {
        if (!isMissingPathError(linkError)) throw linkError;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw configurationError(`cannot resolve ${field}: no existing parent for ${candidate}`);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function resolveContainedFile(root, candidate, field) {
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw configurationError(`${field} does not exist: ${candidate}`);
  }
  assertContained(root, resolved, field);
  await assertFile(resolved, field);
  return resolved;
}

export async function prepareContainedDirectory(root, candidate, field) {
  const projected = await resolveFromExistingParent(candidate, field);
  assertContained(root, projected, field);
  await mkdir(projected, { recursive: true });

  let resolved;
  try {
    resolved = await realpath(projected);
  } catch (error) {
    throw configurationError(`cannot resolve ${field}: ${errorMessage(error)}`);
  }
  assertContained(root, resolved, field);

  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw configurationError(`${field} is not a directory: ${resolved}`);
  }
  return resolved;
}

export async function resolveContainedWritePath(root, candidate, field) {
  const resolved = await resolveFromExistingParent(candidate, field);
  assertContained(root, resolved, field);
  if (!samePath(resolved, candidate)) {
    throw configurationError(`${field} resolves through a symbolic link or junction`);
  }
  return resolved;
}

async function assertStableDirectory(root, directory, field) {
  let resolved;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    throw configurationError(`cannot recheck ${field}: ${errorMessage(error)}`);
  }
  assertContained(root, resolved, field);
  if (!samePath(resolved, directory)) {
    throw configurationError(`${field} changed through a symbolic link or junction while packaging`);
  }
}

async function assertSafeReplacementPaths(
  root,
  outputDirectory,
  stageRoot,
  stagedArtifact,
  target,
) {
  await assertStableDirectory(root, outputDirectory, 'output');
  await assertStableDirectory(outputDirectory, stageRoot, 'staging directory');

  let resolvedStagedArtifact;
  try {
    resolvedStagedArtifact = await realpath(stagedArtifact);
  } catch (error) {
    throw configurationError(`cannot recheck staged artifact: ${errorMessage(error)}`);
  }
  assertContained(stageRoot, resolvedStagedArtifact, 'staged artifact');
  if (!samePath(resolvedStagedArtifact, stagedArtifact)) {
    throw configurationError(
      'staged artifact changed through a symbolic link or junction while packaging',
    );
  }

  for (const [candidate, field] of [
    [target, 'output artifact'],
    [`${target}.previous-${process.pid}`, 'output artifact backup'],
  ]) {
    const resolved = await resolveFromExistingParent(candidate, field);
    assertContained(outputDirectory, resolved, field);
    if (!samePath(resolved, candidate)) {
      throw configurationError(`${field} resolves through a symbolic link or junction`);
    }
  }
}

function normalizeArchitecture(value = process.arch) {
  if (value === 'x64' || value === 'arm64') return value;
  throw configurationError(`unsupported architecture "${value}", expected x64 or arm64`);
}

function normalizePlatform(value = process.platform) {
  if (value === 'win32') return 'windows';
  if (value === 'darwin') return 'macos';
  throw configurationError('native application packaging is supported on macOS and Windows');
}

export function createBundleManifest(config, {
  platform,
  architecture,
  entrySha256,
}) {
  if (!SHA256.test(entrySha256)) {
    throw configurationError('internal error: entrySha256 is not a lowercase SHA-256 digest');
  }
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    id: config.id,
    name: config.name,
    version: config.version,
    buildNumber: config.buildNumber,
    entry: 'main.js',
    entrySha256,
    protocolVersion: PROTOCOL_VERSION,
    minHostApi: HOST_API_VERSION,
    platform,
    architecture,
  };
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderMacInfoPlist(config, hasIcon = false) {
  const icon = hasIcon
    ? '    <key>CFBundleIconFile</key>\n    <string>AppIcon</string>\n'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>${escapeXml(config.name)}</string>
    <key>CFBundleExecutable</key>
    <string>${escapeXml(config.executable)}</string>
    <key>CFBundleIdentifier</key>
    <string>${escapeXml(config.id)}</string>
${icon}    <key>CFBundleName</key>
    <string>${escapeXml(config.name)}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${escapeXml(config.version)}</string>
    <key>CFBundleVersion</key>
    <string>${escapeXml(config.buildNumber)}</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
`;
}

function run(command, args, cwd = REPO_ROOT, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnvironment },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(configurationError(`${command} failed with ${detail}`));
    });
  });
}

async function fileSha256(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertFile(file, field) {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw configurationError(`${field} does not exist: ${file}`);
  }
  if (!info.isFile()) {
    throw configurationError(`${field} is not a file: ${file}`);
  }
}

const MAC_ICON_CHUNK_SIZES = new Map([
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
const RECOMMENDED_MAC_ICON_SIZES = [16, 32, 128, 256, 512, 1024];
const RECOMMENDED_WINDOWS_ICON_SIZES = [16, 24, 32, 48, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LEGACY_MAC_ICON_CHUNKS = new Set(['is32', 'il32', 'it32']);
const DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);
const PNG_COLOR_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const PNG_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < PNG_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  PNG_CRC_TABLE[index] = value >>> 0;
}

function pngCrc32(type, payload) {
  let value = 0xffffffff;
  for (const buffer of [type, payload]) {
    for (const byte of buffer) {
      value = PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngPasses(width, height, interlaced) {
  if (!interlaced) return [{ width, height }];
  return [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ].map(([startX, startY, stepX, stepY]) => ({
    width: Math.max(0, Math.ceil((width - startX) / stepX)),
    height: Math.max(0, Math.ceil((height - startY) / stepY)),
  })).filter((pass) => pass.width > 0 && pass.height > 0);
}

function inspectPngImageData(header, imageData, field) {
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(
    header.colorType,
  );
  const bitsPerPixel = channels * header.bitDepth;
  const passes = pngPasses(header.width, header.height, header.interlaced);
  const passRows = passes.map((pass) => ({
    ...pass,
    rowLength: Math.ceil((pass.width * bitsPerPixel) / 8),
  }));
  const expectedLength = passRows.reduce(
    (total, pass) => total + (pass.rowLength + 1) * pass.height,
    0,
  );
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength + 1 });
  } catch {
    throw configurationError(`${field} has invalid compressed PNG image data`);
  }
  if (decoded.length !== expectedLength) {
    throw configurationError(
      `${field} has ${decoded.length} decoded PNG bytes, expected ${expectedLength}`,
    );
  }
  let offset = 0;
  for (const pass of passRows) {
    for (let row = 0; row < pass.height; row += 1) {
      if (decoded[offset] > 4) {
        throw configurationError(`${field} has an invalid PNG row filter`);
      }
      offset += pass.rowLength + 1;
    }
  }
}

function inspectPngImage(bytes, expectedWidth, expectedHeight, field) {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw configurationError(`${field} is not a valid PNG image`);
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  let sawIdat = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawPalette = false;
  let sawEnd = false;
  const imageData = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw configurationError(`${field} has a truncated PNG chunk`);
    }
    const payloadLength = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8);
    const typeName = type.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(typeName) || (type[2] & 0x20) !== 0) {
      throw configurationError(`${field} has an invalid PNG chunk type`);
    }
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + payloadLength;
    const chunkEnd = payloadEnd + 4;
    if (payloadEnd < payloadOffset || chunkEnd > bytes.length) {
      throw configurationError(`${field} has an invalid ${typeName} PNG chunk length`);
    }
    const payload = bytes.subarray(payloadOffset, payloadEnd);
    if (bytes.readUInt32BE(payloadEnd) !== pngCrc32(type, payload)) {
      throw configurationError(`${field} has an invalid ${typeName} PNG checksum`);
    }
    if (sawIdat && typeName !== 'IDAT') imageDataEnded = true;

    if (header === undefined) {
      if (typeName !== 'IHDR' || payloadLength !== 13) {
        throw configurationError(`${field} must begin with a PNG IHDR chunk`);
      }
      const width = payload.readUInt32BE(0);
      const height = payload.readUInt32BE(4);
      const bitDepth = payload[8];
      const colorType = payload[9];
      const validDepths = PNG_COLOR_DEPTHS.get(colorType);
      if (
        width === 0
        || height === 0
        || !validDepths?.has(bitDepth)
        || payload[10] !== 0
        || payload[11] !== 0
        || (payload[12] !== 0 && payload[12] !== 1)
      ) {
        throw configurationError(`${field} has an invalid PNG IHDR chunk`);
      }
      if (width !== expectedWidth || height !== expectedHeight) {
        throw configurationError(
          `${field} is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`,
        );
      }
      header = {
        bitDepth,
        colorType,
        height,
        interlaced: payload[12] === 1,
        width,
      };
    } else if (typeName === 'IHDR') {
      throw configurationError(`${field} has more than one PNG IHDR chunk`);
    } else if (typeName === 'PLTE') {
      const paletteEntries = payloadLength / 3;
      if (
        sawPalette
        || sawIdat
        || payloadLength === 0
        || payloadLength % 3 !== 0
        || payloadLength > 768
        || header.colorType === 0
        || header.colorType === 4
        || (header.colorType === 3 && paletteEntries > 2 ** header.bitDepth)
      ) {
        throw configurationError(`${field} has an invalid PNG PLTE chunk`);
      }
      sawPalette = true;
    } else if (typeName === 'IDAT') {
      if (imageDataEnded) {
        throw configurationError(`${field} has non-consecutive PNG IDAT chunks`);
      }
      sawIdat = true;
      if (payloadLength > 0) {
        sawImageData = true;
        imageData.push(payload);
      }
    } else if (typeName === 'IEND') {
      if (payloadLength !== 0 || chunkEnd !== bytes.length) {
        throw configurationError(`${field} has an invalid PNG IEND chunk`);
      }
      sawEnd = true;
    } else if ((type[0] & 0x20) === 0) {
      throw configurationError(`${field} has unknown critical PNG chunk ${typeName}`);
    }

    offset = chunkEnd;
  }

  if (
    header === undefined
    || !sawImageData
    || !sawEnd
    || (header.colorType === 3 && !sawPalette)
  ) {
    throw configurationError(`${field} is missing required PNG image data`);
  }
  inspectPngImageData(header, imageData, field);
  return header;
}

const JPEG2000_FILE_SIGNATURE = Buffer.from([
  0, 0, 0, 12,
  0x6a, 0x50, 0x20, 0x20,
  0x0d, 0x0a, 0x87, 0x0a,
]);

function readJpeg2000Boxes(bytes, start, end, field) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) {
      throw configurationError(`${field} has a truncated JPEG 2000 box header`);
    }
    const declaredLength = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let headerLength = 8;
    let boxLength = declaredLength;
    if (declaredLength === 1) {
      if (offset + 16 > end) {
        throw configurationError(`${field} has a truncated extended JPEG 2000 box header`);
      }
      const extendedLength = bytes.readBigUInt64BE(offset + 8);
      if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw configurationError(`${field} has an unsupported JPEG 2000 box length`);
      }
      headerLength = 16;
      boxLength = Number(extendedLength);
    } else if (declaredLength === 0) {
      boxLength = end - offset;
    }
    if (
      boxLength < headerLength
      || boxLength > end - offset
    ) {
      throw configurationError(`${field} has an invalid ${type} JPEG 2000 box length`);
    }
    boxes.push({
      end: offset + boxLength,
      payloadEnd: offset + boxLength,
      payloadStart: offset + headerLength,
      start: offset,
      type,
    });
    offset += boxLength;
  }
  return boxes;
}

function inspectJpeg2000Codestream(
  bytes,
  expectedWidth,
  expectedHeight,
  field,
  expectedComponents,
) {
  if (
    bytes.length < 55
    || bytes.readUInt16BE(0) !== 0xff4f
    || bytes.readUInt16BE(2) !== 0xff51
  ) {
    throw configurationError(`${field} has an invalid JPEG 2000 codestream header`);
  }
  if (bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw configurationError(`${field} is missing the JPEG 2000 EOC marker`);
  }

  const sizOffset = 2;
  const sizLength = bytes.readUInt16BE(sizOffset + 2);
  const componentCount = bytes.readUInt16BE(sizOffset + 38);
  const sizEnd = sizOffset + 2 + sizLength;
  if (
    componentCount === 0
    || componentCount > 16_384
    || sizLength !== 38 + componentCount * 3
    || sizEnd > bytes.length - 2
  ) {
    throw configurationError(`${field} has an invalid JPEG 2000 SIZ marker`);
  }

  const referenceWidth = bytes.readUInt32BE(sizOffset + 6);
  const referenceHeight = bytes.readUInt32BE(sizOffset + 10);
  const originX = bytes.readUInt32BE(sizOffset + 14);
  const originY = bytes.readUInt32BE(sizOffset + 18);
  const tileWidth = bytes.readUInt32BE(sizOffset + 22);
  const tileHeight = bytes.readUInt32BE(sizOffset + 26);
  const tileOriginX = bytes.readUInt32BE(sizOffset + 30);
  const tileOriginY = bytes.readUInt32BE(sizOffset + 34);
  if (
    referenceWidth <= originX
    || referenceHeight <= originY
    || referenceWidth - originX !== expectedWidth
    || referenceHeight - originY !== expectedHeight
    || tileWidth === 0
    || tileHeight === 0
    || tileOriginX > originX
    || tileOriginY > originY
    || (expectedComponents !== undefined && componentCount !== expectedComponents)
  ) {
    throw configurationError(
      `${field} has JPEG 2000 dimensions or components that do not match its icon entry`,
    );
  }
  const componentDescriptors = [];
  for (let index = 0; index < componentCount; index += 1) {
    const componentOffset = sizOffset + 40 + index * 3;
    if (
      (bytes[componentOffset] & 0x7f) > 37
      || bytes[componentOffset + 1] === 0
      || bytes[componentOffset + 2] === 0
    ) {
      throw configurationError(`${field} has invalid JPEG 2000 component sampling`);
    }
    componentDescriptors.push(bytes[componentOffset]);
  }

  let offset = sizEnd;
  let sawCodingStyle = false;
  let sawQuantization = false;
  while (offset < bytes.length - 2 && bytes.readUInt16BE(offset) !== 0xff90) {
    const marker = bytes.readUInt16BE(offset);
    if (
      (marker & 0xff00) !== 0xff00
      || marker === 0xff93
      || marker === 0xffd9
      || offset + 4 > bytes.length - 2
    ) {
      throw configurationError(`${field} has an invalid JPEG 2000 main header`);
    }
    const markerLength = bytes.readUInt16BE(offset + 2);
    if (markerLength < 2 || offset + 2 + markerLength > bytes.length - 2) {
      throw configurationError(`${field} has a truncated JPEG 2000 main header marker`);
    }
    if (marker === 0xff52) sawCodingStyle = true;
    if (marker === 0xff5c) sawQuantization = true;
    offset += 2 + markerLength;
  }
  if (!sawCodingStyle || !sawQuantization) {
    throw configurationError(`${field} is missing required JPEG 2000 coding markers`);
  }

  let tileParts = 0;
  while (offset < bytes.length - 2) {
    if (bytes.readUInt16BE(offset) !== 0xff90 || offset + 12 > bytes.length - 2) {
      throw configurationError(`${field} is missing a JPEG 2000 SOT marker`);
    }
    const startOfTilePart = offset;
    const sotLength = bytes.readUInt16BE(offset + 2);
    const tilePartLength = bytes.readUInt32BE(offset + 6);
    if (sotLength !== 10 || (tilePartLength !== 0 && tilePartLength < 14)) {
      throw configurationError(`${field} has an invalid JPEG 2000 SOT marker`);
    }
    const tilePartEnd = tilePartLength === 0
      ? bytes.length - 2
      : startOfTilePart + tilePartLength;
    if (tilePartEnd > bytes.length - 2) {
      throw configurationError(`${field} has a truncated JPEG 2000 tile-part`);
    }

    offset += 12;
    while (offset < tilePartEnd && bytes.readUInt16BE(offset) !== 0xff93) {
      const marker = bytes.readUInt16BE(offset);
      if (
        (marker & 0xff00) !== 0xff00
        || marker === 0xff90
        || marker === 0xffd9
        || offset + 4 > tilePartEnd
      ) {
        throw configurationError(`${field} has an invalid JPEG 2000 tile header`);
      }
      const markerLength = bytes.readUInt16BE(offset + 2);
      if (markerLength < 2 || offset + 2 + markerLength > tilePartEnd) {
        throw configurationError(`${field} has a truncated JPEG 2000 tile header marker`);
      }
      offset += 2 + markerLength;
    }
    if (offset + 2 >= tilePartEnd || bytes.readUInt16BE(offset) !== 0xff93) {
      throw configurationError(`${field} is missing JPEG 2000 tile image data`);
    }
    offset = tilePartEnd;
    tileParts += 1;
  }
  if (tileParts === 0 || offset !== bytes.length - 2) {
    throw configurationError(`${field} has an incomplete JPEG 2000 codestream`);
  }
  return { componentCount, componentDescriptors };
}

function inspectJpeg2000Image(bytes, expectedWidth, expectedHeight, field) {
  if (
    bytes.length < JPEG2000_FILE_SIGNATURE.length
    || !bytes.subarray(0, JPEG2000_FILE_SIGNATURE.length).equals(JPEG2000_FILE_SIGNATURE)
  ) {
    return false;
  }

  const boxes = readJpeg2000Boxes(bytes, 0, bytes.length, field);
  const [signature, fileType] = boxes;
  if (
    signature?.type !== 'jP  '
    || signature.end !== JPEG2000_FILE_SIGNATURE.length
    || fileType?.type !== 'ftyp'
    || fileType.payloadEnd - fileType.payloadStart < 12
    || (fileType.payloadEnd - fileType.payloadStart) % 4 !== 0
  ) {
    throw configurationError(`${field} has an invalid JPEG 2000 file header`);
  }
  const fileTypePayload = bytes.subarray(fileType.payloadStart, fileType.payloadEnd);
  const compatibleBrands = Array.from(
    { length: (fileTypePayload.length - 8) / 4 },
    (_, index) => fileTypePayload.toString('ascii', 8 + index * 4, 12 + index * 4),
  );
  if (
    fileTypePayload.toString('ascii', 0, 4) !== 'jp2 '
    || fileTypePayload.readUInt32BE(4) !== 0
    || !compatibleBrands.includes('jp2 ')
  ) {
    throw configurationError(`${field} is not a compatible JP2 image`);
  }

  const headerBoxes = boxes.filter((box) => box.type === 'jp2h');
  const codestreamBoxes = boxes.filter((box) => box.type === 'jp2c');
  if (
    headerBoxes.length !== 1
    || codestreamBoxes.length === 0
    || headerBoxes[0].start >= codestreamBoxes[0].start
  ) {
    throw configurationError(`${field} must contain one JP2 header and codestream`);
  }
  const headerChildren = readJpeg2000Boxes(
    bytes,
    headerBoxes[0].payloadStart,
    headerBoxes[0].payloadEnd,
    field,
  );
  const imageHeaders = headerChildren.filter((box) => box.type === 'ihdr');
  const colorBoxes = headerChildren.filter((box) => box.type === 'colr');
  const hasUsableColor = colorBoxes.some((box) => {
    const payloadLength = box.payloadEnd - box.payloadStart;
    if (payloadLength < 3) return false;
    const method = bytes[box.payloadStart];
    if (method === 1) {
      if (payloadLength !== 7) return false;
      return [16, 17, 18].includes(bytes.readUInt32BE(box.payloadStart + 3));
    }
    return method === 2 && payloadLength > 3;
  });
  if (
    imageHeaders.length !== 1
    || headerChildren[0] !== imageHeaders[0]
    || imageHeaders[0].payloadEnd - imageHeaders[0].payloadStart !== 14
    || !hasUsableColor
  ) {
    throw configurationError(`${field} has an invalid JP2 image header`);
  }
  const imageHeader = bytes.subarray(imageHeaders[0].payloadStart, imageHeaders[0].payloadEnd);
  const height = imageHeader.readUInt32BE(0);
  const width = imageHeader.readUInt32BE(4);
  const componentCount = imageHeader.readUInt16BE(8);
  const bitsPerComponent = imageHeader[10];
  if (
    width !== expectedWidth
    || height !== expectedHeight
    || componentCount === 0
    || imageHeader[11] !== 7
    || imageHeader[12] > 1
    || imageHeader[13] > 1
    || (bitsPerComponent !== 0xff && (bitsPerComponent & 0x7f) > 37)
  ) {
    throw configurationError(`${field} has invalid JP2 dimensions or image metadata`);
  }
  const componentDepthBoxes = headerChildren.filter((box) => box.type === 'bpcc');
  if (
    (bitsPerComponent === 0xff
      && (
        componentDepthBoxes.length !== 1
        || componentDepthBoxes[0].payloadEnd - componentDepthBoxes[0].payloadStart
          !== componentCount
      ))
    || (bitsPerComponent !== 0xff && componentDepthBoxes.length !== 0)
  ) {
    throw configurationError(`${field} has invalid JP2 component depth metadata`);
  }
  if (componentDepthBoxes.length === 1) {
    for (
      let offset = componentDepthBoxes[0].payloadStart;
      offset < componentDepthBoxes[0].payloadEnd;
      offset += 1
    ) {
      if ((bytes[offset] & 0x7f) > 37) {
        throw configurationError(`${field} has an invalid JP2 component bit depth`);
      }
    }
  }

  const codestream = inspectJpeg2000Codestream(
    bytes.subarray(codestreamBoxes[0].payloadStart, codestreamBoxes[0].payloadEnd),
    expectedWidth,
    expectedHeight,
    field,
    componentCount,
  );
  const declaredComponentDepths = bitsPerComponent === 0xff
    ? [...bytes.subarray(
        componentDepthBoxes[0].payloadStart,
        componentDepthBoxes[0].payloadEnd,
      )]
    : Array(componentCount).fill(bitsPerComponent);
  if (
    codestream.componentDescriptors.some(
      (descriptor, index) => descriptor !== declaredComponentDepths[index],
    )
  ) {
    throw configurationError(
      `${field} has JP2 component depths that disagree with its JPEG 2000 codestream`,
    );
  }
  return true;
}

function inspectLegacyMacImage(bytes, size, field) {
  const pixelCount = size * size;
  if (bytes.length === pixelCount * 3) return;

  let offset = (
    bytes.length >= 4
    && bytes[0] === 0
    && bytes[1] === 0
    && bytes[2] === 0
    && bytes[3] === 0
  ) ? 4 : 0;
  for (let channel = 0; channel < 3; channel += 1) {
    let decoded = 0;
    while (decoded < pixelCount && offset < bytes.length) {
      const control = bytes[offset];
      offset += 1;
      if (control < 128) {
        const count = control + 1;
        if (offset + count > bytes.length || decoded + count > pixelCount) {
          throw configurationError(`${field} has invalid legacy ICNS run-length data`);
        }
        offset += count;
        decoded += count;
      } else {
        const count = control - 125;
        if (offset >= bytes.length || decoded + count > pixelCount) {
          throw configurationError(`${field} has invalid legacy ICNS run-length data`);
        }
        offset += 1;
        decoded += count;
      }
    }
    if (decoded !== pixelCount) {
      throw configurationError(`${field} has incomplete legacy ICNS image data`);
    }
  }
  if (offset !== bytes.length) {
    throw configurationError(`${field} has trailing legacy ICNS image data`);
  }
}

function inspectMacImage(bytes, type, size) {
  const field = `icons.macos ${type} image payload`;
  if (LEGACY_MAC_ICON_CHUNKS.has(type)) {
    inspectLegacyMacImage(bytes, size, field);
    return;
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    inspectPngImage(bytes, size, size, field);
    return;
  }
  if (inspectJpeg2000Image(bytes, size, size, field)) return;
  throw configurationError(`${field} must use complete PNG or JPEG 2000 image data`);
}

function inspectWindowsDib(bytes, expectedWidth, expectedHeight, field) {
  if (bytes.length < 12) {
    throw configurationError(`${field} has a truncated DIB header`);
  }
  const headerSize = bytes.readUInt32LE(0);
  if (!DIB_HEADER_SIZES.has(headerSize) || headerSize > bytes.length) {
    throw configurationError(`${field} has an unsupported DIB header`);
  }

  const coreHeader = headerSize === 12;
  const width = coreHeader ? bytes.readUInt16LE(4) : bytes.readInt32LE(4);
  const storedHeight = coreHeader ? bytes.readUInt16LE(6) : bytes.readInt32LE(8);
  const planes = bytes.readUInt16LE(coreHeader ? 8 : 12);
  const bitDepth = bytes.readUInt16LE(coreHeader ? 10 : 14);
  const compression = coreHeader ? 0 : bytes.readUInt32LE(16);
  const supportedBitDepths = coreHeader ? [1, 4, 8, 24] : [1, 4, 8, 16, 24, 32];
  if (
    width !== expectedWidth
    || Math.abs(storedHeight) !== expectedHeight * 2
    || planes !== 1
    || !supportedBitDepths.includes(bitDepth)
    || ![0, 3, 6].includes(compression)
    || ((compression === 3 || compression === 6) && bitDepth !== 16 && bitDepth !== 32)
  ) {
    throw configurationError(`${field} has invalid DIB dimensions or pixel format`);
  }

  const usedColors = coreHeader || headerSize < 36 ? 0 : bytes.readUInt32LE(32);
  const paletteEntries = bitDepth <= 8 ? (usedColors || 2 ** bitDepth) : usedColors;
  if (bitDepth <= 8 && paletteEntries > 2 ** bitDepth) {
    throw configurationError(`${field} has an invalid DIB color table`);
  }
  const maskBytes = !coreHeader && headerSize === 40
    ? (compression === 3 ? 12 : compression === 6 ? 16 : 0)
    : 0;
  const paletteBytes = paletteEntries * (coreHeader ? 3 : 4);
  const colorStride = Math.ceil((expectedWidth * bitDepth) / 32) * 4;
  const maskStride = Math.ceil(expectedWidth / 32) * 4;
  const requiredLength = headerSize
    + maskBytes
    + paletteBytes
    + colorStride * expectedHeight
    + maskStride * expectedHeight;
  if (requiredLength > bytes.length) {
    throw configurationError(`${field} has incomplete DIB pixel or mask data`);
  }
  return { bitDepth, planes };
}

export function inspectMacIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns') {
    throw configurationError('icons.macos is not a valid ICNS container');
  }
  const declaredLength = bytes.readUInt32BE(4);
  if (declaredLength !== bytes.length) {
    throw configurationError(
      `icons.macos declares ${declaredLength} bytes but contains ${bytes.length}`,
    );
  }

  const chunkTypes = [];
  const sizes = new Set();
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw configurationError('icons.macos has a truncated ICNS chunk header');
    }
    const type = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32BE(offset + 4);
    if (chunkLength < 8 || offset + chunkLength > bytes.length) {
      throw configurationError(`icons.macos has an invalid ${type} ICNS chunk length`);
    }
    chunkTypes.push(type);
    const size = MAC_ICON_CHUNK_SIZES.get(type);
    if (size !== undefined) {
      inspectMacImage(bytes.subarray(offset + 8, offset + chunkLength), type, size);
      sizes.add(size);
    }
    offset += chunkLength;
  }

  if (chunkTypes.length === 0 || sizes.size === 0) {
    throw configurationError('icons.macos contains no supported ICNS image chunks');
  }
  return {
    chunkTypes,
    sizes: [...sizes].sort((left, right) => left - right),
  };
}

export function inspectWindowsIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6) {
    throw configurationError('icons.windows is not a valid ICO container');
  }
  const reserved = bytes.readUInt16LE(0);
  const type = bytes.readUInt16LE(2);
  const count = bytes.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count === 0) {
    throw configurationError('icons.windows is not a valid ICO container');
  }

  const directoryLength = 6 + count * 16;
  if (directoryLength > bytes.length) {
    throw configurationError('icons.windows has a truncated ICO directory');
  }

  const sizes = new Set();
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = bytes[offset] === 0 ? 256 : bytes[offset];
    const height = bytes[offset + 1] === 0 ? 256 : bytes[offset + 1];
    const byteLength = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    if (
      width !== height
      || byteLength === 0
      || imageOffset < directoryLength
      || imageOffset + byteLength > bytes.length
    ) {
      throw configurationError(`icons.windows has an invalid ICO image at index ${index}`);
    }
    const payload = bytes.subarray(imageOffset, imageOffset + byteLength);
    const field = `icons.windows image at index ${index}`;
    if (payload.length >= 8 && payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
      inspectPngImage(payload, width, height, field);
    } else {
      const dib = inspectWindowsDib(payload, width, height, field);
      const planes = bytes.readUInt16LE(offset + 4);
      const bitDepth = bytes.readUInt16LE(offset + 6);
      if (
        (planes !== 0 && planes !== dib.planes)
        || (bitDepth !== 0 && bitDepth !== dib.bitDepth)
      ) {
        throw configurationError(`${field} disagrees with its ICO directory entry`);
      }
    }
    sizes.add(width);
    images.push({ width, height, byteLength, imageOffset });
  }

  return {
    images,
    sizes: [...sizes].sort((left, right) => left - right),
  };
}

function warnMissingIconSizes(platform, actualSizes, recommendedSizes) {
  const actual = new Set(actualSizes);
  const missing = recommendedSizes.filter((size) => !actual.has(size));
  if (missing.length === 0) return;
  console.warn(
    `natui package: icons.${platform} is valid but omits recommended sizes: `
      + missing.map((size) => `${size}x${size}`).join(', '),
  );
}

async function validatePlatformIcon(file, platform) {
  const bytes = await readFile(file);
  if (platform === 'macos') {
    const icon = inspectMacIcon(bytes);
    warnMissingIconSizes('macos', icon.sizes, RECOMMENDED_MAC_ICON_SIZES);
    return;
  }
  const icon = inspectWindowsIcon(bytes);
  warnMissingIconSizes('windows', icon.sizes, RECOMMENDED_WINDOWS_ICON_SIZES);
}

async function writeManifest(config, appDirectory, platform, architecture) {
  const entry = path.join(appDirectory, 'main.js');
  const manifest = createBundleManifest(config, {
    platform,
    architecture,
    entrySha256: await fileSha256(entry),
  });
  await writeFile(
    path.join(appDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

export async function buildJavaScript(config, outputFile) {
  const entrySpecifier = config.entryPath.replaceAll('\\', '/');
  await buildWithEsbuild({
    absWorkingDir: config.root,
    outfile: outputFile,
    bundle: true,
    charset: 'utf8',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    format: 'esm',
    stdin: {
      contents: [
        "import { assertEmbeddedRuntimeStarted, deferEmbeddedRuntimeFailure, prepareEmbeddedRuntime } from '@natui/core/inproc';",
        'void (async () => {',
        '  prepareEmbeddedRuntime();',
        `  await import(${JSON.stringify(entrySpecifier)});`,
        '  assertEmbeddedRuntimeStarted();',
        '})().catch(deferEmbeddedRuntimeFailure);',
      ].join('\n'),
      loader: 'js',
      resolveDir: config.root,
      sourcefile: 'natui-entry.js',
    },
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'info',
    minify: true,
    platform: 'browser',
    plugins: [
      {
        name: 'natui-embedded-runtime',
        setup(build) {
          build.onResolve({ filter: /^@natui\/core$/ }, () => ({
            namespace: 'natui-embedded-runtime',
            path: '@natui/core',
          }));
          build.onLoad(
            {
              filter: /.*/,
              namespace: 'natui-embedded-runtime',
            },
            () => ({
              contents: [
                "export * from '@natui/core/components';",
                "export { runEmbedded as run } from '@natui/core/inproc';",
              ].join('\n'),
              loader: 'js',
              resolveDir: config.root,
            }),
          );
        },
      },
    ],
    sourcemap: false,
    target: 'es2022',
    treeShaking: true,
  });
}

async function packageWindows(config, stagedArtifact, architecture, scratchDirectory) {
  let icon = config.icons.windows;
  if (icon) {
    icon = await resolveContainedFile(config.root, icon, 'icons.windows');
    await validatePlatformIcon(icon, 'windows');
  }

  const appDirectory = path.join(scratchDirectory, 'app');
  const artifactsDirectory = path.join(scratchDirectory, 'artifacts');
  const publishDirectory = path.join(scratchDirectory, 'publish');
  await mkdir(appDirectory, { recursive: true });
  await mkdir(publishDirectory, { recursive: true });
  await buildJavaScript(config, path.join(appDirectory, 'main.js'));
  await writeManifest(config, appDirectory, 'windows', architecture);

  const args = [
    'publish',
    path.join(REPO_ROOT, 'hosts', 'windows', 'NatuiHost', 'NatuiHost.csproj'),
    '--configuration',
    'Release',
    '--runtime',
    `win-${architecture}`,
    '--self-contained',
    'true',
    '--artifacts-path',
    artifactsDirectory,
    '--output',
    publishDirectory,
    `-p:Platform=${architecture}`,
    `-p:AssemblyName=${escapeMsbuildPropertyValue(config.executable)}`,
    `-p:Product=${escapeMsbuildPropertyValue(config.name)}`,
    `-p:Version=${escapeMsbuildPropertyValue(config.version)}`,
    `-p:FileVersion=${escapeMsbuildPropertyValue(`${config.version}.${config.buildNumber}`)}`,
    `-p:InformationalVersion=${escapeMsbuildPropertyValue(
      `${config.version}+${config.buildNumber}`,
    )}`,
    `-p:NatuiAppDirectory=${escapeMsbuildPropertyValue(appDirectory)}`,
    '-p:PublishSingleFile=true',
    '-p:IncludeAllContentForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:DebugSymbols=false',
    '-p:DebugType=None',
  ];
  if (icon) args.push(`-p:ApplicationIcon=${escapeMsbuildPropertyValue(icon)}`);
  await run('dotnet', args);
  const publishedExecutable = path.join(publishDirectory, `${config.executable}.exe`);
  await assertFile(publishedExecutable, 'single-file Windows executable');
  await copyFile(publishedExecutable, stagedArtifact);
}

async function packageMac(config, stagedArtifact, architecture, scratchDirectory) {
  let icon = config.icons.macos;
  if (icon) {
    icon = await resolveContainedFile(config.root, icon, 'icons.macos');
    await validatePlatformIcon(icon, 'macos');
  }

  await run(
    'swift',
    [
      'build',
      '--configuration',
      'release',
      '--package-path',
      path.join(REPO_ROOT, 'hosts', 'macos'),
      '--product',
      'natui-host',
      '--scratch-path',
      scratchDirectory,
    ],
    REPO_ROOT,
    { NATUI_PACKAGE_APP: '1' },
  );

  const contents = path.join(stagedArtifact, 'Contents');
  const executableDirectory = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const appDirectory = path.join(resources, 'NatUI');
  await mkdir(executableDirectory, { recursive: true });
  await mkdir(appDirectory, { recursive: true });

  const builtHost = path.join(scratchDirectory, 'release', 'natui-host');
  await assertFile(builtHost, 'Swift release host');
  const executable = path.join(executableDirectory, config.executable);
  await copyFile(builtHost, executable);
  await chmod(executable, 0o755);

  await buildJavaScript(config, path.join(appDirectory, 'main.js'));
  await writeManifest(config, appDirectory, 'macos', architecture);
  await writeFile(
    path.join(contents, 'Info.plist'),
    renderMacInfoPlist(config, Boolean(icon)),
    'utf8',
  );
  await copyFile(path.join(REPO_ROOT, 'LICENSE'), path.join(resources, 'LICENSE.txt'));
  if (icon) await copyFile(icon, path.join(resources, 'AppIcon.icns'));
}

async function replaceArtifact(stagedArtifact, target) {
  const backup = `${target}.previous-${process.pid}`;
  let hadPrevious = false;
  try {
    await stat(target);
    hadPrevious = true;
  } catch {
    hadPrevious = false;
  }
  if (hadPrevious) {
    await rm(backup, { recursive: true, force: true });
    await rename(target, backup);
  }
  try {
    await rename(stagedArtifact, target);
  } catch (error) {
    if (hadPrevious) await rename(backup, target);
    throw error;
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true });
}

export async function packageApplication({
  configPath = DEFAULT_CONFIG,
  architecture: requestedArchitecture,
  outDir,
} = {}) {
  const absoluteConfig = path.resolve(configPath);
  const config = await loadAppConfig(absoluteConfig);

  if (outDir !== undefined) {
    config.outputPath = resolveOutputOverride(config.root, outDir);
  }

  let resolvedRoot;
  try {
    resolvedRoot = await realpath(config.root);
  } catch (error) {
    throw configurationError(
      `cannot resolve application directory ${config.root}: ${errorMessage(error)}`,
    );
  }
  config.entryPath = await resolveContainedFile(resolvedRoot, config.entryPath, 'entry');
  for (const platform of Object.keys(config.icons)) {
    config.icons[platform] = await resolveContainedFile(
      resolvedRoot,
      config.icons[platform],
      `icons.${platform}`,
    );
  }
  config.outputPath = await prepareContainedDirectory(
    resolvedRoot,
    config.outputPath,
    outDir === undefined ? 'output' : 'out-dir',
  );
  config.root = resolvedRoot;

  const platform = normalizePlatform();
  const architecture = normalizeArchitecture(requestedArchitecture);
  if (platform === 'macos' && requestedArchitecture && requestedArchitecture !== process.arch) {
    throw configurationError(
      'macOS cross-architecture packaging is not supported; build each architecture natively',
    );
  }

  const stageRoot = await mkdtemp(path.join(config.outputPath, '.natui-stage-'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'natui-native-'));
  const artifactName = platform === 'windows'
    ? `${config.executable}-${config.version}-windows-${architecture}.exe`
    : `${config.executable}.app`;
  const stagedArtifact = path.join(stageRoot, artifactName);
  const target = path.join(config.outputPath, artifactName);

  try {
    if (platform === 'windows') {
      await packageWindows(config, stagedArtifact, architecture, scratch);
    } else {
      await packageMac(config, stagedArtifact, architecture, scratch);
    }
    await assertSafeReplacementPaths(
      config.root,
      config.outputPath,
      stageRoot,
      stagedArtifact,
      target,
    );
    await replaceArtifact(stagedArtifact, target);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }

  return { target, platform, architecture };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--arch') {
      options.architecture = argv[++index];
    } else if (argument === '--out-dir') {
      options.outDir = argv[++index];
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw configurationError(`unknown option "${argument}"`);
    } else if (options.configPath) {
      throw configurationError('pass at most one natui.app.json path');
    } else {
      options.configPath = argument;
    }
  }
  if (argv.at(-1) === '--arch' || argv.at(-1) === '--out-dir') {
    throw configurationError(`${argv.at(-1)} requires a value`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(
        'Usage: node tools/package-app.mjs [natui.app.json] [--arch x64|arm64] '
          + '[--out-dir relative/path]',
      );
      return;
    }
    const result = await packageApplication(options);
    console.log(`NatUI application bundle: ${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
