/**
 * Prebuilt-host cache logic. The pure pieces (target naming, cache layout,
 * checksum parsing, release URL construction) are what CI and the release
 * workflow must agree with, so they are pinned here without any network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  findCachedHost,
  hostAssetName,
  hostCacheRoot,
  hostRelease,
  hostTarget,
  installHost,
  packageVersion,
  parseSha256,
} from '../src/bridge/host-cache.js';

test('host targets match the release asset naming', () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'macos-universal');
  assert.equal(hostTarget('darwin', 'x64'), 'macos-universal');
  assert.equal(hostTarget('win32', 'x64'), 'windows-x64');
  assert.equal(hostTarget('win32', 'arm64'), 'windows-arm64');
  assert.throws(() => hostTarget('linux', 'x64'), /unsupported platform/);
  assert.throws(() => hostTarget('win32', 'ia32'), /no prebuilt Windows host/);
});

test('asset names carry the version and target', () => {
  assert.equal(
    hostAssetName('0.3.0', 'windows-x64'),
    'natui-host-0.3.0-windows-x64.tar.gz',
  );
});

test('packageVersion reads the real package manifest', () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test('NATUI_HOST_CACHE_DIR overrides the platform cache root', () => {
  assert.equal(hostCacheRoot({ NATUI_HOST_CACHE_DIR: '/tmp/cache' }), '/tmp/cache');
  assert.equal(
    hostCacheRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'),
    join('C:\\Users\\u\\AppData\\Local', 'natui', 'hosts'),
  );
});

test('hostRelease points at the GitHub release for this version', () => {
  const release = hostRelease('0.3.0', 'win32', 'x64', {
    NATUI_HOST_CACHE_DIR: '/tmp/cache',
  });
  assert.equal(
    release.url,
    'https://github.com/floklein/natui/releases/download/v0.3.0/natui-host-0.3.0-windows-x64.tar.gz',
  );
  assert.equal(release.checksumUrl, `${release.url}.sha256`);
  assert.equal(release.directory, join('/tmp/cache', '0.3.0', 'windows-x64'));
  assert.equal(release.executable, join(release.directory, 'NatuiHost.exe'));
});

test('NATUI_HOST_BASE_URL redirects downloads for mirrors and tests', () => {
  const release = hostRelease('0.3.0', 'darwin', 'arm64', {
    NATUI_HOST_BASE_URL: 'http://localhost:8080',
    NATUI_HOST_CACHE_DIR: '/tmp/cache',
  });
  assert.equal(release.url, 'http://localhost:8080/natui-host-0.3.0-macos-universal.tar.gz');
  assert.equal(release.executable, join('/tmp/cache', '0.3.0', 'macos-universal', 'natui-host'));
});

test('parseSha256 accepts `sha256sum` style lines and rejects garbage', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseSha256(`${digest}  natui-host-0.3.0-windows-x64.tar.gz\n`), digest);
  assert.equal(parseSha256(digest.toUpperCase()), digest);
  assert.throws(() => parseSha256('not a checksum'), /malformed host checksum/);
  assert.throws(() => parseSha256('deadbeef'), /malformed host checksum/);
});

async function withProcessEnv<T>(
  overrides: Record<string, string | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('installHost downloads, verifies, extracts, and refuses tampering', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no host target for this platform');
    return;
  }
  const version = '9.9.9';
  const target = hostTarget();
  const assetName = hostAssetName(version, target);
  const executableName = process.platform === 'win32' ? 'NatuiHost.exe' : 'natui-host';

  // Fabricate a release archive the way tools/package-host.mjs does.
  const stage = mkdtempSync(join(tmpdir(), 'natui-install-stage-'));
  const payload = join(stage, 'payload');
  mkdirSync(payload);
  writeFileSync(join(payload, executableName), 'fake host\n');
  writeFileSync(join(payload, 'extra.dat'), 'sidecar\n');
  const archive = join(stage, assetName);
  const tarred = spawnSync('tar', ['-czf', archive, '-C', payload, '.']);
  assert.equal(tarred.status, 0, tarred.stderr?.toString());
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(stage, `${assetName}.sha256`), `${digest}  ${assetName}\n`);

  let corruptChecksum = false;
  const server = createServer((request, response) => {
    const file = join(stage, basename(request.url ?? ''));
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    if (corruptChecksum && file.endsWith('.sha256')) {
      response.end(`${'0'.repeat(64)}  ${assetName}\n`);
      return;
    }
    response.end(readFileSync(file));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const cacheRoot = mkdtempSync(join(tmpdir(), 'natui-install-cache-'));
  t.after(() => server.close());

  await withProcessEnv(
    {
      NATUI_HOST_BASE_URL: `http://127.0.0.1:${address.port}`,
      NATUI_HOST_CACHE_DIR: cacheRoot,
    },
    async () => {
      const logs: string[] = [];
      const executable = await installHost({ version, log: (m) => logs.push(m) });
      assert.equal(executable, join(cacheRoot, version, target, executableName));
      assert.equal(readFileSync(executable, 'utf8'), 'fake host\n');
      assert.ok(existsSync(join(cacheRoot, version, target, 'extra.dat')));
      assert.ok(logs.some((m) => m.includes('downloading native host')));

      // Second call is a cache hit: no download, same path.
      const again = await installHost({ version, log: () => assert.fail('re-downloaded') });
      assert.equal(again, executable);

      // A checksum mismatch must refuse the archive and keep the good cache.
      corruptChecksum = true;
      await assert.rejects(
        installHost({ version, force: true, log: () => {} }),
        /checksum mismatch/,
      );
      assert.equal(findCachedHost(version), executable);
    },
  );
});

test('installHost reports a missing release asset with guidance', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no host target for this platform');
    return;
  }
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => server.close());

  await withProcessEnv(
    {
      NATUI_HOST_BASE_URL: `http://127.0.0.1:${address.port}`,
      NATUI_HOST_CACHE_DIR: mkdtempSync(join(tmpdir(), 'natui-install-404-')),
    },
    async () => {
      await assert.rejects(
        installHost({ version: '9.9.9', log: () => {} }),
        /no prebuilt native host/,
      );
    },
  );
});

test('findCachedHost only trusts a completed install', (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('no host target for this platform');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'natui-host-cache-'));
  const env = { ...process.env, NATUI_HOST_CACHE_DIR: root };
  const release = hostRelease('9.9.9', process.platform, process.arch, env);

  assert.equal(findCachedHost('9.9.9', process.platform, process.arch, env), undefined);

  // An executable without the completion marker is a torn install: ignore it.
  mkdirSync(release.directory, { recursive: true });
  writeFileSync(release.executable, '');
  assert.equal(findCachedHost('9.9.9', process.platform, process.arch, env), undefined);

  writeFileSync(join(release.directory, '.natui-host-ok'), 'test\n');
  assert.equal(
    findCachedHost('9.9.9', process.platform, process.arch, env),
    release.executable,
  );
});
