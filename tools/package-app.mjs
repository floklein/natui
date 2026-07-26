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
const JPEG2000_FILE_SIGNATURE = Buffer.from([
  0, 0, 0, 12,
  0x6a, 0x50, 0x20, 0x20,
  0x0d, 0x0a, 0x87, 0x0a,
]);

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Walk the PNG chunk stream and verify each chunk's declared length, type and
 * CRC. This is container-level integrity checking, not pixel decoding: it is
 * what catches an icon corrupted in transit or by a bad build step, which the
 * embedding toolchains (MSBuild, the .app bundle) would otherwise ship as-is.
 */
function inspectPngChunks(bytes, field) {
  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw configurationError(`${field} has a truncated PNG chunk header`);
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw configurationError(`${field} has a bad PNG chunk type at byte ${offset + 4}`);
    }
    const end = offset + 12 + length;
    if (length > bytes.length || end > bytes.length) {
      throw configurationError(`${field} has an out-of-range PNG ${type} chunk length`);
    }
    const expected = bytes.readUInt32BE(end - 4);
    const actual = crc32(bytes.subarray(offset + 4, end - 4));
    if (expected !== actual) {
      throw configurationError(`${field} has a bad PNG checksum on its ${type} chunk`);
    }
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawEnd) {
    throw configurationError(`${field} is missing its PNG IEND chunk`);
  }
}

function inspectPngImage(bytes, expectedWidth, expectedHeight, field) {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw configurationError(`${field} is not a valid PNG image`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw configurationError(`${field} must begin with a PNG IHDR chunk`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw configurationError(`${field} has an invalid PNG IHDR chunk`);
  }
  if (width !== expectedWidth || height !== expectedHeight) {
    throw configurationError(
      `${field} is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  inspectPngChunks(bytes, field);
}

function hasSignature(bytes, signature) {
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature);
}

function inspectMacImage(bytes, type, size) {
  const field = `icons.macos ${type} image payload`;
  if (LEGACY_MAC_ICON_CHUNKS.has(type)) return;
  if (hasSignature(bytes, PNG_SIGNATURE)) {
    inspectPngImage(bytes, size, size, field);
    return;
  }
  if (hasSignature(bytes, JPEG2000_FILE_SIGNATURE)) return;
  throw configurationError(`${field} must use complete PNG or JPEG 2000 image data`);
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
      byteLength === 0
      || imageOffset < directoryLength
      || imageOffset + byteLength > bytes.length
    ) {
      throw configurationError(`icons.windows has an invalid ICO image at index ${index}`);
    }
    const payload = bytes.subarray(imageOffset, imageOffset + byteLength);
    if (hasSignature(payload, PNG_SIGNATURE)) {
      inspectPngImage(payload, width, height, `icons.windows image at index ${index}`);
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
  let icon = config.iconPaths.windows;
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
  let icon = config.iconPaths.macos;
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
  let hadPrevious;
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

function buildCacheRequested(requested) {
  if (requested !== undefined) return Boolean(requested);
  const flag = process.env.NATUI_BUILD_CACHE;
  return flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false';
}

export async function packageApplication({
  configPath = DEFAULT_CONFIG,
  architecture: requestedArchitecture,
  outDir,
  buildCache,
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
  for (const platform of Object.keys(config.iconPaths)) {
    config.iconPaths[platform] = await resolveContainedFile(
      resolvedRoot,
      config.iconPaths[platform],
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
  const incremental = buildCacheRequested(buildCache);
  let scratch;
  if (incremental) {
    scratch = path.join(REPO_ROOT, '.natui-build', `${platform}-${architecture}`);
    await mkdir(scratch, { recursive: true });
  } else {
    scratch = await mkdtemp(path.join(tmpdir(), 'natui-native-'));
  }
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
    const cleanup = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };
    await rm(stageRoot, cleanup).catch(() => {});
    if (!incremental) await rm(scratch, cleanup).catch(() => {});
  }

  return { target, platform, architecture };
}

function optionValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) {
    throw configurationError(`${flag} requires a value`);
  }
  return value;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--arch') {
      options.architecture = optionValue(argv, ++index, '--arch');
    } else if (argument === '--out-dir') {
      options.outDir = optionValue(argv, ++index, '--out-dir');
    } else if (argument === '--build-cache') {
      options.buildCache = true;
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
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(
        'Usage: node tools/package-app.mjs [natui.app.json] [--arch x64|arm64] '
          + '[--out-dir relative/path] [--build-cache]',
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
