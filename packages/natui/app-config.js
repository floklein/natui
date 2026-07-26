import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_FILE = 'natui.app.json';

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

function configurationError(message, cause) {
  return new Error(`natui config: ${message}`, cause === undefined ? undefined : { cause });
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

function assertRelativePath(value, field, configFile = DEFAULT_CONFIG_FILE) {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${field} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    /^[A-Za-z]:/.test(value)
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(value)
  ) {
    throw configurationError(`${field} must be relative to ${configFile}`);
  }
  if (normalized === '.' || normalized.split('/').includes('..')) {
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

export function validateAppConfig(
  value,
  configDirectory = process.cwd(),
  configFile = DEFAULT_CONFIG_FILE,
) {
  if (!isPlainObject(value)) {
    throw configurationError(`${configFile} must contain a JSON object`);
  }
  rejectUnknownKeys(value, CONFIG_KEYS, 'top-level');

  if (
    value.$schema !== undefined
    && (typeof value.$schema !== 'string' || value.$schema.length === 0)
  ) {
    throw configurationError('$schema must be a non-empty string when provided');
  }
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
  if ([...value.name].length > 80) {
    throw configurationError('name must be 80 characters or fewer');
  }
  for (const character of value.name) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== 0x9
      && codePoint !== 0xa
      && codePoint !== 0xd
      && !(codePoint >= 0x20 && codePoint <= 0xd7ff)
      && !(codePoint >= 0xe000 && codePoint <= 0xfffd)
      && !(codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      throw configurationError('name contains a character that is not valid in XML 1.0');
    }
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
  assertRelativePath(value.entry, 'entry', configFile);
  if (typeof value.executable !== 'string' || !EXECUTABLE.test(value.executable)) {
    throw configurationError(
      'executable must start with a letter and contain only letters, numbers, ".", "_", or "-"',
    );
  }
  const output = value.output ?? 'dist/package';
  assertRelativePath(output, 'output', configFile);

  let icons = {};
  if (value.icons !== undefined) {
    if (!isPlainObject(value.icons)) {
      throw configurationError('icons must be an object');
    }
    rejectUnknownKeys(value.icons, ICON_KEYS, 'icons');
    icons = { ...value.icons };
    for (const [platform, icon] of Object.entries(icons)) {
      assertRelativePath(icon, `icons.${platform}`, configFile);
      const expectedExtension = platform === 'macos' ? '.icns' : '.ico';
      if (path.extname(icon).toLowerCase() !== expectedExtension) {
        throw configurationError(
          `icons.${platform} must use the native ${expectedExtension} format`,
        );
      }
    }
  }

  const root = path.resolve(configDirectory);
  const normalizedEntry = value.entry.replaceAll('\\', '/');
  const normalizedOutput = output.replaceAll('\\', '/');
  const entryPath = path.resolve(root, normalizedEntry);
  const outputPath = path.resolve(root, normalizedOutput);
  assertContained(root, entryPath, 'entry');
  assertContained(root, outputPath, 'output');

  const resolvedIcons = {};
  for (const [platform, icon] of Object.entries(icons)) {
    const iconPath = path.resolve(root, icon.replaceAll('\\', '/'));
    assertContained(root, iconPath, `icons.${platform}`);
    resolvedIcons[platform] = iconPath;
  }

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    id: value.id,
    name: value.name,
    version: value.version,
    buildNumber: value.buildNumber,
    entry: normalizedEntry,
    executable: value.executable,
    output: normalizedOutput,
    root,
    entryPath,
    outputPath,
    icons: resolvedIcons,
  };
}

export async function loadAppConfig(
  configPath = path.resolve(DEFAULT_CONFIG_FILE),
  { allowMissing = false } = {},
) {
  const absoluteConfig = path.resolve(configPath);
  let contents;
  try {
    contents = await readFile(absoluteConfig, 'utf8');
  } catch (error) {
    if (
      allowMissing
      && error !== null
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw configurationError(`cannot read ${absoluteConfig}: ${error.message}`, error);
  }

  let source;
  try {
    source = JSON.parse(contents);
  } catch (error) {
    throw configurationError(`cannot parse ${absoluteConfig}: ${error.message}`, error);
  }

  return validateAppConfig(source, path.dirname(absoluteConfig), path.basename(absoluteConfig));
}
