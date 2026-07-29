import { existsSync, globSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findCachedHost, installHost } from './host-cache.js';
import type { HostCommand } from './transport.js';

const MACOS_CANDIDATES = [
  'hosts/macos/.build/release/natui-host',
  'hosts/macos/.build/debug/natui-host',
];

/**
 * Any RID/configuration/target-framework the csproj can produce, newest wins.
 * A literal list would pin one arch and one TFM, so an arm64 build the csproj
 * explicitly supports would report "host binary not found".
 */
const WINDOWS_GLOB = 'hosts/windows/NatuiHost/bin/**/NatuiHost.exe';

function newestMatch(dir: string, pattern: string): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const match of globSync(pattern, { cwd: dir })) {
    const full = join(dir, match);
    try {
      const { mtimeMs } = statSync(full);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
    } catch {
      // Raced with a rebuild deleting the file; just skip it.
    }
  }
  return newest?.path;
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(
      `natui: unsupported platform "${process.platform}". Set NATUI_HOST to a host binary.`,
    );
  }
}

/**
 * Probe every synchronous host location: NATUI_HOST env var, well-known
 * build locations walking up from cwd (so examples inside the monorepo find
 * the freshly built host), then the per-user download cache.
 * Returns undefined when only a download could produce a host.
 */
function probeHostCommand(): { found?: HostCommand; sawHostsDirectory: boolean } {
  const fromEnv = process.env.NATUI_HOST;
  if (fromEnv) return { found: { cmd: fromEnv }, sawHostsDirectory: false };

  assertSupportedPlatform();

  let dir = process.cwd();
  let sawHostsDirectory = false;
  for (;;) {
    if (existsSync(join(dir, 'hosts'))) sawHostsDirectory = true;
    if (process.platform === 'darwin') {
      for (const rel of MACOS_CANDIDATES) {
        const full = join(dir, rel);
        if (existsSync(full)) return { found: { cmd: full }, sawHostsDirectory };
      }
    } else {
      const found = newestMatch(dir, WINDOWS_GLOB);
      if (found) return { found: { cmd: found }, sawHostsDirectory };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // In a source checkout the developer's own build is the only acceptable
  // host; a cached download would silently desync from their sources.
  if (!sawHostsDirectory) {
    const cached = findCachedHost();
    if (cached) return { found: { cmd: cached }, sawHostsDirectory };
  }

  return { sawHostsDirectory };
}

function notFoundError(sawHostsDirectory: boolean): Error {
  const buildHint =
    process.platform === 'darwin'
      ? 'Build it with: swift build -c release --package-path hosts/macos'
      : 'Build it with: dotnet build hosts/windows/NatuiHost';
  return new Error(
    sawHostsDirectory
      ? `natui: host binary not found, but a hosts/ directory exists, so it has not been built yet. ${buildHint} (or set NATUI_HOST)`
      : `natui: host binary not found above ${process.cwd()}. ` +
        'Download a prebuilt host with: npx natui host install. ' +
        `Or set NATUI_HOST to a host binary. ${buildHint}`,
  );
}

/**
 * Find the native host binary for the current platform.
 * Order: NATUI_HOST env var, well-known build locations walking up from cwd,
 * then the per-user download cache. Synchronous, so it never downloads;
 * `ensureHostCommand()` is the resolver that can.
 */
export function defaultHostCommand(): HostCommand {
  const { found, sawHostsDirectory } = probeHostCommand();
  if (found) return found;
  throw notFoundError(sawHostsDirectory);
}

/**
 * Like `defaultHostCommand()`, but downloads the release's prebuilt host into
 * the per-user cache when nothing local matches. `run()` uses this, so an app
 * installed from npm works without a NatUI source checkout.
 */
export async function ensureHostCommand(): Promise<HostCommand> {
  const { found, sawHostsDirectory } = probeHostCommand();
  if (found) return found;
  // Inside a checkout the developer wants their own build, not a download
  // that would shadow it and desync from the sources.
  if (sawHostsDirectory) throw notFoundError(sawHostsDirectory);
  return { cmd: await installHost() };
}
