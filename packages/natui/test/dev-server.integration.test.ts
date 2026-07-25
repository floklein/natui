import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  DevServerOptions,
  NatuiDevServer,
} from '../src/dev/server.js';
import type { TreeNode } from '../src/protocol.js';
import type { NatuiApp } from '../src/run.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAKE_HOST_ENV = 'NATUI_DEV_INTEGRATION_FAKE_HOST';
const STATIC_CONDITION_EXPECTED_ENV =
  'NATUI_DEV_INTEGRATION_STATIC_CONDITION';
const STATIC_CONDITION_COMPLETION_ENV =
  'NATUI_DEV_INTEGRATION_STATIC_CONDITION_COMPLETION';
const MAIN_INTEGRATION_TEST_NAME =
  'createDevServer preserves store identity and component state across leaf refreshes';
const SYMLINK_IDENTITY_PROBE_ENV =
  'NATUI_DEV_INTEGRATION_SYMLINK_IDENTITY_PROBE';
const SYMLINK_IDENTITY_TEST_NAME =
  'development matches Node module identity across real and junction imports';
const WAIT_TIMEOUT_MS = 15_000;

async function createDevServer(
  options: DevServerOptions,
): Promise<NatuiDevServer> {
  const serverModule = await import('../src/dev/server.js');
  return serverModule.createDevServer(options);
}

const FAKE_HOST_SOURCE = `
const readline = require('node:readline');

const nodes = new Map([
  [0, { id: 0, kind: '#root', props: {}, children: [] }],
]);
const parents = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function detach(id) {
  const parentId = parents.get(id);
  if (parentId === undefined) return;
  const parent = nodes.get(parentId);
  if (parent) parent.children = parent.children.filter((childId) => childId !== id);
  parents.delete(id);
}

function destroy(id) {
  const node = nodes.get(id);
  if (!node) return;
  for (const childId of [...node.children]) destroy(childId);
  detach(id);
  nodes.delete(id);
}

function append(parentId, childId, beforeId) {
  const parent = nodes.get(parentId);
  if (!parent || !nodes.has(childId)) return;
  detach(childId);
  const beforeIndex =
    beforeId === undefined ? -1 : parent.children.indexOf(beforeId);
  if (beforeIndex === -1) parent.children.push(childId);
  else parent.children.splice(beforeIndex, 0, childId);
  parents.set(childId, parentId);
}

function apply(op) {
  switch (op.op) {
    case 'create':
      nodes.set(op.id, {
        id: op.id,
        kind: op.kind,
        props: op.props,
        children: [],
      });
      break;
    case 'createText':
      nodes.set(op.id, {
        id: op.id,
        kind: '#text',
        props: {},
        text: op.text,
        children: [],
      });
      break;
    case 'append':
      append(op.parent, op.child);
      break;
    case 'insert':
      append(op.parent, op.child, op.before);
      break;
    case 'remove':
      destroy(op.child);
      break;
    case 'update': {
      const node = nodes.get(op.id);
      if (node) node.props = op.props;
      break;
    }
    case 'text': {
      const node = nodes.get(op.id);
      if (node) node.text = op.text;
      break;
    }
    case 'clear':
      for (const childId of [...nodes.get(0).children]) destroy(childId);
      break;
  }
}

function dump(id) {
  const node = nodes.get(id);
  if (!node) throw new Error('unknown node ' + id);
  if (node.kind === '#text') {
    return { id: node.id, kind: node.kind, text: node.text || '' };
  }
  const result = {
    id: node.id,
    kind: node.kind,
    children: node.children.map(dump),
  };
  if (node.id !== 0) result.props = node.props;
  return result;
}

const platform = process.platform === 'win32' ? 'windows' : 'macos';
send({ t: 'ready', platform, protocol: 1, hostApi: 1 });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  switch (message.t) {
    case 'commit':
      for (const op of message.ops) apply(op);
      break;
    case 'dump':
      send({ t: 'tree', root: dump(0) });
      break;
    case 'emit':
      send({
        t: 'event',
        id: message.id,
        name: message.name,
        payload: message.payload || {},
      });
      break;
    case 'quit':
      process.exit(0);
      break;
  }
});
`;

interface FixtureKeys {
  app: string;
  leafEvaluations: string;
  moduleIdentity: string;
  showUnvisited: string;
  storeIdentity: string;
  transientValueFailure: string;
  unvisitedEvaluations: string;
}

function entrySource(
  keys: FixtureKeys,
  fileValueUrl: string,
  expectedCondition: string,
): string {
  return `
import { createElement } from 'react';
import { sep as nodePathSeparator } from 'node:path';
import { run } from '@natui/core';
import { App } from './app.js';
import { moduleIdentity } from './store.js';
import packageCondition from 'natui-import-meta-conditional-fixture';
import importCondition from '#conditional';
import cjsValue from '#external-cjs';
import dataValue from 'data:text/javascript,export default "data"';
import fileUrlValue from ${JSON.stringify(fileValueUrl)};

const sourceMeta = import.meta;
if (packageCondition !== ${JSON.stringify(expectedCondition)}) {
  throw new Error('static package import did not use Node ESM conditions');
}
if (importCondition !== ${JSON.stringify(expectedCondition)}) {
  throw new Error('static package imports mapping did not use Node ESM conditions');
}
if (cjsValue !== 'external-cjs') {
  throw new Error('workspace-local CJS imports mapping was not loaded by Node');
}
if (dataValue !== 'data') throw new Error('static data URL import failed');
if (fileUrlValue !== 'file-url') throw new Error('static file URL import failed');
if (nodePathSeparator !== (process.platform === 'win32' ? '\\\\' : '/')) {
  throw new Error('static node builtin import failed');
}
if (!sourceMeta.main) throw new Error('development entry import.meta.main is false');
if (!sourceMeta.url.endsWith('/main.ts')) throw new Error('development entry URL is not source-relative');
if (!sourceMeta.filename.replaceAll('\\\\', '/').endsWith('/main.ts')) {
  throw new Error('development entry filename is not source-relative');
}
if (!sourceMeta.resolve('./leaf.js').endsWith('/leaf.js')) {
  throw new Error('development entry resolve is not source-relative');
}
if (!sourceMeta.resolve('natui-import-meta-conditional-fixture').endsWith(
  '/' + ${JSON.stringify(expectedCondition)} + '.js'
)) {
  throw new Error('development entry resolve did not use ESM package conditions');
}
if (!sourceMeta.resolve('#conditional').endsWith(
  '/' + ${JSON.stringify(expectedCondition)} + '-condition.js'
)) {
  throw new Error('development entry resolve did not use ESM package import conditions');
}

const fakeHost = process.env.${FAKE_HOST_ENV};
if (!fakeHost) throw new Error('${FAKE_HOST_ENV} is not set');

const app = await run(createElement(App), {
  host: { cmd: process.execPath, args: [fakeHost] },
  onClose() {},
});

(globalThis as Record<string, unknown>)[${JSON.stringify(keys.app)}] = app;
(globalThis as Record<string, unknown>)[${JSON.stringify(keys.moduleIdentity)}] =
  moduleIdentity;
`;
}

function appSource(keys: FixtureKeys): string {
  return `
import { createElement, lazy, Suspense } from 'react';
import { StoreProvider } from './store.js';

const Leaf = lazy(() => import('./leaf.js'));
const Unvisited = lazy(() => import('./unvisited.js'));

export function App() {
  const content = (globalThis as Record<string, unknown>)[${JSON.stringify(keys.showUnvisited)}]
    ? createElement(Unvisited)
    : createElement(Leaf);
  return createElement(
    StoreProvider,
    null,
    createElement(
      Suspense,
      { fallback: createElement('Text', null, 'loading') },
      content,
    ),
  );
}
`;
}

function unvisitedSource(evaluationKey: string, label: string): string {
  return `
import { createElement } from 'react';

const evaluationGlobal = globalThis as Record<string, unknown>;
evaluationGlobal[${JSON.stringify(evaluationKey)}] =
  Number(evaluationGlobal[${JSON.stringify(evaluationKey)}] ?? 0) + 1;

export default function Unvisited() {
  return createElement('Text', null, ${JSON.stringify(label)});
}
`;
}

function valueSource(
  suffix: string,
  transientFailureKey?: string,
  expectedCondition =
    process.env[STATIC_CONDITION_EXPECTED_ENV] ?? 'import',
): string {
  return `
const sourceMeta = import.meta;
if (sourceMeta.main) throw new Error('dependency import.meta.main is true');
if (!sourceMeta.url.endsWith('/value.ts')) throw new Error('dependency URL is not source-relative');
if (!sourceMeta.filename.replaceAll('\\\\', '/').endsWith('/value.ts')) {
  throw new Error('dependency filename is not source-relative');
}
if (!sourceMeta.resolve('./leaf.js').endsWith('/leaf.js')) {
  throw new Error('dependency resolve is not source-relative');
}
if (!sourceMeta.resolve('natui-import-meta-conditional-fixture').endsWith(
  '/' + ${JSON.stringify(expectedCondition)} + '.js'
)) {
  throw new Error('dependency resolve did not use ESM package conditions');
}

${
  transientFailureKey
    ? `if ((globalThis as Record<string, unknown>)[${JSON.stringify(transientFailureKey)}]) {
  throw new Error('value transient evaluation exploded');
}`
    : ''
}

export const sourceSuffix = ${JSON.stringify(suffix)} satisfies string;
`;
}

function gatedValueSource(
  suffix: string,
  gateKey: string,
  startedKey: string,
): string {
  return `
${valueSource(suffix)}

const pendingValueGlobals = globalThis as Record<string, unknown>;
const pendingValueGate = pendingValueGlobals[${JSON.stringify(gateKey)}];
if (pendingValueGate instanceof Promise) {
  pendingValueGlobals[${JSON.stringify(startedKey)}] = true;
  await pendingValueGate;
}
`;
}

function missingDependencySource(): string {
  return `
import { createdSuffix } from './generated/deep/created.js';

export const sourceSuffix = createdSuffix;
`;
}

function storeSource(storeIdentityKey: string): string {
  return `
import {
  createContext,
  createElement,
  useContext,
  useState,
  type ReactNode,
} from 'react';

interface Store {
  identity: object;
}

export const moduleIdentity = {};
const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState<Store>(() => ({ identity: {} }));
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('store provider is missing');
  (globalThis as Record<string, unknown>)[${JSON.stringify(storeIdentityKey)}] =
    store.identity;
  return store;
}
`;
}

function leafSource(
  evaluationKey: string,
  label: string,
  step: number,
  evaluationError?: string,
  renderError?: string,
  effectError?: string,
  effectFollowupError?: string,
  effectFollowupSteps = 1,
): string {
  return `
import { createElement, useEffect, useState } from 'react';
import { useStore } from './store.js';
import { sourceSuffix } from './value.js';

const evaluationGlobal = globalThis as Record<string, unknown>;
evaluationGlobal[${JSON.stringify(evaluationKey)}] =
  Number(evaluationGlobal[${JSON.stringify(evaluationKey)}] ?? 0) + 1;

${evaluationError ? `throw new Error(${JSON.stringify(evaluationError)});` : ''}

export function Leaf() {
  useStore();
  const [count, setCount] = useState(0);
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    ${effectError ? `throw new Error(${JSON.stringify(effectError)});` : ''}
    ${effectFollowupError ? `if (phase < ${effectFollowupSteps}) setPhase((value) => value + 1);` : ''}
  }, [phase]);
  ${effectFollowupError ? `if (phase === ${effectFollowupSteps}) throw new Error(${JSON.stringify(effectFollowupError)});` : ''}
  ${renderError ? `throw new Error(${JSON.stringify(renderError)});` : ''}
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'refresh-status' },
      ${JSON.stringify(label)} + ':' + String(count) + sourceSuffix,
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'refresh-increment',
        onPress: () => setCount((value) => value + ${step}),
      },
      'increment',
    ),
  );
}

export default Leaf;
`;
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitFor<T>(
  description: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }

  const detail =
    lastError instanceof Error ? `; last error: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${description}${detail}`);
}

function collect(root: TreeNode, kind: string): TreeNode[] {
  const matches: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    if (node.kind === kind) matches.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return matches;
}

function textOf(node: TreeNode): string {
  if (node.kind === '#text') return node.text ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function byAccessibilityIdentifier(
  root: TreeNode,
  kind: string,
  identifier: string,
): TreeNode {
  const node = collect(root, kind).find(
    (candidate) => candidate.props?.accessibilityIdentifier === identifier,
  );
  assert.ok(node, `${kind} "${identifier}" exists`);
  return node;
}

function statusText(root: TreeNode): string {
  return textOf(
    byAccessibilityIdentifier(root, 'Text', 'refresh-status'),
  );
}

interface NativeIds {
  stack: number;
  status: number;
  statusText: number;
  button: number;
  buttonText: number;
}

function nativeIds(root: TreeNode): NativeIds {
  const stack = collect(root, 'VStack')[0];
  const status = byAccessibilityIdentifier(
    root,
    'Text',
    'refresh-status',
  );
  const button = byAccessibilityIdentifier(
    root,
    'Button',
    'refresh-increment',
  );
  const statusTextNode = status.children?.[0];
  const buttonTextNode = button.children?.[0];

  assert.ok(stack, 'native VStack exists');
  assert.ok(statusTextNode, 'native status text node exists');
  assert.ok(buttonTextNode, 'native button text node exists');

  return {
    stack: stack.id,
    status: status.id,
    statusText: statusTextNode.id,
    button: button.id,
    buttonText: buttonTextNode.id,
  };
}

async function waitForTreeText(
  app: NatuiApp,
  expected: string,
): Promise<TreeNode> {
  let lastObserved = '<missing>';
  try {
    return await waitFor(`native tree text "${expected}"`, async () => {
      const tree = await app.dump();
      lastObserved = statusText(tree);
      return lastObserved === expected ? tree : undefined;
    });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; last native text: ${lastObserved}`;
    }
    throw error;
  }
}

async function waitForLog(
  logs: string[],
  fromIndex: number,
  pattern: RegExp,
): Promise<string> {
  try {
    return await waitFor(`log ${String(pattern)}`, () =>
      logs.slice(fromIndex).find((message) => pattern.test(message)),
    );
  } catch (error) {
    if (error instanceof Error) {
      error.message += `\nlogs:\n${logs.join('\n')}`;
    }
    throw error;
  }
}

interface SymlinkIdentityProbe {
  completionMarker: string;
  execArguments: string[];
}

interface SymlinkIdentityResult {
  count: number;
  copyMain: boolean;
  same: boolean;
  urls: string[];
}

async function runSymlinkIdentityProbe(
  probe: SymlinkIdentityProbe,
): Promise<void> {
  const fixture = await mkdtemp(
    join(PACKAGE_ROOT, 'natui-dev-symlink-identity-'),
  );
  const unique = `${process.pid}-${Date.now()}`;
  const appKey = `__natuiSymlinkIdentityApp_${unique}`;
  const countKey = `__natuiSymlinkIdentityCount_${unique}`;
  const resultKey = `__natuiSymlinkIdentityResult_${unique}`;
  const globals = globalThis as Record<string, unknown>;
  const previousFakeHost = process.env[FAKE_HOST_ENV];
  const realAppRoot = join(fixture, 'app-real');
  const aliasAppRoot = join(fixture, 'app-alias');
  const realDependencyRoot = join(fixture, 'dependency-real');
  const aliasDependencyRoot = join(fixture, 'dependency-alias');
  const realMainPath = join(realAppRoot, 'main.ts');
  const aliasMainPath = join(aliasAppRoot, 'main.ts');
  const nativeProbePath = join(aliasAppRoot, 'native-probe.mjs');
  const dependencyPath = join(realDependencyRoot, 'source.js');
  const fakeHostPath = join(fixture, 'fake-host.cjs');
  const logs: string[] = [];
  let server: NatuiDevServer | undefined;

  const dependencySource = `
const globals = globalThis;
globals[${JSON.stringify(countKey)}] =
  Number(globals[${JSON.stringify(countKey)}] ?? 0) + 1;
export default {
  token: {},
  url: import.meta.url,
};
`;
const resultExpression = `({
  count: Number((globalThis as Record<string, unknown>)[${JSON.stringify(countKey)}] ?? 0),
  copyMain: queriedMain,
  same: realDependency === aliasDependency,
  urls: [realDependency.url, aliasDependency.url],
})`;

  try {
    await Promise.all([
      mkdir(realAppRoot, { recursive: true }),
      mkdir(realDependencyRoot, { recursive: true }),
      writeFile(fakeHostPath, FAKE_HOST_SOURCE),
    ]);
    await Promise.all([
      writeFile(dependencyPath, dependencySource),
      writeFile(
        join(realAppRoot, 'main-copy.mjs'),
        'export const sourceMain = import.meta.main;\n',
      ),
      writeFile(
        join(realAppRoot, 'native-probe.mjs'),
        `
import realDependency from '../dependency-real/source.js';
import aliasDependency from '../dependency-alias/source.js';
import { sourceMain as copyMain } from './main-copy.mjs?copy';
const result = {
  count: Number(globalThis[${JSON.stringify(countKey)}] ?? 0),
  copyMain,
  same: realDependency === aliasDependency,
  urls: [realDependency.url, aliasDependency.url],
};
process.stdout.write(JSON.stringify(result));
`,
      ),
      writeFile(
        realMainPath,
        `
import { createElement } from 'react';
import { run } from '@natui/core';
import realDependency from '../dependency-real/source.js';
import aliasDependency from '../dependency-alias/source.js';
import { sourceMain as queriedMain } from './main.js?copy';

export const sourceMain = import.meta.main;
const result = ${resultExpression};
if (sourceMain) {
  (globalThis as Record<string, unknown>)[${JSON.stringify(resultKey)}] = result;
  const fakeHost = process.env.${FAKE_HOST_ENV};
  if (!fakeHost) throw new Error('${FAKE_HOST_ENV} is not set');
  const app = await run(
    createElement('Text', null, result.same ? 'same' : 'distinct'),
    {
      host: { cmd: process.execPath, args: [fakeHost] },
      onClose() {},
    },
  );
  (globalThis as Record<string, unknown>)[${JSON.stringify(appKey)}] = app;
}
`,
      ),
    ]);
    await symlink(
      realDependencyRoot,
      aliasDependencyRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      realAppRoot,
      aliasAppRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const native = await new Promise<SymlinkIdentityResult>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          [...probe.execArguments, nativeProbePath],
          {
            cwd: fixture,
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error) {
              error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
              reject(error);
              return;
            }
            resolve(JSON.parse(stdout) as SymlinkIdentityResult);
          },
        );
      },
    );

    delete globals[countKey];
    process.env[FAKE_HOST_ENV] = fakeHostPath;
    server = await createDevServer({
      entry: aliasMainPath,
      root: PACKAGE_ROOT,
      log(message) {
        logs.push(message);
      },
    });
    await waitForLog(logs, 0, /\[natui\] mounted /);
    await waitFor('symlink identity app handle', () =>
      globals[appKey] as NatuiApp | undefined,
    );
    const transformed = await waitFor(
      'transformed symlink identities',
      () => globals[resultKey] as SymlinkIdentityResult | undefined,
    );
    assert.deepEqual(transformed, native);
  } finally {
    await server?.close();
    if (previousFakeHost === undefined) delete process.env[FAKE_HOST_ENV];
    else process.env[FAKE_HOST_ENV] = previousFakeHost;
    delete globals[appKey];
    delete globals[countKey];
    delete globals[resultKey];
    await rm(fixture, { recursive: true, force: true });
  }
}

test(
  'setup failures release runtime sessions and partial cache resources',
  { timeout: 20_000 },
  async () => {
    const fixture = await mkdtemp(join(PACKAGE_ROOT, 'natui-dev-setup-'));
    const cacheBase = join(fixture, '.natui');
    const entryPath = join(fixture, 'main.ts');
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    let server: NatuiDevServer | undefined;

    try {
      await writeFile(entryPath, 'export {};\n');
      await writeFile(cacheBase, 'block cache directory creation');
      Date.now = () => 1_700_000_000_000;
      Math.random = () => 0.25;

      await assert.rejects(
        createDevServer({
          entry: entryPath,
          root: fixture,
          log() {},
        }),
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === 'EEXIST',
      );

      await rm(cacheBase, { force: true });
      server = await createDevServer({
        entry: entryPath,
        root: fixture,
        log() {},
      });

      await assert.rejects(
        createDevServer({
          entry: entryPath,
          root: fixture,
          log() {},
        }),
        /duplicate development session/,
      );
      const cacheEntries = await readdir(cacheBase, { withFileTypes: true });
      assert.equal(
        cacheEntries.length,
        1,
        'a duplicate-session setup removed only its own cache directory',
      );
      assert.equal(cacheEntries[0]?.isDirectory(), true);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
      await server?.close();
      if (server) {
        await assert.rejects(
          readdir(cacheBase),
          (error: unknown) =>
            (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'development JSON imports preserve data semantics and reject executable source text',
  { timeout: 20_000 },
  async () => {
    const fixture = await mkdtemp(join(PACKAGE_ROOT, 'natui-dev-json-'));
    const unique = `${process.pid}-${Date.now()}`;
    const observedKey = `__natuiJsonObserved_${unique}`;
    const compromisedKey = `__natuiJsonCompromised_${unique}`;
    const globals = globalThis as Record<string, unknown>;
    const logs: string[] = [];
    const entryPath = join(fixture, 'main.ts');
    const payloadPath = join(fixture, 'payload.json');
    let server: NatuiDevServer | undefined;

    try {
      await writeFile(
        entryPath,
        `
import payload from './payload.json';

(globalThis as Record<string, unknown>)[${JSON.stringify(observedKey)}] = {
  keys: Object.keys(payload),
  ownPrototypeKey: Object.hasOwn(payload, '__proto__'),
  polluted: (payload as Record<string, unknown>).polluted,
};
`,
      );
      await writeFile(
        payloadPath,
        `\uFEFF{"__proto__":{"polluted":"yes"},"safe":1}`,
      );

      server = await createDevServer({
        entry: entryPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });

      const observed = await waitFor('parsed JSON data', () =>
        globals[observedKey] as
          | {
              keys: string[];
              ownPrototypeKey: boolean;
              polluted?: unknown;
            }
          | undefined,
      );
      assert.deepEqual(observed, {
        keys: ['__proto__', 'safe'],
        ownPrototypeKey: true,
        polluted: undefined,
      });

      const invalidJsonLog = logs.length;
      await writeFile(
        payloadPath,
        `(() => { globalThis[${JSON.stringify(compromisedKey)}] = true; return {}; })()`,
      );
      await waitForLog(logs, invalidJsonLog, /natui: invalid JSON/);
      await delay(100);
      assert.strictEqual(globals[compromisedKey], undefined);
    } finally {
      await server?.close();
      delete globals[observedKey];
      delete globals[compromisedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'development preserves Node URL identity for local query and fragment imports',
  { timeout: 30_000 },
  async () => {
    const fixture = await mkdtemp(join(PACKAGE_ROOT, 'natui-dev-suffix-'));
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiSuffixApp_${unique}`;
    const resultKey = `__natuiSuffixResult_${unique}`;
    const globals = globalThis as Record<string, unknown>;
    const previousFakeHost = process.env[FAKE_HOST_ENV];
    const logs: string[] = [];
    const entryPath = join(fixture, 'main.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const sourcePath = join(fixture, 'source.js');
    const valuePath = join(fixture, 'value.js');
    const sourceUrl = pathToFileURL(sourcePath);
    const variantUrls = [
      new URL(sourceUrl.href),
      new URL(`${sourceUrl.href}?`),
      new URL(`${sourceUrl.href}#`),
      new URL(`${sourceUrl.href}?one`),
      new URL(`${sourceUrl.href}?two`),
      new URL(`${sourceUrl.href}#one`),
      new URL(`${sourceUrl.href}#two`),
    ];
    let server: NatuiDevServer | undefined;

    const source = (version: string) => `
export default {
  dirname: import.meta.dirname,
  filename: import.meta.filename,
  resolved: import.meta.resolve('./value.js'),
  token: {},
  url: import.meta.url,
  version: ${JSON.stringify(version)},
};
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(sourcePath, source('one')),
        writeFile(valuePath, 'export const value = true;\n'),
        writeFile(
          entryPath,
          `
import { createElement } from 'react';
import { run } from '@natui/core';
import plain from './source.js';
import emptyQuery from './source.js?';
import emptyFragment from './source.js#';
import queryOne from './source.js?one';
import queryTwo from ${JSON.stringify(variantUrls[4]!.href)};
import fragmentOne from './source.js#one';
import fragmentTwo from ${JSON.stringify(variantUrls[6]!.href)};

const variants = [
  plain,
  emptyQuery,
  emptyFragment,
  queryOne,
  queryTwo,
  fragmentOne,
  fragmentTwo,
];
(globalThis as Record<string, unknown>)[${JSON.stringify(resultKey)}] = variants;
const fakeHost = process.env.${FAKE_HOST_ENV};
if (!fakeHost) throw new Error('${FAKE_HOST_ENV} is not set');
const app = await run(
  createElement('Text', null, variants.map((variant) => variant.version).join(',')),
  {
    host: { cmd: process.execPath, args: [fakeHost] },
    onClose() {},
  },
);
(globalThis as Record<string, unknown>)[${JSON.stringify(appKey)}] = app;
`,
        ),
      ]);

      const nativeResult = await new Promise<{
        identityCount: number;
        variants: Array<{
          dirname: string;
          filename: string;
          resolved: string;
          url: string;
          version: string;
        }>;
      }>((resolve, reject) => {
        const script = `
const modules = await Promise.all(
  ${JSON.stringify(variantUrls.map((url) => url.href))}.map((url) => import(url)),
);
const variants = modules.map((module) => module.default);
process.stdout.write(JSON.stringify({
  identityCount: new Set(variants.map((variant) => variant.token)).size,
  variants: variants.map(({ token, ...variant }) => variant),
}));
`;
        execFile(
          process.execPath,
          ['--input-type=module', '--eval', script],
          {
            cwd: fixture,
            timeout: 10_000,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error) {
              error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
              reject(error);
              return;
            }
            resolve(JSON.parse(stdout) as {
              identityCount: number;
              variants: Array<{
                dirname: string;
                filename: string;
                resolved: string;
                url: string;
                version: string;
              }>;
            });
          },
        );
      });
      assert.equal(
        nativeResult.identityCount,
        5,
        'Node collapses bare query and fragment delimiters into the plain module identity',
      );

      process.env[FAKE_HOST_ENV] = fakeHostPath;
      server = await createDevServer({
        entry: entryPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);
      const app = await waitFor('query and fragment app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      const transformedVariants = await waitFor(
        'transformed query and fragment modules',
        () =>
          globals[resultKey] as
            | Array<{
                dirname: string;
                filename: string;
                resolved: string;
                token: object;
                url: string;
                version: string;
              }>
            | undefined,
      );
      assert.deepEqual(
        transformedVariants.map(({ token: _token, ...variant }) => variant),
        nativeResult.variants,
      );
      assert.equal(
        new Set(transformedVariants.map((variant) => variant.token)).size,
        nativeResult.identityCount,
      );

      const refreshLog = logs.length;
      await writeFile(sourcePath, source('two'));
      await waitForLog(logs, refreshLog, /\[natui\] refreshed #1 /);
      const refreshedVariants = await waitFor(
        'all suffixed module identities to refresh',
        () => {
          const variants = globals[resultKey] as
            | Array<{ token: object; version: string }>
            | undefined;
          return variants?.every((variant) => variant.version === 'two')
            ? variants
            : undefined;
        },
      );
      assert.equal(
        new Set(refreshedVariants.map((variant) => variant.token)).size,
        nativeResult.identityCount,
      );
      await waitFor('refreshed query and fragment tree', async () =>
        textOf(await app.dump()) === 'two,two,two,two,two,two,two'
          ? true
          : undefined,
      );
    } finally {
      await server?.close();
      if (previousFakeHost === undefined) delete process.env[FAKE_HOST_ENV];
      else process.env[FAKE_HOST_ENV] = previousFakeHost;
      delete globals[appKey];
      delete globals[resultKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  SYMLINK_IDENTITY_TEST_NAME,
  { timeout: 90_000 },
  async () => {
    const serializedProbe = process.env[SYMLINK_IDENTITY_PROBE_ENV];
    if (serializedProbe) {
      const probe = JSON.parse(serializedProbe) as SymlinkIdentityProbe;
      const originalExecArgv = process.execArgv;
      process.execArgv = [...probe.execArguments, ...originalExecArgv];
      try {
        await runSymlinkIdentityProbe(probe);
        process.stdout.write(`${probe.completionMarker}\n`);
      } finally {
        process.execArgv = originalExecArgv;
      }
      return;
    }

    const scenarios = [
      { name: 'default', execArguments: [] },
      {
        name: 'dependency preservation',
        execArguments: ['--preserve-symlinks'],
      },
      {
        name: 'main preservation',
        execArguments: ['--preserve-symlinks-main'],
      },
      {
        name: 'dependency and main preservation',
        execArguments: [
          '--preserve-symlinks',
          '--preserve-symlinks-main',
        ],
      },
      {
        name: 'main preservation from environment',
        execArguments: [],
        preserveSymlinksMainEnvironment: '1',
      },
      {
        name: 'command line disables main preservation from environment',
        execArguments: ['--no-preserve-symlinks-main'],
        preserveSymlinksMainEnvironment: '1',
      },
    ];
    await Promise.all(
      scenarios.map(
        (scenario) =>
          new Promise<void>((resolve, reject) => {
            const completionMarker =
              `natui-symlink-identity-complete:${scenario.name}:${process.pid}:${Date.now()}`;
            const environment: NodeJS.ProcessEnv = {
              ...process.env,
              NODE_OPTIONS: '',
              [SYMLINK_IDENTITY_PROBE_ENV]: JSON.stringify({
                completionMarker,
                execArguments: scenario.execArguments,
              } satisfies SymlinkIdentityProbe),
            };
            delete environment.NODE_PRESERVE_SYMLINKS;
            delete environment.NODE_PRESERVE_SYMLINKS_MAIN;
            if (scenario.preserveSymlinksMainEnvironment !== undefined) {
              environment.NODE_PRESERVE_SYMLINKS_MAIN =
                scenario.preserveSymlinksMainEnvironment;
            }
            delete environment.NODE_TEST_CONTEXT;

            execFile(
              process.execPath,
              [
                '--import',
                'tsx',
                '--test',
                '--test-concurrency=1',
                `--test-name-pattern=^${SYMLINK_IDENTITY_TEST_NAME}$`,
                fileURLToPath(import.meta.url),
              ],
              {
                cwd: PACKAGE_ROOT,
                env: environment,
                maxBuffer: 2 * 1024 * 1024,
                timeout: 70_000,
                windowsHide: true,
              },
              (error, stdout, stderr) => {
                if (!error && stdout.includes(completionMarker)) {
                  resolve();
                  return;
                }
                reject(
                  new Error(
                    `${scenario.name} symlink identity child failed or did not complete\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                    { cause: error },
                  ),
                );
              },
            );
          }),
      ),
    );
  },
);

test(
  'static resolution honors custom Node ESM conditions',
  { timeout: 90_000 },
  async () => {
    const completionMarker =
      `natui-static-condition-complete:${process.pid}:${Date.now()}`;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      [STATIC_CONDITION_EXPECTED_ENV]: 'custom',
      [STATIC_CONDITION_COMPLETION_ENV]: completionMarker,
    };
    delete environment.NODE_TEST_CONTEXT;

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--conditions=natui-custom',
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          `--test-name-pattern=^${MAIN_INTEGRATION_TEST_NAME}$`,
          fileURLToPath(import.meta.url),
        ],
        {
          cwd: PACKAGE_ROOT,
          env: environment,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 70_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
            reject(error);
          } else if (!stdout.includes(completionMarker)) {
            reject(
              new Error(
                `custom-condition child did not run the integration test\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
  },
);

test(
  MAIN_INTEGRATION_TEST_NAME,
  { timeout: 60_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-integration-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const pendingDependencyGateKey =
      `__natuiDevIntegrationPendingDependencyGate_${unique}`;
    const pendingDependencyStartedKey =
      `__natuiDevIntegrationPendingDependencyStarted_${unique}`;
    const keys: FixtureKeys = {
      app: `__natuiDevIntegrationApp_${unique}`,
      leafEvaluations: `__natuiDevIntegrationLeafEvaluations_${unique}`,
      moduleIdentity: `__natuiDevIntegrationModule_${unique}`,
      showUnvisited: `__natuiDevIntegrationShowUnvisited_${unique}`,
      storeIdentity: `__natuiDevIntegrationStore_${unique}`,
      transientValueFailure: `__natuiDevIntegrationTransientValueFailure_${unique}`,
      unvisitedEvaluations: `__natuiDevIntegrationUnvisitedEvaluations_${unique}`,
    };
    const leaf = (
      label: string,
      step: number,
      evaluationError?: string,
      renderError?: string,
      effectError?: string,
      effectFollowupError?: string,
      effectFollowupSteps?: number,
    ) => leafSource(
      keys.leafEvaluations,
      label,
      step,
      evaluationError,
      renderError,
      effectError,
      effectFollowupError,
      effectFollowupSteps,
    );
    const globals = globalThis as Record<string, unknown>;
    const previousFakeHost = process.env[FAKE_HOST_ENV];
    const originalConsoleError = console.error;
    const expectedReactErrors: Error[] = [];
    const logs: string[] = [];
    const entryPath = join(fixture, 'main.ts');
    const fileValuePath = join(fixture, 'file-value.js');
    const leafPath = join(fixture, 'leaf.ts');
    const unvisitedPath = join(fixture, 'unvisited.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    let server: NatuiDevServer | undefined;

    try {
      const conditionalPackageRoot = join(
        fixture,
        'node_modules',
        'natui-import-meta-conditional-fixture',
      );
      await mkdir(conditionalPackageRoot, { recursive: true });
      console.error = (...args: unknown[]) => {
        const error = args.find((value): value is Error => value instanceof Error);
        if (error?.message.startsWith('leaf ')) {
          expectedReactErrors.push(error);
          return;
        }
        originalConsoleError(...args);
      };

      await Promise.all([
        writeFile(
          join(fixture, 'package.json'),
          JSON.stringify({
            imports: {
              '#conditional': {
                'natui-custom': './custom-condition.js',
                module: './module-condition.js',
                import: './import-condition.js',
                require: './require-condition.cjs',
              },
              '#external-cjs': './external.cjs',
            },
            type: 'module',
          }),
        ),
        writeFile(
          join(fixture, 'custom-condition.js'),
          `export default 'custom';\n`,
        ),
        writeFile(
          join(fixture, 'module-condition.js'),
          `export default 'module';\n`,
        ),
        writeFile(
          join(fixture, 'import-condition.js'),
          `export default 'import';\n`,
        ),
        writeFile(
          join(fixture, 'require-condition.cjs'),
          'module.exports = true;\n',
        ),
        writeFile(
          join(fixture, 'external.cjs'),
          `module.exports = 'external-cjs';\n`,
        ),
        writeFile(
          join(conditionalPackageRoot, 'package.json'),
          JSON.stringify({
            exports: {
              'natui-custom': './custom.js',
              module: './module.js',
              import: './import.js',
              require: './require.cjs',
            },
            name: 'natui-import-meta-conditional-fixture',
            type: 'module',
          }),
        ),
        writeFile(
          join(conditionalPackageRoot, 'custom.js'),
          `export default 'custom';\n`,
        ),
        writeFile(
          join(conditionalPackageRoot, 'module.js'),
          `export default 'module';\n`,
        ),
        writeFile(
          join(conditionalPackageRoot, 'import.js'),
          `export default 'import';\n`,
        ),
        writeFile(
          join(conditionalPackageRoot, 'require.cjs'),
          'module.exports = true;\n',
        ),
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          entryPath,
          entrySource(
            keys,
            pathToFileURL(fileValuePath).href,
            process.env[STATIC_CONDITION_EXPECTED_ENV] ?? 'import',
          ),
        ),
        writeFile(fileValuePath, `export default 'file-url';\n`),
        writeFile(join(fixture, 'app.ts'), appSource(keys)),
        writeFile(join(fixture, 'store.ts'), storeSource(keys.storeIdentity)),
        writeFile(join(fixture, 'value.ts'), valueSource('')),
        writeFile(leafPath, leaf('old', 1)),
        writeFile(
          unvisitedPath,
          unvisitedSource(keys.unvisitedEvaluations, 'unvisited-v1'),
        ),
      ]);
      process.env[FAKE_HOST_ENV] = fakeHostPath;

      server = await createDevServer({
        entry: entryPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });

      await waitForLog(logs, 0, /\[natui\] mounted /);
      const app = await waitFor('development app handle', () =>
        globals[keys.app] as NatuiApp | undefined,
      );
      const initialTree = await waitForTreeText(app, 'old:0');
      assert.strictEqual(
        globals[keys.leafEvaluations],
        1,
        'the initial leaf module evaluated once',
      );
      const initialButton = byAccessibilityIdentifier(
        initialTree,
        'Button',
        'refresh-increment',
      );

      app.emit(initialButton.id, 'press');
      const countedTree = await waitForTreeText(app, 'old:1');
      const idsBeforeRefresh = nativeIds(countedTree);
      const appBeforeRefresh = globals[keys.app];
      const moduleBeforeRefresh = globals[keys.moduleIdentity];
      const storeBeforeRefresh = globals[keys.storeIdentity];
      assert.ok(moduleBeforeRefresh, 'store module identity is exposed');
      assert.ok(storeBeforeRefresh, 'provider store identity is exposed');

      // BUNDLE_END settles createDevServer before Rollup emits its watch END
      // event. Give the watcher a beat to subscribe before changing the leaf.
      await delay(200);
      const firstRefreshLog = logs.length;
      await writeFile(leafPath, leaf('new', 2));
      await waitForLog(logs, firstRefreshLog, /\[natui\] refreshed #1 /);
      const refreshedTree = await waitForTreeText(app, 'new:1');

      assert.strictEqual(
        globals[keys.app],
        appBeforeRefresh,
        'the development NatuiApp instance was preserved',
      );
      assert.strictEqual(
        globals[keys.moduleIdentity],
        moduleBeforeRefresh,
        'the unchanged store module kept its ESM identity',
      );
      assert.strictEqual(
        globals[keys.storeIdentity],
        storeBeforeRefresh,
        'the provider store object survived the leaf refresh',
      );
      assert.deepEqual(
        nativeIds(refreshedTree),
        idsBeforeRefresh,
        'the native instances survived the leaf refresh',
      );

      app.emit(idsBeforeRefresh.button, 'press');
      const updatedHandlerTree = await waitForTreeText(app, 'new:3');
      assert.deepEqual(nativeIds(updatedHandlerTree), idsBeforeRefresh);

      const sourceRevertLog = logs.length;
      await writeFile(leafPath, leaf('old', 1));
      await waitForLog(logs, sourceRevertLog, /\[natui\] refreshed #2 /);
      const revertedTree = await waitForTreeText(app, 'old:3');
      assert.deepEqual(nativeIds(revertedTree), idsBeforeRefresh);
      app.emit(idsBeforeRefresh.button, 'press');
      await waitForTreeText(app, 'old:4');

      const sourceReturnLog = logs.length;
      await writeFile(leafPath, leaf('new', 2));
      await waitForLog(logs, sourceReturnLog, /\[natui\] refreshed #3 /);
      const returnedTree = await waitForTreeText(app, 'new:4');
      assert.deepEqual(nativeIds(returnedTree), idsBeforeRefresh);
      app.emit(idsBeforeRefresh.button, 'press');
      await waitForTreeText(app, 'new:6');

      const failedRefreshLog = logs.length;
      await writeFile(
        leafPath,
        leaf('broken', 100, 'leaf evaluation exploded'),
      );
      const failure = await waitForLog(
        logs,
        failedRefreshLog,
        /refresh failed; keeping the previous UI/,
      );
      assert.match(failure, /leaf evaluation exploded/);

      const restoredTree = await waitForTreeText(app, 'new:6');
      assert.deepEqual(
        nativeIds(restoredTree),
        idsBeforeRefresh,
        'an evaluation failure left the previous native UI mounted',
      );
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.strictEqual(globals[keys.storeIdentity], storeBeforeRefresh);

      const renderFailureLog = logs.length;
      await writeFile(
        leafPath,
        leaf('render-broken', 100, undefined, 'leaf render exploded'),
      );
      const renderFailure = await waitForLog(
        logs,
        renderFailureLog,
        /refresh failed; recovered the previous code with a remount/,
      );
      assert.match(renderFailure, /leaf render exploded/);
      const renderRestoredTree = await waitForTreeText(app, 'new:0');
      const idsAfterRenderRecovery = nativeIds(renderRestoredTree);
      assert.notDeepEqual(
        idsAfterRenderRecovery,
        idsBeforeRefresh,
        'an unrecoverable render error is accurately reported as a remount',
      );
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.notStrictEqual(globals[keys.storeIdentity], storeBeforeRefresh);
      const storeAfterRenderRecovery = globals[keys.storeIdentity];

      const effectFailureLog = logs.length;
      await writeFile(
        leafPath,
        leaf('effect-broken', 100, undefined, undefined, 'leaf effect exploded'),
      );
      const effectFailure = await waitForLog(
        logs,
        effectFailureLog,
        /refresh failed; recovered the previous code with a remount/,
      );
      assert.match(effectFailure, /leaf effect exploded/);
      const effectRestoredTree = await waitForTreeText(app, 'new:0');
      const idsAfterEffectRecovery = nativeIds(effectRestoredTree);
      assert.notDeepEqual(idsAfterEffectRecovery, idsAfterRenderRecovery);
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.notStrictEqual(globals[keys.storeIdentity], storeAfterRenderRecovery);
      const storeAfterEffectRecovery = globals[keys.storeIdentity];

      const followupFailureLog = logs.length;
      await writeFile(
        leafPath,
        leaf(
          'followup-broken',
          100,
          undefined,
          undefined,
          undefined,
          'leaf effect follow-up exploded',
        ),
      );
      const followupFailure = await waitForLog(
        logs,
        followupFailureLog,
        /refresh failed; recovered the previous code with a remount/,
      );
      assert.match(followupFailure, /leaf effect follow-up exploded/);
      const followupRestoredTree = await waitForTreeText(app, 'new:0');
      const idsAfterFollowupRecovery = nativeIds(followupRestoredTree);
      assert.notDeepEqual(idsAfterFollowupRecovery, idsAfterEffectRecovery);
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.notStrictEqual(globals[keys.storeIdentity], storeAfterEffectRecovery);
      const storeAfterFollowupRecovery = globals[keys.storeIdentity];

      const deepFollowupFailureLog = logs.length;
      await writeFile(
        leafPath,
        leaf(
          'deep-followup-broken',
          100,
          undefined,
          undefined,
          undefined,
          'leaf deep effect follow-up exploded',
          4,
        ),
      );
      const deepFollowupFailure = await waitForLog(
        logs,
        deepFollowupFailureLog,
        /refresh failed; recovered the previous code with a remount/,
      );
      assert.match(deepFollowupFailure, /leaf deep effect follow-up exploded/);
      const deepFollowupRestoredTree = await waitForTreeText(app, 'new:0');
      const idsAfterDeepFollowupRecovery = nativeIds(deepFollowupRestoredTree);
      assert.notDeepEqual(idsAfterDeepFollowupRecovery, idsAfterFollowupRecovery);
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.notStrictEqual(
        globals[keys.storeIdentity],
        storeAfterFollowupRecovery,
      );
      const storeAfterDeepFollowupRecovery = globals[keys.storeIdentity];

      const recoveryLog = logs.length;
      await writeFile(leafPath, leaf('recovered', 4));
      await waitForLog(logs, recoveryLog, /\[natui\] refreshed #4 /);
      const recoveredTree = await waitForTreeText(app, 'recovered:0');
      assert.deepEqual(nativeIds(recoveredTree), idsAfterDeepFollowupRecovery);
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.strictEqual(
        globals[keys.storeIdentity],
        storeAfterDeepFollowupRecovery,
      );

      app.emit(idsAfterDeepFollowupRecovery.button, 'press');
      await waitForTreeText(app, 'recovered:4');
      assert.ok(
        expectedReactErrors.some((error) => error.message === 'leaf render exploded'),
      );
      assert.ok(
        expectedReactErrors.some((error) => error.message === 'leaf effect exploded'),
      );
      assert.ok(
        expectedReactErrors.some(
          (error) => error.message === 'leaf effect follow-up exploded',
        ),
      );
      assert.ok(
        expectedReactErrors.some(
          (error) => error.message === 'leaf deep effect follow-up exploded',
        ),
      );
      assert.strictEqual(
        globals[keys.leafEvaluations],
        10,
        'each emitted leaf revision evaluated exactly once',
      );

      const dependencyRefreshLog = logs.length;
      await writeFile(join(fixture, 'value.ts'), valueSource(':dependency'));
      await waitForLog(logs, dependencyRefreshLog, /\[natui\] refreshed #5 /);
      const afterDependencyEdit = await waitForTreeText(
        app,
        'recovered:4:dependency',
      );
      assert.deepEqual(
        nativeIds(afterDependencyEdit),
        idsAfterDeepFollowupRecovery,
        'refreshing a non-component dependency preserved native instances',
      );
      assert.strictEqual(globals[keys.moduleIdentity], moduleBeforeRefresh);
      assert.strictEqual(
        globals[keys.storeIdentity],
        storeAfterDeepFollowupRecovery,
      );

      globals[keys.transientValueFailure] = true;
      const transientDependencyFailureLog = logs.length;
      await writeFile(
        join(fixture, 'value.ts'),
        valueSource(':cache-recovered', keys.transientValueFailure),
      );
      const transientDependencyFailure = await waitForLog(
        logs,
        transientDependencyFailureLog,
        /refresh failed; keeping the previous UI/,
      );
      assert.match(
        transientDependencyFailure,
        /value transient evaluation exploded/,
      );
      await waitForTreeText(app, 'recovered:4:dependency');
      delete globals[keys.transientValueFailure];

      const unvisitedRefreshLog = logs.length;
      await writeFile(
        unvisitedPath,
        unvisitedSource(keys.unvisitedEvaluations, 'unvisited-v2'),
      );
      await waitForLog(logs, unvisitedRefreshLog, /\[natui\] refreshed #6 /);
      const afterUnvisitedEdit = await waitForTreeText(
        app,
        'recovered:4:cache-recovered',
      );
      assert.deepEqual(
        nativeIds(afterUnvisitedEdit),
        idsAfterDeepFollowupRecovery,
      );
      assert.strictEqual(
        globals[keys.unvisitedEvaluations],
        undefined,
        'editing an unloaded lazy module did not execute it eagerly',
      );

      globals[pendingDependencyGateKey] = new Promise<never>(() => undefined);
      await writeFile(
        join(fixture, 'value.ts'),
        gatedValueSource(
          ':pending-cache-recovered',
          pendingDependencyGateKey,
          pendingDependencyStartedKey,
        ),
      );
      await waitFor('pending dependency evaluation to start', () =>
        globals[pendingDependencyStartedKey] === true ? true : undefined,
      );
      delete globals[pendingDependencyGateKey];

      const pendingDependencyRecoveryLog = logs.length;
      await writeFile(
        unvisitedPath,
        unvisitedSource(keys.unvisitedEvaluations, 'unvisited-v3'),
      );
      await waitForLog(
        logs,
        pendingDependencyRecoveryLog,
        /\[natui\] refreshed #7 /,
      );
      const afterPendingDependencyRecovery = await waitForTreeText(
        app,
        'recovered:4:pending-cache-recovered',
      );
      assert.deepEqual(
        nativeIds(afterPendingDependencyRecovery),
        idsAfterDeepFollowupRecovery,
        'a superseding build did not reuse a pending module job',
      );
      assert.strictEqual(
        globals[keys.unvisitedEvaluations],
        undefined,
        'retrying through an unloaded lazy edit did not execute it eagerly',
      );

      const missingDependencyLog = logs.length;
      await writeFile(
        join(fixture, 'value.ts'),
        missingDependencySource(),
      );
      await waitForLog(
        logs,
        missingDependencyLog,
        /\[natui\] build failed; keeping the previous UI/,
      );
      await mkdir(join(fixture, 'generated', 'deep'), { recursive: true });
      await writeFile(
        join(fixture, 'generated', 'deep', 'created.ts'),
        `export const createdSuffix = ':created' satisfies string;\n`,
      );
      await waitForLog(logs, missingDependencyLog, /\[natui\] refreshed #8 /);
      const afterMissingDependencyAppeared = await waitForTreeText(
        app,
        'recovered:4:created',
      );
      assert.deepEqual(
        nativeIds(afterMissingDependencyAppeared),
        idsAfterDeepFollowupRecovery,
        'creating a previously missing dependency resumed refresh',
      );
    } finally {
      console.error = originalConsoleError;
      await server?.close();
      if (previousFakeHost === undefined) delete process.env[FAKE_HOST_ENV];
      else process.env[FAKE_HOST_ENV] = previousFakeHost;
      delete globals[keys.app];
      delete globals[keys.leafEvaluations];
      delete globals[keys.moduleIdentity];
      delete globals[keys.showUnvisited];
      delete globals[keys.storeIdentity];
      delete globals[keys.transientValueFailure];
      delete globals[keys.unvisitedEvaluations];
      delete globals[pendingDependencyGateKey];
      delete globals[pendingDependencyStartedKey];
      await rm(fixture, { recursive: true, force: true });
    }
    const completionMarker =
      process.env[STATIC_CONDITION_COMPLETION_ENV];
    if (completionMarker) process.stdout.write(`${completionMarker}\n`);
  },
);
