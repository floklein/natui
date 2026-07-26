/**
 * Probe helpers shared by every example verification script.
 *
 * These used to be copy-pasted per script, which let them drift: the
 * running-host check was spelled three different ways and "wait for a protocol
 * message" had three mutually incompatible implementations. One copy here is
 * the whole point, so prefer extending these over re-deriving them.
 *
 * This directory has no package.json on purpose: pnpm only treats an
 * `examples/*` entry as a workspace package when it has one, so the examples
 * import these helpers by relative path with no workspace changes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let requestId = 0;

/**
 * Next request id for a `dump` / `screenshot` message. Hosts echo it on the
 * `tree` / `shot` reply (host API v2), so replies pair by id rather than by
 * arrival order. These probes keep one request outstanding at a time, but
 * sending a real id keeps them honest against the documented protocol.
 */
export function nextRequestId() {
  requestId += 1;
  return requestId;
}

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/** Every node of `kind` in the tree, in document order. */
export function collect(root, kind) {
  const out = [];
  const walk = (node) => {
    if (node.kind === kind) out.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

/** The concatenated text of a node's `#text` descendants. */
export function textOf(node) {
  if (node.kind === '#text') return node.text ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** The first node carrying `accessibilityIdentifier === id`. Asserts it exists. */
export function byAxId(root, id) {
  const matches = [];
  const walk = (node) => {
    if (node.props?.accessibilityIdentifier === id) matches.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  assert.ok(matches[0], `no node with accessibilityIdentifier "${id}"`);
  return matches[0];
}

/** The screenshot must exist, be non-empty, and decode as a real PNG. */
export function assertValidPng(path) {
  assert.ok(statSync(path).size > 1000, `${path} is suspiciously small`);
  const header = readFileSync(path).subarray(0, PNG_SIGNATURE.length);
  assert.deepEqual([...header], PNG_SIGNATURE, `${path} lacks a PNG signature`);
  if (process.platform === 'win32') {
    // System.Drawing decodes the image; a corrupt file makes FromFile throw
    // and the script exit non-zero (the Windows counterpart of sips below).
    const width = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile('${path.replace(/'/g, "''")}'); "pixelWidth: $($i.Width)"; $i.Dispose()`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(width, /pixelWidth: \d+/, `${path} did not decode`);
    return;
  }
  // sips decodes the image; a corrupt file makes it exit non-zero.
  const width = execFileSync('sips', ['-g', 'pixelWidth', path], { encoding: 'utf8' });
  assert.match(width, /pixelWidth: \d+/, `${path} did not decode`);
}

/**
 * Diagnostics for any NatUI host already running, or '' when none is.
 * Another host would grab focus and confuse window-level checks, so the
 * scripts refuse to run next to one (e.g. a forgotten `pnpm demo`).
 */
export function runningHosts() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq NatuiHost.exe', '/NH'],
        { encoding: 'utf8' },
      ).trim();
      return /\bNatuiHost\.exe\b/i.test(out) ? out : '';
    }
    // pgrep exits 1 when nothing matches; that is the good case.
    return execFileSync('pgrep', ['-lf', 'natui-host'], { encoding: 'utf8' }).trim();
  } catch {
    // Neither tool being available (or matching) means no host is running.
    return '';
  }
}

/**
 * Wait for the first message at or after `startIndex` that satisfies
 * `predicate`. Callers own an append-only `messages` array and capture
 * `messages.length` as `startIndex` before sending the request they await, so
 * a reply to an earlier request can never satisfy a later wait.
 *
 * `refresh` lets file-backed transports pull new bytes before each scan,
 * `ended` reports that the host died (returning a reason string), and
 * `diagnose` appends captured stderr to whichever error is thrown.
 */
export async function waitForMessage(messages, predicate, label, {
  startIndex = 0,
  timeoutMs = 15_000,
  pollMs = 25,
  refresh,
  ended,
  diagnose,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const detail = async () => (diagnose ? `\n${await diagnose()}` : '');
  for (;;) {
    if (refresh) await refresh();
    for (let index = startIndex; index < messages.length; index += 1) {
      if (predicate(messages[index])) return messages[index];
    }
    const reason = ended?.();
    if (reason) {
      throw new Error(`the host exited before ${label}: ${reason}${await detail()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${await detail()}`);
    }
    await sleep(pollMs);
  }
}
