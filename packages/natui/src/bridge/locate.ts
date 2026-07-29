import { existsSync, globSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/**
 * Find the native host binary for the current platform.
 * Order: NATUI_HOST env var, then well-known build locations walking up
 * from cwd (so examples inside the monorepo find the freshly built host).
 */
export function defaultHostCommand(): HostCommand {
  const fromEnv = process.env.NATUI_HOST;
  if (fromEnv) return { cmd: fromEnv };

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(
      `natui: unsupported platform "${process.platform}". Set NATUI_HOST to a host binary.`,
    );
  }

  let dir = process.cwd();
  let sawHostsDirectory = false;
  for (;;) {
    if (existsSync(join(dir, 'hosts'))) sawHostsDirectory = true;
    if (process.platform === 'darwin') {
      for (const rel of MACOS_CANDIDATES) {
        const full = join(dir, rel);
        if (existsSync(full)) return { cmd: full };
      }
    } else {
      const found = newestMatch(dir, WINDOWS_GLOB);
      if (found) return { cmd: found };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const buildHint =
    process.platform === 'darwin'
      ? 'Build it with: swift build -c release --package-path hosts/macos'
      : 'Build it with: dotnet build hosts/windows/NatuiHost';
  throw new Error(
    sawHostsDirectory
      ? `natui: host binary not found, but a hosts/ directory exists — it has not been built yet. ${buildHint} (or set NATUI_HOST)`
      : `natui: host binary not found and no hosts/ directory was found above ${process.cwd()}. ` +
        `Set NATUI_HOST to a host binary, or run from a NatUI checkout. ${buildHint}`,
  );
}
