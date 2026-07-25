import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  moduleResolve,
  type ErrnoException,
} from 'import-meta-resolve';

export interface SourceResolutionOptions {
  conditions: Set<string>;
  preserveSymlinks: boolean;
  preserveSymlinksMain: boolean;
}

interface SourceResolutionFlags {
  addons: boolean;
  preserveSymlinks: boolean;
  preserveSymlinksMain: boolean;
  userConditions: Set<string>;
}

function nodeOptionsArguments(value: string | undefined): string[] {
  if (!value) return [];
  const arguments_: string[] = [];
  let inString = false;
  let startArgument = true;
  for (let index = 0; index < value.length; index += 1) {
    let character = value[index]!;
    if (character === '\\' && inString && index + 1 < value.length) {
      index += 1;
      character = value[index]!;
    } else if (character === ' ' && !inString) {
      startArgument = true;
      continue;
    } else if (character === '"') {
      inString = !inString;
      continue;
    }

    if (startArgument) {
      arguments_.push(character);
      startArgument = false;
    } else {
      arguments_[arguments_.length - 1] += character;
    }
  }
  return arguments_;
}

function applyResolutionArguments(
  flags: SourceResolutionFlags,
  arguments_: readonly string[],
): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const equalsIndex = argument.indexOf('=');
    const rawName =
      equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const name = rawName.startsWith('--')
      ? rawName.replaceAll('_', '-')
      : rawName;

    if (name === '-C' || name === '--conditions') {
      let condition =
        equalsIndex !== -1 && name === '--conditions'
          ? argument.slice(equalsIndex + 1)
          : arguments_[index + 1];
      if (condition !== undefined) {
        if (equalsIndex === -1 && condition.startsWith('\\-')) {
          condition = condition.slice(1);
        }
        flags.userConditions.add(condition);
        if (equalsIndex === -1) index += 1;
      }
    } else if (name === '--preserve-symlinks') {
      flags.preserveSymlinks = true;
    } else if (name === '--no-preserve-symlinks') {
      flags.preserveSymlinks = false;
    } else if (name === '--preserve-symlinks-main') {
      flags.preserveSymlinksMain = true;
    } else if (name === '--no-preserve-symlinks-main') {
      flags.preserveSymlinksMain = false;
    } else if (name === '--no-addons') {
      flags.addons = false;
    } else if (name === '--addons') {
      flags.addons = true;
    }
  }
}

function sourceResolutionOptions(): SourceResolutionOptions {
  const flags: SourceResolutionFlags = {
    addons: true,
    preserveSymlinks: process.env.NODE_PRESERVE_SYMLINKS === '1',
    preserveSymlinksMain:
      process.env.NODE_PRESERVE_SYMLINKS_MAIN === '1',
    userConditions: new Set(),
  };
  applyResolutionArguments(
    flags,
    nodeOptionsArguments(process.env.NODE_OPTIONS),
  );
  applyResolutionArguments(flags, process.execArgv);

  const conditions = new Set(['node', 'import']);
  if (process.features.require_module === true) {
    conditions.add('module-sync');
  }
  if (flags.addons) conditions.add('node-addons');
  for (const condition of flags.userConditions) {
    conditions.add(condition);
  }
  return {
    conditions,
    preserveSymlinks: flags.preserveSymlinks,
    preserveSymlinksMain: flags.preserveSymlinksMain,
  };
}

export const SOURCE_RESOLUTION_OPTIONS = sourceResolutionOptions();

export function canonicalSourceUrl(
  source: string | URL,
  main = false,
): URL {
  const url = new URL(source);
  if (url.protocol !== 'file:') return url;
  const preserveSymlinks = main
    ? SOURCE_RESOLUTION_OPTIONS.preserveSymlinksMain
    : SOURCE_RESOLUTION_OPTIONS.preserveSymlinks;
  if (preserveSymlinks) return url;

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(fileURLToPath(url));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return url;
    throw error;
  }
  const canonicalUrl = pathToFileURL(canonicalPath);
  canonicalUrl.search = url.search;
  canonicalUrl.hash = url.hash;
  return canonicalUrl;
}

export function resolveSourceSpecifier(
  specifier: string,
  parentUrl: string | URL,
  main = false,
): string {
  const normalizedSpecifier = `${specifier}`;
  try {
    return moduleResolve(
      normalizedSpecifier,
      canonicalSourceUrl(parentUrl, main),
      SOURCE_RESOLUTION_OPTIONS.conditions,
      SOURCE_RESOLUTION_OPTIONS.preserveSymlinks,
    ).href;
  } catch (error) {
    const exception = error as ErrnoException;
    if (
      (
        exception.code === 'ERR_UNSUPPORTED_DIR_IMPORT' ||
        exception.code === 'ERR_MODULE_NOT_FOUND'
      ) &&
      typeof exception.url === 'string'
    ) {
      return exception.url;
    }
    throw error;
  }
}
