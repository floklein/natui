import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Prebuilt native hosts are too large to ship inside the npm package (the
 * Windows host is a ~200 MB self-contained WinUI 3 folder), so releases attach
 * them to the GitHub release for the same version. This module downloads the
 * matching archive once, verifies its SHA-256 against the published sibling
 * checksum file, and installs it into a per-user cache that `locate.ts` probes
 * synchronously on later runs.
 */

/** Marker written last; its presence means the cache entry is complete. */
const OK_MARKER = '.natui-host-ok';

export interface HostRelease {
  version: string;
  target: string;
  assetName: string;
  /** Directory the archive extracts into and the executable lives in. */
  directory: string;
  executable: string;
  url: string;
  checksumUrl: string;
}

/** Release asset target for this machine, e.g. `windows-x64`. */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  // The macOS host ships as one universal binary, so both Apple architectures
  // share an asset.
  if (platform === 'darwin') return 'macos-universal';
  if (platform === 'win32') {
    if (arch === 'x64' || arch === 'arm64') return `windows-${arch}`;
    throw new Error(`natui: no prebuilt Windows host for architecture "${arch}"`);
  }
  throw new Error(
    `natui: unsupported platform "${platform}". Set NATUI_HOST to a host binary.`,
  );
}

export function hostAssetName(version: string, target: string): string {
  return `natui-host-${version}-${target}.tar.gz`;
}

/** The version of `@natui/core` this module shipped in. */
export function packageVersion(): string {
  const packageJson = new URL('../../package.json', import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(packageJson, 'utf8');
  } catch (cause) {
    // Bundlers rewrite import.meta.url, so the manifest can be unreachable.
    throw new Error(
      'natui: could not read the @natui/core package manifest to pick a host release. ' +
        'Set NATUI_HOST to a host binary.',
      { cause },
    );
  }
  const { version } = JSON.parse(raw) as { version: string };
  return version;
}

/**
 * Per-user cache root. `NATUI_HOST_CACHE_DIR` overrides it (tests, CI,
 * restricted home directories).
 */
export function hostCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.NATUI_HOST_CACHE_DIR;
  if (override) return override;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'natui', 'hosts');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'natui', 'hosts');
  }
  return join(homedir(), '.cache', 'natui', 'hosts');
}

function hostExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'NatuiHost.exe' : 'natui-host';
}

/** Everything about the release asset for `version` on this machine. */
export function hostRelease(
  version: string = packageVersion(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): HostRelease {
  const target = hostTarget(platform, arch);
  const assetName = hostAssetName(version, target);
  const base =
    env.NATUI_HOST_BASE_URL ??
    `https://github.com/floklein/natui/releases/download/v${version}`;
  const directory = join(hostCacheRoot(env, platform), version, target);
  return {
    version,
    target,
    assetName,
    directory,
    executable: join(directory, hostExecutableName(platform)),
    url: `${base}/${assetName}`,
    checksumUrl: `${base}/${assetName}.sha256`,
  };
}

/**
 * Fully installed cached host executable for this machine, or undefined.
 * Synchronous so `defaultHostCommand()` can keep its public signature.
 */
export function findCachedHost(
  version?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let release: HostRelease;
  try {
    // The version default stays inside the try: packageVersion() can throw
    // (default parameters evaluate before the body), and a cache probe must
    // never take down a resolver that has other fallbacks.
    release = hostRelease(version ?? packageVersion(), platform, arch, env);
  } catch {
    return undefined;
  }
  const complete =
    existsSync(join(release.directory, OK_MARKER)) && existsSync(release.executable);
  return complete ? release.executable : undefined;
}

/** First 64-hex-digit token in a `<hex>  <name>` checksum file. */
export function parseSha256(checksumText: string): string {
  const match = checksumText.match(/\b[0-9a-fA-F]{64}\b/);
  if (!match) throw new Error('natui: malformed host checksum file');
  return match[0].toLowerCase();
}

async function fetchOk(url: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept } });
  } catch (cause) {
    // Node's fetch ignores proxy env vars unless NODE_USE_ENV_PROXY is set
    // (Node 22.18+), which is the usual reason npm install worked but this
    // download cannot connect.
    const proxy =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy;
    const proxyHint =
      proxy && !process.env.NODE_USE_ENV_PROXY
        ? ' A proxy is configured but Node fetch does not use it by default; retry with NODE_USE_ENV_PROXY=1.'
        : '';
    throw new Error(
      `natui: could not reach ${url} to download the native host.` +
        proxyHint +
        ' Check the network connection, or build the host from source and set NATUI_HOST.',
      { cause },
    );
  }
  if (response.status === 404) {
    throw new Error(
      `natui: this release has no prebuilt native host at ${url}. ` +
        'Only tagged releases publish host assets; a git or pack install reuses ' +
        'the last released version number without a matching host. ' +
        'Build the host from a NatUI checkout and set NATUI_HOST, or install a released @natui/core.',
    );
  }
  if (!response.ok) {
    throw new Error(`natui: host download failed with HTTP ${response.status} for ${url}`);
  }
  return response;
}

function systemTar(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  // Windows 10+ and macOS both ship bsdtar. Absolute paths dodge PATH issues.
  if (platform === 'win32') {
    return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  if (platform === 'darwin') return '/usr/bin/tar';
  return 'tar';
}

function extractArchive(archive: string, into: string): void {
  const tar = systemTar(process.platform, process.env);
  const result = spawnSync(tar, ['-xzf', archive, '-C', into], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error) {
    throw new Error(`natui: could not run ${tar} to extract the host archive`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(
      `natui: extracting the host archive failed (tar exited ${result.status})` +
        (stderr ? `:\n${stderr}` : ''),
    );
  }
}

/**
 * Download, verify, and install the prebuilt host for this machine.
 * Returns the executable path. No-op when the cache already has it.
 */
export async function installHost(options?: {
  version?: string;
  force?: boolean;
  log?: (message: string) => void;
}): Promise<string> {
  const log = options?.log ?? ((message: string) => console.error(message));
  const release = hostRelease(options?.version);

  if (!options?.force) {
    const cached = findCachedHost(release.version);
    if (cached) return cached;
  }

  const checksumResponse = await fetchOk(release.checksumUrl, 'text/plain');
  const expected = parseSha256(await checksumResponse.text());

  log(`natui: downloading native host ${release.version} (${release.target})...`);
  const response = await fetchOk(release.url, 'application/octet-stream');
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `natui: host archive checksum mismatch for ${release.assetName} ` +
        `(expected ${expected}, got ${actual}). Refusing to install it.`,
    );
  }

  // Stage in a scratch directory, then rename into place so a killed download
  // never leaves a half-installed cache entry that later runs would trust.
  // The scratch lives under the cache root: rename() must not cross volumes.
  const scratch = join(
    hostCacheRoot(),
    `.tmp-${release.version}-${release.target}-${process.pid}`,
  );
  mkdirSync(hostCacheRoot(), { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const archivePath = join(scratch, release.assetName);
    writeFileSync(archivePath, body);
    const extracted = join(scratch, 'extracted');
    mkdirSync(extracted);
    extractArchive(archivePath, extracted);

    const executableName = hostExecutableName(process.platform);
    const executable = join(extracted, executableName);
    if (!existsSync(executable)) {
      throw new Error(
        `natui: the host archive did not contain ${executableName}; refusing to install it`,
      );
    }
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    writeFileSync(join(extracted, OK_MARKER), `${expected}\n`);

    mkdirSync(join(release.directory, '..'), { recursive: true });
    // A concurrent install may have completed while this one downloaded;
    // take its result instead of deleting an entry an app may already be
    // running from (on Windows that delete would throw EPERM mid-way and
    // tear the entry).
    if (!options?.force) {
      const winner = findCachedHost(release.version);
      if (winner) return winner;
    }
    // Drop the completion marker before the recursive delete: if the delete
    // is interrupted partway, later runs must see the entry as incomplete,
    // never trust a torn one.
    rmSync(join(release.directory, OK_MARKER), { force: true });
    try {
      rmSync(release.directory, { recursive: true, force: true });
    } catch (cause) {
      throw new Error(
        `natui: could not replace the cached host at ${release.directory}. ` +
          'Close applications running this host and retry.',
        { cause },
      );
    }
    try {
      renameSync(extracted, release.directory);
    } catch (error) {
      // A concurrent install can win the rename race; accept its result.
      const cached = findCachedHost(release.version);
      if (!cached) throw error;
      return cached;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  log(`natui: native host installed at ${release.directory}`);
  return release.executable;
}
