#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  DEFAULT_CONFIG_FILE,
  loadAppConfig,
} from '../app-config.js';

process.env.NODE_ENV = 'development';

const HELP = `Usage: natui <command>

Commands:
  dev [entry]            Start the native development server with React Fast
                         Refresh. Entry precedence is the command argument,
                         ${DEFAULT_CONFIG_FILE}, then src/main.tsx in the
                         current directory.
  host install [--force] Download the prebuilt native host for this release
                         into the per-user cache. Runs automatically on first
                         launch; --force re-downloads.
  host path              Print the host executable that would be used.

Options:
  -h, --help  Show this help
`;

/** A mistake in how the command was invoked: show the message and usage, not a stack. */
class CliUsageError extends Error {}

/** The slice of `@natui/dev` this command drives. */
interface DevServerModule {
  createDevServer(options: {
    entry?: string;
    root?: string;
  }): Promise<{ close(): Promise<void> }>;
}

/**
 * The development server lives in `@natui/dev`, which owns the rollup / babel /
 * esbuild toolchain. Keeping it out of `@natui/core` means shipping an app does
 * not drag a build toolchain into its dependency tree.
 *
 * The specifier goes through a variable on purpose: a literal would make
 * `@natui/dev` a compile-time dependency of `@natui/core`, and the two packages
 * depend on each other the other way round.
 */
const DEV_PACKAGE = '@natui/dev';

async function loadDevServer(): Promise<DevServerModule> {
  try {
    return (await import(DEV_PACKAGE)) as DevServerModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'natui: the development server lives in a separate package.\n' +
          '  Install it with:  npm install --save-dev @natui/dev',
        { cause: error },
      );
    }
    throw error;
  }
}

async function runHostCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === 'install') {
    const force = rest.includes('--force');
    const unknown = rest.find((argument) => argument !== '--force');
    if (unknown !== undefined) {
      throw new CliUsageError(`natui: unknown option "${unknown}"`);
    }
    const { installHost } = await import('./bridge/host-cache.js');
    const executable = await installHost({ force });
    console.log(executable);
    return;
  }
  if (action === 'path') {
    if (rest.length > 0) throw new CliUsageError(`natui: unexpected argument "${rest[0]}"`);
    const { defaultHostCommand } = await import('./bridge/locate.js');
    console.log(defaultHostCommand().cmd);
    return;
  }
  throw new CliUsageError(
    action === undefined
      ? 'natui: "host" needs an action: install or path'
      : `natui: unknown host action "${action}"`,
  );
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const [command, entry, ...rest] = args;
  if (command === 'host') {
    await runHostCommand([entry, ...rest].filter((a): a is string => a !== undefined));
    return;
  }
  if (command !== 'dev') throw new CliUsageError(`natui: unknown command "${command}"`);
  // Without this, an unrecognized flag is silently resolved as an entry path
  // (`natui dev --watch` would look for a file literally named "--watch").
  for (const argument of [entry, ...rest]) {
    if (argument !== undefined && argument.startsWith('-')) {
      throw new CliUsageError(`natui: unknown option "${argument}"`);
    }
  }
  if (rest.length > 0) throw new CliUsageError(`natui: unexpected argument "${rest[0]}"`);

  const config = entry === undefined
    ? await loadAppConfig(resolve(DEFAULT_CONFIG_FILE), { allowMissing: true })
    : undefined;
  const { createDevServer } = await loadDevServer();
  const server = await createDevServer({
    entry: entry ?? config?.entryPath,
    root: config?.root,
  });
  let closePromise: Promise<void> | undefined;

  const close = () => {
    closePromise ??= server.close();
    return closePromise;
  };

  const stop = () => {
    const failSafe = setTimeout(() => process.exit(1), 2_000);
    failSafe.unref();
    void close().then(
      () => {
        clearTimeout(failSafe);
        process.exit(0);
      },
      (error) => {
        clearTimeout(failSafe);
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    console.error(`\n${HELP}`);
  } else if (error instanceof Error && error.message.startsWith('natui:')) {
    // An expected failure state that carries its own guidance (host not
    // found, download failed); a stack trace only buries it.
    console.error(error.message);
    if (error.cause !== undefined) console.error(String(error.cause));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
