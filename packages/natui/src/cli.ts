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

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const [command, entry, ...rest] = args;
  if (command !== 'dev') throw new Error(`natui: unknown command "${command}"`);
  if (rest.length > 0) throw new Error(`natui: unexpected argument "${rest[0]}"`);

  const config = entry === undefined
    ? await loadAppConfig(resolve(DEFAULT_CONFIG_FILE), { allowMissing: true })
    : undefined;
  const { createDevServer } = await import('./dev/server.js');
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
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
