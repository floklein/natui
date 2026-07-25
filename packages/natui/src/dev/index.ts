import type {
  DevServerOptions,
  NatuiDevServer,
} from './server.js';

export type { DevServerOptions, NatuiDevServer };

export async function createDevServer(
  options: DevServerOptions = {},
): Promise<NatuiDevServer> {
  process.env.NODE_ENV = 'development';
  const server = await import('./server.js');
  return server.createDevServer(options);
}
