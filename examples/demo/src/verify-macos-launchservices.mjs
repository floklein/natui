import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertValidPng, waitForMessage } from '../../shared/probe.mjs';

const defaultApp = fileURLToPath(
  new URL('../dist/package/NatUIDemo.app', import.meta.url),
);
const execFileAsync = promisify(execFile);

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function containsKind(node, kind) {
  return node?.kind === kind
    || node?.children?.some((childNode) => containsKind(childNode, kind));
}

function withTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function findVerificationProcess(executablePath, verificationArgument) {
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-axww', '-o', 'pid=,command='],
    { encoding: 'utf8' },
  );
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (
      (command === executablePath || command.startsWith(`${executablePath} `))
      && command.includes(verificationArgument)
    ) {
      return Number(match[1]);
    }
  }
  return undefined;
}

async function waitForVerificationProcess(
  executablePath,
  verificationArgument,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const pid = await findVerificationProcess(
      executablePath,
      verificationArgument,
    );
    if (pid) return pid;
    await sleep(25);
  } while (Date.now() < deadline);
  return undefined;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: gone. EPERM: the pid was reused by another user's process, so it
    // is not ours either. Rethrowing EPERM from the `finally` below would mask
    // the original failure.
    if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

async function isVerificationProcessRunning(
  pid,
  executablePath,
  verificationArgument,
) {
  return await findVerificationProcess(
    executablePath,
    verificationArgument,
  ) === pid;
}

async function terminateVerificationProcess(
  pid,
  executablePath,
  verificationArgument,
) {
  if (!isProcessRunning(pid)) return;
  if (!(await isVerificationProcessRunning(
    pid,
    executablePath,
    verificationArgument,
  ))) return;
  process.kill(pid, 'SIGTERM');
  if (await waitForProcessExit(pid, 1_000)) return;
  if (!(await isVerificationProcessRunning(
    pid,
    executablePath,
    verificationArgument,
  ))) return;
  process.kill(pid, 'SIGKILL');
  assert.ok(
    await waitForProcessExit(pid, 1_000),
    `failed to terminate LaunchServices verification process ${pid}`,
  );
}

export async function verifyMacLaunchServices(
  appPath = process.env.NATUI_PACKAGE_APP_PATH
    ? path.resolve(process.env.NATUI_PACKAGE_APP_PATH)
    : defaultApp,
) {
  assert.equal(
    process.platform,
    'darwin',
    'LaunchServices verification requires macOS',
  );

  const absoluteApp = path.resolve(appPath);
  const temporary = await mkdtemp(path.join(tmpdir(), 'natui-launchservices-'));
  const inputPath = path.join(temporary, 'stdin');
  const outputPath = path.join(temporary, 'stdout');
  const errorPath = path.join(temporary, 'stderr');
  const screenshotPath = path.join(temporary, 'window.png');
  const executablePath = path.join(
    absoluteApp,
    'Contents',
    'MacOS',
    'NatUIDemo',
  );
  const verificationArgument = `--natui-launchservices=${randomUUID()}`;

  let input;
  let launcher;
  let launcherResult;
  let launcherError;
  let launcherExit;
  let launcherStderr = '';
  let verificationPid;
  let verificationPidPromise;

  try {
    execFileSync('/usr/bin/mkfifo', [inputPath]);
    await Promise.all([
      writeFile(outputPath, ''),
      writeFile(errorPath, ''),
    ]);
    input = await open(
      inputPath,
      constants.O_RDWR | constants.O_NONBLOCK,
    );

    launcher = spawn(
      '/usr/bin/open',
      [
        '-n',
        '-W',
        '-i',
        inputPath,
        '-o',
        outputPath,
        '--stderr',
        errorPath,
        absoluteApp,
        '--args',
        verificationArgument,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk) => {
      launcherStderr += chunk;
    });
    launcherExit = new Promise((resolve) => {
      launcher.once('error', (error) => {
        launcherError = error;
        launcherResult = { code: null, signal: null };
        resolve(launcherResult);
      });
      launcher.once('exit', (code, signal) => {
        launcherResult = { code, signal };
        resolve(launcherResult);
      });
    });
    verificationPidPromise = waitForVerificationProcess(
      executablePath,
      verificationArgument,
    );

    const messages = [];
    let consumedLength = 0;
    let partialLine = '';

    async function collectMessages() {
      const contents = await readFile(outputPath, 'utf8');
      partialLine += contents.slice(consumedLength);
      consumedLength = contents.length;
      const lines = partialLine.split('\n');
      partialLine = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          // Ignore non-protocol output. Diagnostics belong on stderr.
        }
      }
    }

    async function diagnostics() {
      const appStderr = await readFile(errorPath, 'utf8');
      const output = [
        launcherStderr.trim()
          ? `LaunchServices:\n${launcherStderr.trim()}`
          : '',
        appStderr.trim()
          ? `NatUIDemo:\n${appStderr.trim()}`
          : '',
      ].filter(Boolean);
      return output.join('\n') || '(no stderr output)';
    }

    // The shared probe helper reads an append-only array; this transport is
    // file-backed and can die under us, so it gets a refresh and an exit check.
    function waitForProtocolMessage(predicate, label, startIndex = 0) {
      return waitForMessage(messages, predicate, label, {
        startIndex,
        refresh: collectMessages,
        ended: () => (launcherResult
          ? `LaunchServices exited (${launcherResult.code ?? launcherResult.signal})`
          : undefined),
        diagnose: diagnostics,
      });
    }

    async function send(message) {
      await input.write(`${JSON.stringify(message)}\n`);
    }

    const ready = await waitForProtocolMessage(
      (message) => message.t === 'ready',
      'ready',
    );
    assert.equal(ready.platform, 'macos');
    assert.equal(ready.protocol, 1);
    assert.ok(ready.hostApi >= 1);
    verificationPid = await verificationPidPromise;
    assert.ok(
      verificationPid,
      `LaunchServices did not start ${executablePath}`,
    );

    let tree;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const startIndex = messages.length;
      await send({ t: 'dump' });
      tree = await waitForProtocolMessage(
        (message) => message.t === 'tree',
        `tree ${attempt + 1}`,
        startIndex,
      );
      if (containsKind(tree.root, 'Button')) break;
      await sleep(50);
    }
    assert.ok(
      containsKind(tree?.root, 'Button'),
      'LaunchServices app mounted the demo tree',
    );

    const shotStart = messages.length;
    await send({ t: 'screenshot', path: screenshotPath });
    const shot = await waitForProtocolMessage(
      (message) => message.t === 'shot',
      'screenshot reply',
      shotStart,
    );
    assert.equal(shot.path, screenshotPath);
    assert.equal(shot.error, undefined, `screenshot failed: ${shot.error}`);
    assertValidPng(screenshotPath);
    const screenshot = await readFile(screenshotPath);

    const closeStart = messages.length;
    await send({ t: 'requestClose' });
    await waitForProtocolMessage(
      (message) => message.t === 'window' && message.name === 'close',
      'native close event',
      closeStart,
    );
    await waitForProtocolMessage(
      (message) => message.t === 'quitAck',
      'native quit acknowledgement',
      closeStart,
    );

    const result = await withTimeout(
      launcherExit,
      'LaunchServices app did not exit after its close request',
      15_000,
    );
    if (launcherError) throw launcherError;
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.equal(
      await isVerificationProcessRunning(
        verificationPid,
        executablePath,
        verificationArgument,
      ),
      false,
      'acknowledged LaunchServices app is still running',
    );

    const stderr = await readFile(errorPath, 'utf8');
    assert.doesNotMatch(
      stderr,
      /startup failed:|embedded runtime failed:|embedded: JS exception:|quit acknowledgement timed out;/,
      'LaunchServices app reported a fatal lifecycle error',
    );

    return {
      appPath: absoluteApp,
      pid: verificationPid,
      screenshotBytes: screenshot.length,
    };
  } finally {
    if (!verificationPid && verificationPidPromise) {
      verificationPid = await verificationPidPromise;
    }
    if (
      input
      && verificationPid
      && await isVerificationProcessRunning(
        verificationPid,
        executablePath,
        verificationArgument,
      )
    ) {
      try {
        await input.write(`${JSON.stringify({ t: 'requestClose' })}\n`);
      } catch {
        // The app may already have closed its protocol channel.
      }
      if (!(await waitForProcessExit(verificationPid, 500))) {
        try {
          await input.write(`${JSON.stringify({ t: 'quit' })}\n`);
        } catch {
          // The app may already have closed its protocol channel.
        }
      }
      await waitForProcessExit(verificationPid, 3_000);
    }
    if (verificationPid) {
      await terminateVerificationProcess(
        verificationPid,
        executablePath,
        verificationArgument,
      );
    }
    if (launcher && !launcherResult && launcherExit) {
      await Promise.race([launcherExit, sleep(500)]);
    }
    if (launcher && !launcherResult) launcher.kill();
    await input?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') {
    console.error(
      `[verify-launchservices] skipped on ${process.platform}; macOS only`,
    );
  } else {
    try {
      const result = await verifyMacLaunchServices();
      console.error(
        '[verify-launchservices] packaged macOS LaunchServices lifecycle verified '
          + `(${result.screenshotBytes} screenshot bytes)`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    }
  }
}
