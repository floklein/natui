#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  DEFAULT_CONFIG_FILE,
  loadAppConfig,
} from '../app-config.js';

process.env.NODE_ENV = 'development';

const HELP = `Usage: natui dev [entry]

Start the native development server with React Fast Refresh.
Entry precedence is the command argument, ${DEFAULT_CONFIG_FILE}, then
src/main.tsx in the current directory.

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

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const [command, entry, ...rest] = args;
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
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
