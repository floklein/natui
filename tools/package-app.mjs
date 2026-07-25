#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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

export const APP_SCHEMA_VERSION = 1;
export const BUNDLE_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const HOST_API_VERSION = 1;

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..');
const DEFAULT_CONFIG = 'natui.app.json';
const CONFIG_KEYS = new Set([
  '$schema',
  'schemaVersion',
  'id',
  'name',
  'version',
  'buildNumber',
  'entry',
  'executable',
  'output',
  'icons',
]);
const ICON_KEYS = new Set(['macos', 'windows']);
const APP_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const EXECUTABLE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[a-f0-9]{64}$/;

function configurationError(message) {
  return new Error(`natui package: ${message}`);
}

function rejectUnknownKeys(value, allowed, at) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw configurationError(`unknown ${at} property "${key}"`);
    }
  }
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${field} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value)) {
    throw configurationError(`${field} must be relative to natui.app.json`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
  ) {
    throw configurationError(`${field} must stay inside the application directory`);
  }
}

function assertContained(root, candidate, field) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '.') return;
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw configurationError(`${field} must stay inside the application directory`);
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

export function validateAppConfig(value, configDirectory = process.cwd()) {
  if (!isPlainObject(value)) {
    throw configurationError('natui.app.json must contain a JSON object');
  }
  rejectUnknownKeys(value, CONFIG_KEYS, 'top-level');

  if (value.schemaVersion !== APP_SCHEMA_VERSION) {
    throw configurationError(`schemaVersion must be ${APP_SCHEMA_VERSION}`);
  }
  if (typeof value.id !== 'string' || !APP_ID.test(value.id)) {
    throw configurationError(
      'id must be a lowercase reverse-DNS identifier such as "dev.example.myapp"',
    );
  }
  if (typeof value.name !== 'string' || value.name.trim() !== value.name || !value.name) {
    throw configurationError('name must be a non-empty string without outer whitespace');
  }
  if (value.name.length > 80) {
    throw configurationError('name must be 80 characters or fewer');
  }
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw configurationError('version must contain three numeric parts, for example "1.2.3"');
  }
  const versionParts = value.version.split('.').map(Number);
  if (versionParts.some((part) => part > 65_535)) {
    throw configurationError('each version part must be 65535 or lower');
  }
  if (
    typeof value.buildNumber !== 'string'
    || !/^[1-9]\d*$/.test(value.buildNumber)
    || Number(value.buildNumber) > 65_535
  ) {
    throw configurationError('buildNumber must be an integer string from 1 through 65535');
  }
  assertRelativePath(value.entry, 'entry');
  if (typeof value.executable !== 'string' || !EXECUTABLE.test(value.executable)) {
    throw configurationError(
      'executable must start with a letter and contain only letters, numbers, ".", "_", or "-"',
    );
  }
  const output = value.output ?? 'dist/package';
  assertRelativePath(output, 'output');

  let icons = {};
  if (value.icons !== undefined) {
    if (!isPlainObject(value.icons)) {
      throw configurationError('icons must be an object');
    }
    rejectUnknownKeys(value.icons, ICON_KEYS, 'icons');
    icons = { ...value.icons };
    for (const [platform, icon] of Object.entries(icons)) {
      assertRelativePath(icon, `icons.${platform}`);
    }
  }

  const root = path.resolve(configDirectory);
  const entryPath = path.resolve(root, value.entry);
  const outputPath = path.resolve(root, output);
  assertContained(root, entryPath, 'entry');
  assertContained(root, outputPath, 'output');

  const resolvedIcons = {};
  for (const [platform, icon] of Object.entries(icons)) {
    const iconPath = path.resolve(root, icon);
    assertContained(root, iconPath, `icons.${platform}`);
    resolvedIcons[platform] = iconPath;
  }

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    id: value.id,
    name: value.name,
    version: value.version,
    buildNumber: value.buildNumber,
    entry: value.entry.replaceAll('\\', '/'),
    executable: value.executable,
    output: output.replaceAll('\\', '/'),
    root,
    entryPath,
    outputPath,
    icons: resolvedIcons,
  };
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

async function buildJavaScript(config, outputFile) {
  await buildWithEsbuild({
    absWorkingDir: config.root,
    entryPoints: [config.entryPath],
    outfile: outputFile,
    bundle: true,
    charset: 'utf8',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    format: 'iife',
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'info',
    minify: true,
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
    treeShaking: true,
  });
}

async function packageWindows(config, stagedArtifact, architecture, scratchDirectory) {
  const icon = config.icons.windows;
  if (icon) await assertFile(icon, 'icons.windows');

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
    `-p:AssemblyName=${config.executable}`,
    `-p:Product=${config.name}`,
    `-p:Version=${config.version}`,
    `-p:FileVersion=${config.version}.${config.buildNumber}`,
    `-p:InformationalVersion=${config.version}+${config.buildNumber}`,
    `-p:NatuiAppDirectory=${appDirectory}`,
    '-p:PublishSingleFile=true',
    '-p:IncludeAllContentForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:DebugSymbols=false',
    '-p:DebugType=None',
  ];
  if (icon) args.push(`-p:ApplicationIcon=${icon}`);
  await run('dotnet', args);
  const publishedExecutable = path.join(publishDirectory, `${config.executable}.exe`);
  await assertFile(publishedExecutable, 'single-file Windows executable');
  await copyFile(publishedExecutable, stagedArtifact);
}

async function packageMac(config, stagedArtifact, architecture, scratchDirectory) {
  const icon = config.icons.macos;
  if (icon) await assertFile(icon, 'icons.macos');

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
  let source;
  try {
    source = JSON.parse(await readFile(absoluteConfig, 'utf8'));
  } catch (error) {
    throw configurationError(`cannot read ${absoluteConfig}: ${error.message}`);
  }
  const config = validateAppConfig(source, path.dirname(absoluteConfig));
  await assertFile(config.entryPath, 'entry');

  if (outDir !== undefined) {
    assertRelativePath(outDir, 'out-dir');
    const resolved = path.resolve(config.root, outDir);
    assertContained(config.root, resolved, 'out-dir');
    config.outputPath = resolved;
  }

  const platform = normalizePlatform();
  const architecture = normalizeArchitecture(requestedArchitecture);
  if (platform === 'macos' && requestedArchitecture && requestedArchitecture !== process.arch) {
    throw configurationError(
      'macOS cross-architecture packaging is not supported; build each architecture natively',
    );
  }

  await mkdir(config.outputPath, { recursive: true });
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
