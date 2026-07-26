import { spawn } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createMacIcon, createWindowsIcon } from './icons.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEMPLATE_ROOT = fileURLToPath(new URL('../template/', import.meta.url));
const DEFAULT_DIRECTORY = 'natui-app';
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const HELP = `Usage: create-natui-app [project-directory] [options]

Create a new NatUI application.

Options:
  -y, --yes                       Use natui-app when no directory is provided
      --no-install                Skip dependency installation
      --package-manager <name>    npm, pnpm, yarn, or bun
  -h, --help                      Show help
  -v, --version                   Show the package version
`;

export class CliUsageError extends Error {}

function takeOptionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(args) {
  const options = {
    directory: undefined,
    help: false,
    install: true,
    packageManager: undefined,
    version: false,
    yes: false,
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '-v' || argument === '--version') {
      options.version = true;
      continue;
    }
    if (argument === '-y' || argument === '--yes') {
      options.yes = true;
      continue;
    }
    if (argument === '--no-install') {
      options.install = false;
      continue;
    }
    if (argument === '--package-manager') {
      options.packageManager = takeOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith('--package-manager=')) {
      options.packageManager = argument.slice('--package-manager='.length);
      if (!options.packageManager) {
        throw new CliUsageError('--package-manager requires a value');
      }
      continue;
    }
    if (argument.startsWith('-')) {
      throw new CliUsageError(`unknown option "${argument}"`);
    }
    positional.push(argument);
  }

  if (positional.length > 1) {
    throw new CliUsageError(`unexpected argument "${positional[1]}"`);
  }
  if (options.packageManager && !PACKAGE_MANAGERS.has(options.packageManager)) {
    throw new CliUsageError(
      `unsupported package manager "${options.packageManager}", expected npm, pnpm, yarn, or bun`,
    );
  }
  options.directory = positional[0];
  return options;
}

export function detectPackageManager(userAgent = '') {
  for (const token of userAgent.split(/\s+/)) {
    const name = token.slice(0, token.indexOf('/'));
    if (PACKAGE_MANAGERS.has(name)) return name;
  }
  return 'npm';
}

function normalizeAscii(value) {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '');
}

export function projectMetadata(directoryName) {
  if (!directoryName || directoryName === '.' || directoryName === '..') {
    throw new CliUsageError('project directory must have a name');
  }
  if (WINDOWS_RESERVED_NAME.test(directoryName)) {
    throw new CliUsageError(`project directory name "${directoryName}" is reserved on Windows`);
  }

  const packageName = normalizeAscii(directoryName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!packageName) {
    throw new CliUsageError('project directory must contain at least one letter or number');
  }
  if (packageName.length > 214) {
    throw new CliUsageError('generated package name must be 214 characters or fewer');
  }

  const displayName = normalizeAscii(directoryName)
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/\bNatui\b/g, 'NatUI');
  if ([...displayName].length > 80) {
    throw new CliUsageError('generated application name must be 80 characters or fewer');
  }
  const executableBase = displayName.replace(/[^A-Za-z0-9]+/g, '');
  const executable = /^[A-Za-z]/.test(executableBase)
    ? executableBase
    : `NatUI${executableBase || 'App'}`;
  const idSegment = packageName.replace(/^-+|-+$/g, '') || 'app';

  return {
    appId: `com.example.${idSegment}`,
    displayName,
    executable,
    packageName,
  };
}

function replacementsFor(metadata, packageManager) {
  const runCommand = packageManager === 'npm'
    ? 'npm run'
    : packageManager === 'bun'
      ? 'bun run'
      : packageManager;
  return new Map([
    ['__APP_ID_JSON__', JSON.stringify(metadata.appId)],
    ['__DISPLAY_NAME_JSON__', JSON.stringify(metadata.displayName)],
    ['__EXECUTABLE_JSON__', JSON.stringify(metadata.executable)],
    ['__PACKAGE_NAME_JSON__', JSON.stringify(metadata.packageName)],
    ['__DISPLAY_NAME__', metadata.displayName],
    ['__INSTALL_COMMAND__', `${packageManager} install`],
    ['__RUN_COMMAND__', runCommand],
  ]);
}

function renderTemplate(source, replacements, relativePath) {
  let rendered = source;
  for (const [token, value] of replacements) {
    rendered = rendered.replaceAll(token, value);
  }
  const remaining = rendered.match(/__[A-Z][A-Z_]+__/);
  if (remaining) {
    throw new Error(`unresolved template token ${remaining[0]} in ${relativePath}`);
  }
  return rendered;
}

async function copyTemplateDirectory(source, destination, replacements, prefix = '') {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const templateName = entry.name === '_gitignore' ? '.gitignore' : entry.name;
    const outputName = templateName.endsWith('.tmpl')
      ? templateName.slice(0, -'.tmpl'.length)
      : templateName;
    const relativePath = path.join(prefix, outputName);
    const destinationPath = path.join(destination, outputName);

    if (entry.isSymbolicLink()) {
      throw new Error(`template contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(destinationPath);
      await copyTemplateDirectory(sourcePath, destinationPath, replacements, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`template contains an unsupported entry: ${relativePath}`);
    }
    if (entry.name.endsWith('.tmpl')) {
      const template = await readFile(sourcePath, 'utf8');
      await writeFile(
        destinationPath,
        renderTemplate(template, replacements, relativePath),
        'utf8',
      );
    } else {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function targetState(target) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new CliUsageError(`destination is a symbolic link: ${target}`);
  }
  if (!info.isDirectory()) {
    throw new CliUsageError(`destination is not a directory: ${target}`);
  }
  const entries = await readdir(target);
  if (entries.length > 0) {
    throw new CliUsageError(
      `destination is not empty: ${target}\nChoose a new directory or remove its contents first.`,
    );
  }
  return { exists: true };
}

function containsPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

export async function createProject({
  cwd = process.cwd(),
  directory,
  packageManager = 'npm',
} = {}) {
  if (!directory || typeof directory !== 'string') {
    throw new CliUsageError('project directory is required');
  }
  if (!PACKAGE_MANAGERS.has(packageManager)) {
    throw new CliUsageError(`unsupported package manager "${packageManager}"`);
  }

  const resolvedCwd = path.resolve(cwd);
  const target = path.resolve(resolvedCwd, directory);
  if (target === path.parse(target).root) {
    throw new CliUsageError('cannot create a project at a filesystem root');
  }
  if (containsPath(target, resolvedCwd)) {
    throw new CliUsageError(
      'destination cannot be the current directory or one of its parent directories',
    );
  }
  const metadata = projectMetadata(path.basename(target));
  const state = await targetState(target);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, `.${path.basename(target)}.create-`));
  let removedEmptyTarget = false;

  try {
    const replacements = replacementsFor(metadata, packageManager);
    await copyTemplateDirectory(TEMPLATE_ROOT, stage, replacements);
    const assets = path.join(stage, 'assets');
    await mkdir(assets, { recursive: true });
    await Promise.all([
      writeFile(path.join(assets, 'AppIcon.icns'), createMacIcon()),
      writeFile(path.join(assets, 'AppIcon.ico'), createWindowsIcon()),
    ]);

    if (state.exists) {
      await rmdir(target);
      removedEmptyTarget = true;
    }
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (removedEmptyTarget) {
      try {
        await stat(target);
      } catch (targetError) {
        if (targetError?.code === 'ENOENT') await mkdir(target);
      }
    }
    throw error;
  }

  return {
    ...metadata,
    packageManager,
    target,
  };
}

export function packageManagerExecutable(packageManager, platform = process.platform) {
  if (platform !== 'win32') return packageManager;
  return packageManager === 'bun' ? 'bun.exe' : `${packageManager}.cmd`;
}

export async function installDependencies({
  packageManager,
  target,
  runner = defaultInstallRunner,
}) {
  const command = packageManagerExecutable(packageManager);
  await runner({ args: ['install'], command, cwd: target });
}

async function defaultInstallRunner({ args, command, cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      reject(new Error(`could not start ${command}: ${error.message}`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      reject(new Error(`${command} install failed with ${reason}`));
    });
  });
}

export async function promptForDirectory({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const readline = createInterface({ input, output });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      readline.close();
      resolve(value);
    };
    readline.once('SIGINT', () => finish(null));
    readline.once('close', () => finish(null));
    readline.question(
      `Project directory (${DEFAULT_DIRECTORY}, or "cancel"): `,
      (answer) => {
        const value = answer.trim();
        finish(/^(?:cancel|q|quit)$/i.test(value) ? null : value || DEFAULT_DIRECTORY);
      },
    );
  });
}

async function readPackageVersion() {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  return manifest.version;
}

function runScriptCommand(packageManager, script) {
  if (packageManager === 'npm') return `npm run ${script}`;
  if (packageManager === 'bun') return `bun run ${script}`;
  return `${packageManager} ${script}`;
}

function installCommand(packageManager) {
  return `${packageManager} install`;
}

function displayPath(cwd, target) {
  const relative = path.relative(cwd, target) || '.';
  return /\s/.test(relative) ? `"${relative}"` : relative;
}

function write(stream, text) {
  stream.write(text);
}

export async function runCli(args, {
  cwd = process.cwd(),
  env = process.env,
  input = process.stdin,
  installRunner = defaultInstallRunner,
  output = process.stdout,
  prompt = promptForDirectory,
  errorOutput = process.stderr,
} = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    write(errorOutput, `create-natui-app: ${error.message}\n\n${HELP}`);
    return 1;
  }

  if (options.help) {
    write(output, HELP);
    return 0;
  }
  if (options.version) {
    write(output, `${await readPackageVersion()}\n`);
    return 0;
  }

  let directory = options.directory;
  if (!directory) {
    directory = options.yes ? DEFAULT_DIRECTORY : await prompt({ input, output });
    if (!directory) {
      write(output, '\nCancelled.\n');
      return 0;
    }
  }

  const packageManager = options.packageManager
    ?? detectPackageManager(env.npm_config_user_agent);
  let project;
  try {
    project = await createProject({ cwd, directory, packageManager });
  } catch (error) {
    write(errorOutput, `create-natui-app: ${error.message}\n`);
    return 1;
  }

  write(output, `\nCreated ${project.displayName} in ${project.target}\n`);
  if (options.install) {
    write(output, `\nInstalling dependencies with ${packageManager}...\n`);
    try {
      await installDependencies({
        packageManager,
        runner: installRunner,
        target: project.target,
      });
    } catch (error) {
      write(errorOutput, `\nDependency installation failed: ${error.message}\n`);
      write(errorOutput, 'The project was created successfully. Install dependencies manually:\n\n');
      write(errorOutput, `  cd ${displayPath(cwd, project.target)}\n`);
      write(errorOutput, `  ${installCommand(packageManager)}\n`);
      return 1;
    }
  }

  write(output, '\nNext steps:\n\n');
  write(output, `  cd ${displayPath(cwd, project.target)}\n`);
  if (!options.install) write(output, `  ${installCommand(packageManager)}\n`);
  write(output, `  ${runScriptCommand(packageManager, 'dev')}\n`);
  write(output, '\nSee the generated README for native host setup.\n');
  return 0;
}
