import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  createProject,
  detectPackageManager,
  packageManagerExecutable,
  parseArgs,
  projectMetadata,
  runCli,
} from '../src/index.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'bin', 'create-natui-app.js');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'create-natui-app-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function captureStream() {
  let value = '';
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
        return true;
      },
    },
    value: () => value,
  };
}

function parseIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  const count = buffer.readUInt16LE(4);
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256;
    const height = buffer[entry + 1] || 256;
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    images.push({
      height,
      payload: buffer.subarray(offset, offset + length),
      width,
    });
  }
  return images;
}

function parseIcns(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'icns');
  assert.equal(buffer.readUInt32BE(4), buffer.length);
  const entries = [];
  let offset = 8;
  while (offset < buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length > 8);
    entries.push({ payload: buffer.subarray(offset + 8, offset + length), type });
    offset += length;
  }
  assert.equal(offset, buffer.length);
  return entries;
}

function assertPngSize(buffer, size) {
  assert.deepEqual(buffer.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.equal(buffer.readUInt32BE(16), size);
  assert.equal(buffer.readUInt32BE(20), size);
}

function pngRawRows(buffer, size) {
  const imageData = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      imageData.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(imageData));
  assert.equal(raw.length, (size * 4 + 1) * size);
  return raw;
}

function pngAlphaAt(buffer, size, x, y) {
  const raw = pngRawRows(buffer, size);
  return raw[y * (size * 4 + 1) + 1 + x * 4 + 3];
}

function assertPngIsFullyOpaque(buffer, size) {
  const raw = pngRawRows(buffer, size);
  const rowLength = size * 4 + 1;
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * rowLength;
    assert.equal(raw[rowOffset], 0);
    for (let x = 0; x < size; x += 1) {
      const alpha = raw[rowOffset + 1 + x * 4 + 3];
      if (alpha !== 255) {
        assert.fail(`expected opaque PNG pixel at ${x},${y}, received alpha ${alpha}`);
      }
    }
  }
}

test('argument parsing supports documented options and rejects ambiguous input', () => {
  assert.deepEqual(parseArgs([]), {
    directory: undefined,
    help: false,
    install: true,
    packageManager: undefined,
    version: false,
    yes: false,
  });
  assert.deepEqual(
    parseArgs(['my-app', '--no-install', '--package-manager=pnpm', '--yes']),
    {
      directory: 'my-app',
      help: false,
      install: false,
      packageManager: 'pnpm',
      version: false,
      yes: true,
    },
  );
  assert.throws(() => parseArgs(['one', 'two']), /unexpected argument "two"/);
  assert.throws(() => parseArgs(['--force']), /unknown option "--force"/);
  assert.throws(() => parseArgs(['--package-manager']), /requires a value/);
  assert.throws(() => parseArgs(['--package-manager', 'deno']), /unsupported package manager/);
});

test('package manager detection follows the invoking user agent', () => {
  assert.equal(detectPackageManager('pnpm/11.1.0 npm/? node/v22.0.0 win32 x64'), 'pnpm');
  assert.equal(detectPackageManager('yarn/4.5.0 npm/? node/v22.0.0'), 'yarn');
  assert.equal(detectPackageManager('bun/1.2.0 npm/? node/v22.0.0'), 'bun');
  assert.equal(detectPackageManager('npm/11.0.0 node/v22.0.0'), 'npm');
  assert.equal(detectPackageManager(''), 'npm');
  assert.equal(packageManagerExecutable('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(packageManagerExecutable('bun', 'win32'), 'bun.exe');
  assert.equal(packageManagerExecutable('npm', 'darwin'), 'npm');
});

test('project metadata is portable and produces valid identifiers', () => {
  assert.deepEqual(projectMetadata('My Fancy_App'), {
    appId: 'com.example.my-fancy-app',
    displayName: 'My Fancy App',
    executable: 'MyFancyApp',
    packageName: 'my-fancy-app',
  });
  assert.equal(projectMetadata('natui-app').displayName, 'NatUI App');
  assert.equal(projectMetadata('123 app').executable, 'NatUI123App');
  assert.throws(() => projectMetadata('CON'), /reserved on Windows/);
  assert.throws(() => projectMetadata('...'), /at least one letter or number/);
  assert.throws(() => projectMetadata('a'.repeat(81)), /80 characters or fewer/);
});

test('createProject writes a complete app with native icon containers', async (t) => {
  const cwd = await fixture(t);
  const result = await createProject({
    cwd,
    directory: 'My Native App',
    packageManager: 'pnpm',
  });
  const target = path.join(cwd, 'My Native App');
  assert.equal(result.target, target);

  const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'my-native-app');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.scripts.dev, 'natui dev');
  assert.equal(manifest.scripts.package, undefined);
  assert.equal(manifest.dependencies['@natui/core'], '^0.2.0');

  const config = JSON.parse(await readFile(path.join(target, 'natui.app.json'), 'utf8'));
  assert.deepEqual(config.icons, {
    macos: 'assets/AppIcon.icns',
    windows: 'assets/AppIcon.ico',
  });
  assert.equal(config.entry, 'src/main.tsx');
  assert.equal(config.name, 'My Native App');
  assert.equal(config.executable, 'MyNativeApp');
  assert.equal(config.version, '0.1.0');

  const main = await readFile(path.join(target, 'src', 'main.tsx'), 'utf8');
  const readme = await readFile(path.join(target, 'README.md'), 'utf8');
  const pnpmWorkspace = await readFile(path.join(target, 'pnpm-workspace.yaml'), 'utf8');
  assert.deepEqual((await readdir(path.join(target, 'src'))).sort(), ['App.tsx', 'main.tsx']);
  assert.match(main, /title: "My Native App"/);
  assert.match(main, /import \{ run \} from '@natui\/core'/);
  assert.match(readme, /pnpm install/);
  assert.match(readme, /pnpm dev/);
  assert.match(readme, /framework repository/);
  assert.match(readme, /standalone\s+projects cannot package/);
  assert.match(pnpmWorkspace, /allowBuilds:\s+esbuild: true/);
  await stat(path.join(target, '.gitignore'));

  const ico = parseIco(await readFile(path.join(target, 'assets', 'AppIcon.ico')));
  assert.deepEqual(ico.map((image) => image.width), [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  assert.ok(ico.every((image) => image.width === image.height));
  for (const image of ico.slice(0, -1)) {
    assert.equal(image.payload.readUInt32LE(0), 40);
  }
  assertPngSize(ico.at(-1).payload, 256);
  assert.equal(pngAlphaAt(ico.at(-1).payload, 256, 0, 0), 0);

  const icns = parseIcns(await readFile(path.join(target, 'assets', 'AppIcon.icns')));
  assert.deepEqual(
    icns.map((entry) => entry.type),
    ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14'],
  );
  const expectedSizes = [16, 32, 64, 128, 256, 512, 1024, 32, 64, 256, 512];
  icns.forEach((entry, index) => assertPngSize(entry.payload, expectedSizes[index]));
  assertPngIsFullyOpaque(icns.find((entry) => entry.type === 'ic10').payload, 1024);
});

test('createProject accepts an empty directory and refuses every nonempty destination', async (t) => {
  const cwd = await fixture(t);
  const empty = path.join(cwd, 'empty');
  await mkdir(empty);
  await createProject({ cwd, directory: 'empty' });
  await stat(path.join(empty, 'package.json'));

  const occupied = path.join(cwd, 'occupied');
  await mkdir(occupied);
  const sentinel = path.join(occupied, 'keep.txt');
  await writeFile(sentinel, 'keep me', 'utf8');
  await assert.rejects(
    createProject({ cwd, directory: 'occupied' }),
    /destination is not empty/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me');

  const file = path.join(cwd, 'file-target');
  await writeFile(file, 'keep me', 'utf8');
  await assert.rejects(createProject({ cwd, directory: 'file-target' }), /not a directory/);
  assert.equal(await readFile(file, 'utf8'), 'keep me');
});

test('createProject never replaces the current directory or an ancestor', async (t) => {
  const root = await fixture(t);
  const cwd = path.join(root, 'current');
  await mkdir(cwd);

  await assert.rejects(
    createProject({ cwd, directory: '.' }),
    /current directory or one of its parent directories/,
  );
  assert.deepEqual(await readdir(cwd), []);

  await assert.rejects(
    createProject({ cwd, directory: '..' }),
    /current directory or one of its parent directories/,
  );
  assert.deepEqual(await readdir(root), ['current']);

  const sibling = await createProject({ cwd, directory: '../sibling' });
  assert.equal(sibling.target, path.join(root, 'sibling'));
  await stat(path.join(root, 'sibling', 'package.json'));
});

test('runCli detects package manager, installs, and reports next steps', async (t) => {
  const cwd = await fixture(t);
  const output = captureStream();
  const errorOutput = captureStream();
  const installs = [];
  const exitCode = await runCli(['sample'], {
    cwd,
    env: { npm_config_user_agent: 'pnpm/11.1.0 npm/? node/v22.0.0' },
    errorOutput: errorOutput.stream,
    installRunner: async (invocation) => installs.push(invocation),
    output: output.stream,
  });
  assert.equal(exitCode, 0);
  assert.equal(errorOutput.value(), '');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].args[0], 'install');
  assert.match(path.basename(installs[0].command), /^pnpm(?:\.cmd)?$/);
  assert.equal(installs[0].cwd, path.join(cwd, 'sample'));
  assert.match(output.value(), /Installing dependencies with pnpm/);
  assert.match(output.value(), /pnpm dev/);
});

test('runCli cancellation makes no filesystem changes', async (t) => {
  const cwd = await fixture(t);
  const output = captureStream();
  const exitCode = await runCli([], {
    cwd,
    output: output.stream,
    prompt: async () => null,
  });
  assert.equal(exitCode, 0);
  assert.match(output.value(), /Cancelled/);
  assert.deepEqual(await readdir(cwd), []);
});

test('runCli --yes uses the documented default without prompting', async (t) => {
  const cwd = await fixture(t);
  const output = captureStream();
  const exitCode = await runCli(['--yes', '--no-install'], {
    cwd,
    output: output.stream,
    prompt: async () => {
      throw new Error('prompt should not run with --yes');
    },
  });
  assert.equal(exitCode, 0);
  assert.match(output.value(), /Created NatUI App/);
  await stat(path.join(cwd, 'natui-app', 'package.json'));
});

test('runCli keeps a generated project when dependency installation fails', async (t) => {
  const cwd = await fixture(t);
  const output = captureStream();
  const errorOutput = captureStream();
  const exitCode = await runCli(['sample'], {
    cwd,
    errorOutput: errorOutput.stream,
    installRunner: async () => {
      throw new Error('registry unavailable');
    },
    output: output.stream,
  });
  assert.equal(exitCode, 1);
  assert.match(errorOutput.value(), /Dependency installation failed: registry unavailable/);
  assert.match(errorOutput.value(), /npm install/);
  await stat(path.join(cwd, 'sample', 'package.json'));
});

test('the executable handles help, version, generation, and typed cancellation end to end', async (t) => {
  const cwd = await fixture(t);
  const help = await execFileAsync(process.execPath, [CLI, '--help'], { cwd });
  assert.match(help.stdout, /^Usage: create-natui-app/);

  const version = await execFileAsync(process.execPath, [CLI, '--version'], { cwd });
  assert.equal(version.stdout.trim(), '0.2.0');

  const generated = await execFileAsync(
    process.execPath,
    [CLI, 'e2e-app', '--no-install', '--package-manager', 'yarn'],
    { cwd },
  );
  assert.match(generated.stdout, /yarn install/);
  assert.match(generated.stdout, /yarn dev/);
  await stat(path.join(cwd, 'e2e-app', 'natui.app.json'));

  const cancelCwd = path.join(cwd, 'cancel');
  await mkdir(cancelCwd);
  const cancellation = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], {
      cwd: cancelCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Project directory')) child.stdin.end('cancel\n');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
  assert.equal(cancellation.code, 0);
  assert.equal(cancellation.signal, null);
  assert.equal(cancellation.stderr, '');
  assert.match(cancellation.stdout, /Cancelled/);
  assert.deepEqual(await readdir(cancelCwd), []);
});
