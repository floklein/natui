import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostCommand } from './transport.js';

/**
 * Find the native host binary for the current platform.
 * Order: NATUI_HOST env var, then well-known build locations walking up
 * from cwd (so examples inside the monorepo find the freshly built host).
 */
export function defaultHostCommand(): HostCommand {
  const fromEnv = process.env.NATUI_HOST;
  if (fromEnv) return { cmd: fromEnv };

  const candidates =
    process.platform === 'darwin'
      ? [
          'hosts/macos/.build/release/natui-host',
          'hosts/macos/.build/debug/natui-host',
        ]
      : process.platform === 'win32'
        ? [
            'hosts/windows/NatuiHost/bin/Release/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe',
            'hosts/windows/NatuiHost/bin/Debug/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe',
            'hosts/windows/NatuiHost/bin/x64/Debug/net8.0-windows10.0.19041.0/win-x64/NatuiHost.exe',
          ]
        : [];

  if (candidates.length === 0) {
    throw new Error(
      `natui: unsupported platform "${process.platform}". Set NATUI_HOST to a host binary.`,
    );
  }

  let dir = process.cwd();
  for (;;) {
    for (const rel of candidates) {
      const full = join(dir, rel);
      if (existsSync(full)) return { cmd: full };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const buildHint =
    process.platform === 'darwin'
      ? 'Build it with: swift build -c release --package-path hosts/macos'
      : 'Build it with: dotnet build hosts/windows/NatuiHost';
  throw new Error(`natui: host binary not found. ${buildHint} (or set NATUI_HOST)`);
}
