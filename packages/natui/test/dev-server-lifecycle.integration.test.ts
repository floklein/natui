import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
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
const WAIT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const SOURCE_RESOLUTION_PROBE_ENV = 'NATUI_SOURCE_RESOLUTION_PROBE';
const SOURCE_RESOLUTION_PROBE_COMPLETE =
  'natui: source resolution probe complete';
const SOURCE_RESOLUTION_TEST_NAME =
  'source import.meta.resolve mirrors active Node resolution flags';

async function createDevServer(
  options: DevServerOptions,
): Promise<NatuiDevServer> {
  const serverModule = await import('../src/dev/server.js');
  return serverModule.createDevServer(options);
}

const FAKE_HOST_SOURCE = `
const fs = require('node:fs');
const readline = require('node:readline');

const quitMarker = process.argv[2];
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
      fs.writeFileSync(quitMarker, String(process.pid));
      process.exit(0);
      break;
  }
});
`;

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolved: boolean;
  resolve(): void;
}

function deferred(): Deferred {
  let finish!: () => void;
  let resolved = false;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    get resolved() {
      return resolved;
    },
    resolve() {
      if (resolved) return;
      resolved = true;
      finish();
    },
  };
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

async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

function identifiedNode(
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
  return textOf(identifiedNode(root, 'Text', 'lifecycle-status'));
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
  const status = identifiedNode(root, 'Text', 'lifecycle-status');
  const button = identifiedNode(root, 'Button', 'lifecycle-increment');
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

interface SourceResolutionProbe {
  addonFile: 'addons.js' | 'default.js';
  commaFile: 'condition.js' | 'default.js';
  conditionFile: 'condition.js' | 'default.js';
  preserveSymlinks: boolean;
  preserveSymlinksMain: boolean;
  resolverOnly?: boolean;
}

interface SourceResolutionResult {
  addon: string;
  comma: string;
  linked: string;
  long: string;
  moduleSync: string;
  short: string;
  symbolError: {
    message: string;
    name: string;
  } | null;
}

interface SourceResolutionScenario extends SourceResolutionProbe {
  execArguments?: string[];
  name: string;
  nodeOptions?: string;
}

async function writeResolutionPackage(
  nodeModules: string,
  name: string,
  exports: Record<string, string>,
): Promise<void> {
  const packageRoot = join(nodeModules, name);
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        exports,
        name,
        type: 'module',
      }),
    ),
    ...Array.from(new Set(Object.values(exports)), (target) =>
      writeFile(
        join(packageRoot, target.slice(2)),
        `export default ${JSON.stringify(target)};\n`,
      ),
    ),
  ]);
}

async function runSourceResolutionProbe(
  expected: SourceResolutionProbe,
): Promise<void> {
  const fixture = await mkdtemp(
    join(PACKAGE_ROOT, 'natui-dev-resolution-'),
  );
  const unique = `${process.pid}-${Date.now()}`;
  const appKey = `__natuiResolutionApp_${unique}`;
  const resultKey = `__natuiResolutionResult_${unique}`;
  const globals = globalThis as Record<string, unknown>;
  const nodeModules = join(fixture, 'node_modules');
  const linkedTarget = join(fixture, 'linked-target');
  const linkedPackage = join(nodeModules, 'natui-resolution-linked');
  const realParentRoot = join(fixture, 'parent-real');
  const realMainRoot = join(realParentRoot, 'app');
  const aliasParentRoot = join(fixture, 'parent-alias');
  const aliasMainRoot = join(aliasParentRoot, 'app');
  const linkedMainPath = join(aliasMainRoot, 'main.mjs');
  const deletedParentPath = join(fixture, 'deleted-parent.mjs');
  const mainPath = join(fixture, 'main.ts');
  const nativeProbePath = join(fixture, 'native-probe.mjs');
  const fakeHostPath = join(fixture, 'fake-host.cjs');
  const quitMarkerPath = join(fixture, 'host-quit');
  const logs: string[] = [];
  let server: NatuiDevServer | undefined;

  const resolutionExpression = `{
  short: import.meta.resolve('natui-resolution-short'),
  long: import.meta.resolve('natui-resolution-long'),
  comma: import.meta.resolve('natui-resolution-comma'),
  addon: import.meta.resolve('natui-resolution-addon'),
  moduleSync: import.meta.resolve('natui-resolution-module-sync'),
  linked: import.meta.resolve('natui-resolution-linked'),
  symbolError: (() => {
    try {
      import.meta.resolve(Symbol('natui-resolution-symbol'));
      return null;
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : typeof error,
      };
    }
  })(),
}`;

  try {
    await mkdir(nodeModules, { recursive: true });
    await Promise.all([
      writeResolutionPackage(
        nodeModules,
        'natui-resolution-short',
        {
          'natui-short-condition': './condition.js',
          default: './default.js',
        },
      ),
      writeResolutionPackage(
        nodeModules,
        'natui-resolution-long',
        {
          'natui-long-condition': './condition.js',
          default: './default.js',
        },
      ),
      writeResolutionPackage(
        nodeModules,
        'natui-resolution-comma',
        {
          'natui-short-condition,natui-long-condition': './condition.js',
          default: './default.js',
        },
      ),
      writeResolutionPackage(
        nodeModules,
        'natui-resolution-addon',
        {
          'node-addons': './addons.js',
          default: './default.js',
        },
      ),
      writeResolutionPackage(
        nodeModules,
        'natui-resolution-module-sync',
        {
          'module-sync': './module-sync.js',
          default: './default.js',
        },
      ),
      writeResolutionPackage(
        join(realParentRoot, 'node_modules'),
        'natui-resolution-parent',
        { default: './index.js' },
      ),
      writeResolutionPackage(
        join(aliasParentRoot, 'node_modules'),
        'natui-resolution-parent',
        { default: './index.js' },
      ),
      mkdir(realMainRoot, { recursive: true }),
      mkdir(aliasParentRoot, { recursive: true }),
      mkdir(linkedTarget, { recursive: true }),
      writeFile(fakeHostPath, FAKE_HOST_SOURCE),
    ]);
    await Promise.all([
      writeFile(
        join(linkedTarget, 'package.json'),
        JSON.stringify({
          exports: './index.js',
          name: 'natui-resolution-linked',
          type: 'module',
        }),
      ),
      writeFile(
        join(linkedTarget, 'index.js'),
        'export default true;\n',
      ),
      writeFile(join(realMainRoot, 'main.mjs'), 'export {};\n'),
      writeFile(
        deletedParentPath,
        'export const resolveFromDeletedParent = (specifier) => import.meta.resolve(specifier);\n',
      ),
      writeFile(
        nativeProbePath,
        `export default ${resolutionExpression};\n`,
      ),
      writeFile(
        mainPath,
        `
import { createElement } from 'react';
import { run } from '@natui/core';

(globalThis as Record<string, unknown>)[${JSON.stringify(resultKey)}] =
  ${resolutionExpression};

const app = await run(createElement('Text', null, 'ready'), {
  host: {
    cmd: process.execPath,
    args: [${JSON.stringify(fakeHostPath)}, ${JSON.stringify(quitMarkerPath)}],
  },
  onClose() {},
});

(globalThis as Record<string, unknown>)[${JSON.stringify(appKey)}] = app;
`,
      ),
    ]);
    await symlink(
      linkedTarget,
      linkedPackage,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      realMainRoot,
      aliasMainRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const native = (
      await import(
        `${pathToFileURL(nativeProbePath).href}?probe=${encodeURIComponent(unique)}`
      )
    ).default as SourceResolutionResult;

    const resolution = await import('../src/dev/resolution.js');
    const canonicalMainUrl = resolution.canonicalSourceUrl(
      pathToFileURL(linkedMainPath),
      true,
    );
    const selectedParentRoot = expected.preserveSymlinksMain
      ? aliasParentRoot
      : realParentRoot;
    const selectedPackagePath = join(
      selectedParentRoot,
      'node_modules',
      'natui-resolution-parent',
      'index.js',
    );
    const expectedMainPath = expected.preserveSymlinksMain
      ? linkedMainPath
      : await realpath(linkedMainPath);
    const expectedPackagePath = expected.preserveSymlinks
      ? selectedPackagePath
      : await realpath(selectedPackagePath);
    assert.equal(
      canonicalMainUrl.href,
      pathToFileURL(expectedMainPath).href,
    );
    assert.equal(
      resolution.resolveSourceSpecifier(
        'natui-resolution-parent',
        pathToFileURL(linkedMainPath),
        true,
      ),
      pathToFileURL(expectedPackagePath).href,
    );
    const deletedParentModule = await import(
      `${pathToFileURL(deletedParentPath).href}?probe=${encodeURIComponent(unique)}`
    ) as {
      resolveFromDeletedParent(specifier: string): string;
    };
    const canonicalDeletedParentUrl = resolution.canonicalSourceUrl(
      pathToFileURL(deletedParentPath),
    );
    await rm(deletedParentPath);
    assert.equal(
      resolution.resolveSourceSpecifier(
        './deleted-target.js',
        canonicalDeletedParentUrl,
      ),
      deletedParentModule.resolveFromDeletedParent('./deleted-target.js'),
    );

    let transformed: SourceResolutionResult;
    if (expected.resolverOnly) {
      const parentUrl = pathToFileURL(nativeProbePath);
      const resolve = (specifier: unknown) =>
        resolution.resolveSourceSpecifier(specifier as string, parentUrl);
      let symbolError: SourceResolutionResult['symbolError'] = null;
      try {
        resolve(Symbol('natui-resolution-symbol'));
      } catch (error) {
        symbolError = {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
        };
      }
      transformed = {
        addon: resolve('natui-resolution-addon'),
        comma: resolve('natui-resolution-comma'),
        linked: resolve('natui-resolution-linked'),
        long: resolve('natui-resolution-long'),
        moduleSync: resolve('natui-resolution-module-sync'),
        short: resolve('natui-resolution-short'),
        symbolError,
      };
    } else {
      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);
      await waitFor('source resolution app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      transformed = await waitFor(
        'transformed source resolutions',
        () => globals[resultKey] as SourceResolutionResult | undefined,
      );
    }

    assert.deepEqual(transformed, native);
    assert.ok(native.short.endsWith(`/${expected.conditionFile}`));
    assert.ok(native.long.endsWith(`/${expected.conditionFile}`));
    assert.ok(native.comma.endsWith(`/${expected.commaFile}`));
    assert.ok(native.addon.endsWith(`/${expected.addonFile}`));
    assert.ok(
      native.moduleSync.endsWith(
        process.features.require_module === true
          ? '/module-sync.js'
          : '/default.js',
      ),
    );
    assert.equal(native.symbolError?.name, 'TypeError');
    assert.match(native.symbolError?.message ?? '', /Symbol/);
    assert.ok(
      native.linked.includes(
        expected.preserveSymlinks
          ? '/node_modules/natui-resolution-linked/index.js'
          : '/linked-target/index.js',
      ),
    );

    if (server) {
      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'source resolution probe server close',
      );
      server = undefined;
    }
  } finally {
    if (server) {
      await settleWithin(
        server.close(),
        WAIT_TIMEOUT_MS,
        'source resolution probe cleanup',
      ).catch(() => undefined);
    }
    delete globals[appKey];
    delete globals[resultKey];
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runSourceResolutionScenario(
  scenario: SourceResolutionScenario,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [SOURCE_RESOLUTION_PROBE_ENV]: JSON.stringify({
      addonFile: scenario.addonFile,
      commaFile: scenario.commaFile,
      conditionFile: scenario.conditionFile,
      preserveSymlinks: scenario.preserveSymlinks,
      preserveSymlinksMain: scenario.preserveSymlinksMain,
      resolverOnly: scenario.resolverOnly,
    } satisfies SourceResolutionProbe),
    NODE_OPTIONS: scenario.nodeOptions ?? '',
  };
  delete environment.NODE_PRESERVE_SYMLINKS;
  delete environment.NODE_TEST_CONTEXT;

  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        ...(scenario.execArguments ?? []),
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        `--test-name-pattern=${SOURCE_RESOLUTION_TEST_NAME}`,
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: PACKAGE_ROOT,
        env: environment,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error && stdout.includes(SOURCE_RESOLUTION_PROBE_COMPLETE)) {
          resolve();
          return;
        }
        reject(
          new Error(
            `${scenario.name} source resolution subprocess failed or did not run its probe\n${stdout}\n${stderr}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

function mainSource(
  appKey: string,
  fakeHostPath: string,
  quitMarkerPath: string,
): string {
  return `
import { createElement } from 'react';
import { run } from '@natui/core';
import { App } from './app.js';

const app = await run(createElement(App), {
  host: {
    cmd: process.execPath,
    args: [${JSON.stringify(fakeHostPath)}, ${JSON.stringify(quitMarkerPath)}],
  },
  onClose() {},
});

(globalThis as Record<string, unknown>)[${JSON.stringify(appKey)}] = app;
`;
}

const APP_SOURCE = `
import { createElement } from 'react';
import { Leaf } from './leaf.js';

export function App() {
  return createElement(Leaf);
}
`;

interface WaitingLeaf {
  gateKey: string;
  releasedKey: string;
  startedKey: string;
}

function leafSource(
  label: string,
  step: number,
  waiting?: WaitingLeaf,
): string {
  const prelude = waiting
    ? `
const lifecycleGlobals = globalThis as Record<string, unknown>;
lifecycleGlobals[${JSON.stringify(waiting.startedKey)}] = true;
const lifecycleGate = lifecycleGlobals[${JSON.stringify(waiting.gateKey)}];
if (!(lifecycleGate instanceof Promise)) {
  throw new Error('lifecycle gate is missing');
}
await lifecycleGate;
lifecycleGlobals[${JSON.stringify(waiting.releasedKey)}] = true;
`
    : '';

  return `
import { createElement, useState } from 'react';

${prelude}

export function Leaf() {
  const [count, setCount] = useState(0);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + ${step}),
      },
      'increment',
    ),
  );
}
`;
}

function suspendedAppSource(
  gateKey: string,
  releaseKey: string,
  startedKey: string,
): string {
  return `
import { createElement } from 'react';

const lifecycleGlobals = globalThis as Record<string, unknown>;
const lifecycleGate = lifecycleGlobals[${JSON.stringify(gateKey)}];
if (!(lifecycleGate instanceof Promise)) {
  throw new Error('initial suspension gate is missing');
}

export function App() {
  lifecycleGlobals[${JSON.stringify(startedKey)}] = true;
  if (!lifecycleGlobals[${JSON.stringify(releaseKey)}]) {
    throw lifecycleGate;
  }
  return createElement('Text', null, 'released');
}
`;
}

function lazyAppSource(
  label: string,
  showLazyKey: string,
  importDuringEvaluation: boolean,
): string {
  const lazySetup = importDuringEvaluation
    ? `
const lazyPromise = import('./lazy.js');
const Lazy = lazy(() => lazyPromise);
`
    : "const Lazy = lazy(() => import('./lazy.js'));";
  const showLazy = importDuringEvaluation
    ? 'true'
    : `Boolean(
    (globalThis as Record<string, unknown>)[${JSON.stringify(showLazyKey)}],
  )`;

  return `
import { createElement, lazy, useState } from 'react';

${lazySetup}

export function App() {
  const [count, setCount] = useState(0);
  const showLazy = ${showLazy};
  if (showLazy) return createElement(Lazy);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;
}

interface LazyModuleKeys {
  counterKey: string;
  gateKey: string;
  releasedKey: string;
  startedKey: string;
  updatedKey: string;
}

function lazyModuleSource(
  keys: LazyModuleKeys,
  waitForGate: boolean,
): string {
  const wait = waitForGate
    ? `
lazyGlobals[${JSON.stringify(keys.startedKey)}] = true;
const lazyGate = lazyGlobals[${JSON.stringify(keys.gateKey)}];
if (!(lazyGate instanceof Promise)) throw new Error('lazy gate is missing');
await lazyGate;
lazyGlobals[${JSON.stringify(keys.releasedKey)}] = true;
`
    : `lazyGlobals[${JSON.stringify(keys.updatedKey)}] = true;`;

  return `
import { createElement } from 'react';

const lazyGlobals = globalThis as Record<string, unknown>;
lazyGlobals[${JSON.stringify(keys.counterKey)}] =
  Number(lazyGlobals[${JSON.stringify(keys.counterKey)}] ?? 0) + 1;
${wait}

export default function LazyLeaf() {
  return createElement('Text', null, 'lazy');
}
`;
}

interface StaleLazyKeys {
  gateKey: string;
  releasedKey: string;
  startedKey: string;
  v2EvaluatedKey: string;
}

function stableStatusAppSource(label: string): string {
  return `
import { createElement } from 'react';

export function App() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    ${JSON.stringify(label)},
  );
}
`;
}

function suspenseLazyAppSource(): string {
  return `
import { Suspense, createElement, lazy } from 'react';

const LazyLeaf = lazy(() => import('./lazy.js'));

export function App() {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        'loading',
      ),
    },
    createElement(LazyLeaf),
  );
}
`;
}

function gatedStaleLazySource(keys: StaleLazyKeys): string {
  return `
import { createElement } from 'react';

const lazyGlobals = globalThis as Record<string, unknown>;
lazyGlobals[${JSON.stringify(keys.startedKey)}] = true;
const lazyGate = lazyGlobals[${JSON.stringify(keys.gateKey)}];
if (!(lazyGate instanceof Promise)) throw new Error('lazy gate is missing');
await lazyGate;
lazyGlobals[${JSON.stringify(keys.releasedKey)}] = true;

export default function LazyLeaf() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    'stale-v1',
  );
}
`;
}

function currentLazySource(keys: StaleLazyKeys): string {
  return `
import { createElement } from 'react';

const lazyGlobals = globalThis as Record<string, unknown>;
lazyGlobals[${JSON.stringify(keys.v2EvaluatedKey)}] = true;

export default function LazyLeaf() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    'current-v2',
  );
}
`;
}

interface PromiseContextKeys {
  callbackKey: string;
  gateKey: string;
  installedKey: string;
  v1EvaluatedKey: string;
  v2EvaluatedKey: string;
}

function promiseContextAppSource(
  label: string,
  keys: PromiseContextKeys,
): string {
  return `
import {
  Suspense,
  createElement,
  lazy,
  useEffect,
  useState,
} from 'react';

const LazyLeaf = lazy(() => import('./lazy.js'));

export function App() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const effectGlobals = globalThis as Record<string, unknown>;
    if (effectGlobals[${JSON.stringify(keys.installedKey)}]) return;
    effectGlobals[${JSON.stringify(keys.installedKey)}] = true;
    const gate = effectGlobals[${JSON.stringify(keys.gateKey)}];
    if (!(gate instanceof Promise)) {
      throw new Error('Promise context gate is missing');
    }
    void gate.then(() => {
      effectGlobals[${JSON.stringify(keys.callbackKey)}] =
        Number(effectGlobals[${JSON.stringify(keys.callbackKey)}] ?? 0) + 1;
      setShow(true);
    });
  }, []);

  if (!show) {
    return createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + '-hidden',
    );
  }

  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        'loading',
      ),
    },
    createElement(LazyLeaf),
  );
}
`;
}

function statefulLazySource(
  label: string,
  evaluatedKey: string,
): string {
  return `
import { createElement, useState } from 'react';

const lazyGlobals = globalThis as Record<string, unknown>;
lazyGlobals[${JSON.stringify(evaluatedKey)}] =
  Number(lazyGlobals[${JSON.stringify(evaluatedKey)}] ?? 0) + 1;

export default function LazyLeaf() {
  const [count, setCount] = useState(0);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;
}

test(
  SOURCE_RESOLUTION_TEST_NAME,
  { timeout: 90_000 },
  async () => {
    const serializedProbe = process.env[SOURCE_RESOLUTION_PROBE_ENV];
    if (serializedProbe) {
      await runSourceResolutionProbe(
        JSON.parse(serializedProbe) as SourceResolutionProbe,
      );
      console.log(SOURCE_RESOLUTION_PROBE_COMPLETE);
      return;
    }

    await Promise.all([
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'default.js',
        conditionFile: 'default.js',
        name: 'default Node conditions',
        preserveSymlinks: false,
        preserveSymlinksMain: false,
      }),
      runSourceResolutionScenario({
        addonFile: 'default.js',
        commaFile: 'default.js',
        conditionFile: 'condition.js',
        execArguments: [
          '-C',
          'natui-short-condition',
          '--conditions=natui-long-condition',
          '--no-addons',
          '--preserve-symlinks',
        ],
        name: 'process.execArgv conditions and symlink flags',
        preserveSymlinks: true,
        preserveSymlinksMain: false,
        resolverOnly: true,
      }),
      runSourceResolutionScenario({
        addonFile: 'default.js',
        commaFile: 'default.js',
        conditionFile: 'condition.js',
        name: 'NODE_OPTIONS conditions and symlink flags',
        nodeOptions:
          '-C "natui-short-condition" --conditions="natui-long-condition" --no-addons --preserve-symlinks',
        preserveSymlinks: true,
        preserveSymlinksMain: false,
        resolverOnly: true,
      }),
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'default.js',
        conditionFile: 'default.js',
        execArguments: [
          '--addons=false',
          '--no_preserve_symlinks=false',
          '--no_preserve_symlinks_main=false',
        ],
        name: 'command line overrides NODE_OPTIONS booleans',
        nodeOptions:
          '--no_addons=false --preserve_symlinks=false --preserve_symlinks_main=false',
        preserveSymlinks: false,
        preserveSymlinksMain: false,
      }),
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'default.js',
        conditionFile: 'default.js',
        execArguments: [
          '--conditions=node-addons',
          '--no-addons',
        ],
        name: 'explicit node-addons condition survives --no-addons',
        preserveSymlinks: false,
        preserveSymlinksMain: false,
        resolverOnly: true,
      }),
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'condition.js',
        conditionFile: 'default.js',
        execArguments: [
          '--conditions=natui-short-condition,natui-long-condition',
        ],
        name: 'comma-separated condition text stays a single condition',
        preserveSymlinks: false,
        preserveSymlinksMain: false,
      }),
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'default.js',
        conditionFile: 'default.js',
        execArguments: ['--preserve-symlinks-main'],
        name: 'main-entry symlink preservation is independent',
        preserveSymlinks: false,
        preserveSymlinksMain: true,
      }),
      runSourceResolutionScenario({
        addonFile: 'addons.js',
        commaFile: 'default.js',
        conditionFile: 'default.js',
        execArguments: [
          '--preserve-symlinks',
          '--preserve-symlinks-main',
        ],
        name: 'main and child symlink preservation combine',
        preserveSymlinks: true,
        preserveSymlinksMain: true,
        resolverOnly: true,
      }),
    ]);
  },
);

test(
  'a newer generation supersedes a gated evaluation and close ignores stale imports',
  { timeout: 45_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleApp_${unique}`;
    const firstWaiting: WaitingLeaf = {
      gateKey: `__natuiLifecycleGateA_${unique}`,
      releasedKey: `__natuiLifecycleReleasedA_${unique}`,
      startedKey: `__natuiLifecycleStartedA_${unique}`,
    };
    const secondWaiting: WaitingLeaf = {
      gateKey: `__natuiLifecycleGateB_${unique}`,
      releasedKey: `__natuiLifecycleReleasedB_${unique}`,
      startedKey: `__natuiLifecycleStartedB_${unique}`,
    };
    const firstGate = deferred();
    const secondGate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[firstWaiting.gateKey] = firstGate.promise;
    globals[secondWaiting.gateKey] = secondGate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const leafPath = join(fixture, 'leaf.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(join(fixture, 'app.ts'), APP_SOURCE),
        writeFile(leafPath, leafSource('initial', 1)),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('development app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      const initialTree = await waitForTreeText(app, 'initial:0');
      const initialButton = identifiedNode(
        initialTree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(initialButton.id, 'press');
      const countedTree = await waitForTreeText(app, 'initial:1');
      const preservedIds = nativeIds(countedTree);

      // createDevServer settles at BUNDLE_END, immediately before Rollup's
      // final watch END event. Wait until the watcher has subscribed.
      await delay(200);
      await writeFile(leafPath, leafSource('stale', 100, firstWaiting));
      await waitFor('first gated leaf evaluation to start', () =>
        globals[firstWaiting.startedKey] === true ? true : undefined,
      );

      const validRefreshLog = logs.length;
      await writeFile(leafPath, leafSource('current', 2));
      await waitForLog(logs, validRefreshLog, /\[natui\] refreshed #1 /);
      const currentTree = await waitForTreeText(app, 'current:1');
      assert.deepEqual(
        nativeIds(currentTree),
        preservedIds,
        'the superseding generation preserved native instances',
      );
      assert.equal(firstGate.resolved, false, 'the stale gate is still pending');

      app.emit(preservedIds.button, 'press');
      const currentCountedTree = await waitForTreeText(app, 'current:3');
      assert.deepEqual(nativeIds(currentCountedTree), preservedIds);

      const logCountBeforeStaleRelease = logs.length;
      firstGate.resolve();
      await waitFor('stale module continuation to run', () =>
        globals[firstWaiting.releasedKey] === true ? true : undefined,
      );
      await delay(200);
      const afterStaleRelease = await app.dump();
      assert.equal(statusText(afterStaleRelease), 'current:3');
      assert.deepEqual(nativeIds(afterStaleRelease), preservedIds);
      assert.equal(
        logs.length,
        logCountBeforeStaleRelease,
        'the stale generation did not report another refresh',
      );

      await writeFile(leafPath, leafSource('never', 1000, secondWaiting));
      await waitFor('second gated leaf evaluation to start', () =>
        globals[secondWaiting.startedKey] === true ? true : undefined,
      );
      assert.equal(secondGate.resolved, false);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'close with a permanently gated stale generation',
      );
      server = undefined;
      assert.equal(
        secondGate.resolved,
        false,
        'close did not require resolving the stale module gate',
      );
      await waitFor('fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      // These releases only make cleanup possible after a failed close
      // assertion. Passing behavior leaves the second gate unresolved.
      if (server) {
        firstGate.resolve();
        secondGate.resolve();
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'lifecycle test cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      for (const waiting of [firstWaiting, secondWaiting]) {
        delete globals[waiting.gateKey];
        delete globals[waiting.releasedKey];
        delete globals[waiting.startedKey];
      }
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'an initial render suspended forever can close and terminate its host',
  { timeout: 30_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleSuspendedApp_${unique}`;
    const gateKey = `__natuiLifecycleInitialGate_${unique}`;
    const releaseKey = `__natuiLifecycleInitialRelease_${unique}`;
    const startedKey = `__natuiLifecycleInitialStarted_${unique}`;
    const gate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[gateKey] = gate.promise;
    globals[releaseKey] = false;

    const mainPath = join(fixture, 'main.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(
          join(fixture, 'app.ts'),
          suspendedAppSource(gateKey, releaseKey, startedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log() {},
      });
      await waitFor('initial suspended render to start', () =>
        globals[startedKey] === true ? true : undefined,
      );
      assert.equal(
        globals[appKey],
        undefined,
        'run is still waiting for the initial render',
      );
      assert.equal(gate.resolved, false);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'close with a permanently suspended initial render',
      );
      server = undefined;
      assert.equal(
        gate.resolved,
        false,
        'close did not require resolving the React suspension',
      );
      await waitFor('fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      if (server) {
        globals[releaseKey] = true;
        gate.resolve();
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'suspended mount test cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[gateKey];
      delete globals[releaseKey];
      delete globals[startedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a syntax-invalid newer build cancels a gated valid generation',
  { timeout: 30_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleSyntaxApp_${unique}`;
    const waiting: WaitingLeaf = {
      gateKey: `__natuiLifecycleSyntaxGate_${unique}`,
      releasedKey: `__natuiLifecycleSyntaxReleased_${unique}`,
      startedKey: `__natuiLifecycleSyntaxStarted_${unique}`,
    };
    const gate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[waiting.gateKey] = gate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const leafPath = join(fixture, 'leaf.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(join(fixture, 'app.ts'), APP_SOURCE),
        writeFile(leafPath, leafSource('stable', 1)),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('syntax race app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      const initialTree = await waitForTreeText(app, 'stable:0');
      const button = identifiedNode(
        initialTree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(button.id, 'press');
      const countedTree = await waitForTreeText(app, 'stable:1');
      const preservedIds = nativeIds(countedTree);

      await delay(200);
      await writeFile(leafPath, leafSource('must-not-commit', 100, waiting));
      await waitFor('syntax-race gated generation to start', () =>
        globals[waiting.startedKey] === true ? true : undefined,
      );

      const buildErrorLog = logs.length;
      await writeFile(leafPath, 'export function Leaf( {');
      await waitForLog(
        logs,
        buildErrorLog,
        /\[natui\] build failed; keeping the previous UI/,
      );
      assert.equal(gate.resolved, false);
      const beforeGateRelease = await app.dump();
      assert.equal(statusText(beforeGateRelease), 'stable:1');
      assert.deepEqual(nativeIds(beforeGateRelease), preservedIds);

      const logCountAfterBuildError = logs.length;
      gate.resolve();
      await waitFor('syntax-race stale continuation to run', () =>
        globals[waiting.releasedKey] === true ? true : undefined,
      );
      await delay(200);
      const afterGateRelease = await app.dump();
      assert.equal(statusText(afterGateRelease), 'stable:1');
      assert.deepEqual(nativeIds(afterGateRelease), preservedIds);
      assert.equal(
        logs.length,
        logCountAfterBuildError,
        'the build-error-canceled generation did not log a refresh',
      );

      const recoveryLog = logs.length;
      await writeFile(leafPath, leafSource('recovered', 2));
      await waitForLog(logs, recoveryLog, /\[natui\] refreshed #1 /);
      const recoveredTree = await waitForTreeText(app, 'recovered:1');
      assert.deepEqual(nativeIds(recoveredTree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'syntax race server close',
      );
      server = undefined;
      await waitFor('syntax race fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      gate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'syntax race cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[waiting.gateKey];
      delete globals[waiting.releasedKey];
      delete globals[waiting.startedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a canceled generation does not promote an evaluated lazy module',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleLazyApp_${unique}`;
    const showLazyKey = `__natuiLifecycleShowLazy_${unique}`;
    const lazyKeys: LazyModuleKeys = {
      counterKey: `__natuiLifecycleLazyCount_${unique}`,
      gateKey: `__natuiLifecycleLazyGate_${unique}`,
      releasedKey: `__natuiLifecycleLazyReleased_${unique}`,
      startedKey: `__natuiLifecycleLazyStarted_${unique}`,
      updatedKey: `__natuiLifecycleLazyUpdated_${unique}`,
    };
    const lazyGate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[showLazyKey] = false;
    globals[lazyKeys.gateKey] = lazyGate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(
          appPath,
          lazyAppSource('stable', showLazyKey, false),
        ),
        writeFile(lazyPath, lazyModuleSource(lazyKeys, true)),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('lazy race app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      const initialTree = await waitForTreeText(app, 'stable:0');
      assert.equal(
        globals[lazyKeys.counterKey],
        undefined,
        'the initial generation did not evaluate the lazy module',
      );
      const button = identifiedNode(
        initialTree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(button.id, 'press');
      const countedTree = await waitForTreeText(app, 'stable:1');
      const preservedIds = nativeIds(countedTree);

      await delay(200);
      await writeFile(
        appPath,
        lazyAppSource('must-not-commit', showLazyKey, true),
      );
      await waitFor('canceled generation to begin evaluating lazy module', () =>
        globals[lazyKeys.startedKey] === true ? true : undefined,
      );
      assert.equal(globals[lazyKeys.counterKey], 1);

      const returnLog = logs.length;
      await writeFile(
        appPath,
        lazyAppSource('stable', showLazyKey, false),
      );
      await waitForLog(logs, returnLog, /\[natui\] refreshed #1 /);
      const returnedTree = await waitForTreeText(app, 'stable:1');
      assert.deepEqual(nativeIds(returnedTree), preservedIds);
      assert.equal(lazyGate.resolved, false);

      const logCountBeforeStaleRelease = logs.length;
      lazyGate.resolve();
      await waitFor('canceled lazy module continuation to run', () =>
        globals[lazyKeys.releasedKey] === true ? true : undefined,
      );
      await delay(200);
      assert.equal(logs.length, logCountBeforeStaleRelease);
      const afterStaleRelease = await app.dump();
      assert.equal(statusText(afterStaleRelease), 'stable:1');
      assert.deepEqual(nativeIds(afterStaleRelease), preservedIds);

      const lazyEditLog = logs.length;
      await writeFile(lazyPath, lazyModuleSource(lazyKeys, false));
      await waitForLog(logs, lazyEditLog, /\[natui\] refreshed #2 /);
      assert.equal(
        globals[lazyKeys.counterKey],
        1,
        'editing the never-committed lazy module did not evaluate it',
      );
      assert.equal(
        globals[lazyKeys.updatedKey],
        undefined,
        'the edited lazy module top-level effect did not run eagerly',
      );
      const afterLazyEdit = await waitForTreeText(app, 'stable:1');
      assert.deepEqual(nativeIds(afterLazyEdit), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'lazy race server close',
      );
      server = undefined;
      await waitFor('lazy race fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      lazyGate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'lazy race cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[showLazyKey];
      for (const key of Object.values(lazyKeys)) delete globals[key];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a stale React.lazy resolution cannot replace a newer lazy generation',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleStaleLazyApp_${unique}`;
    const lazyKeys: StaleLazyKeys = {
      gateKey: `__natuiLifecycleStaleLazyGate_${unique}`,
      releasedKey: `__natuiLifecycleStaleLazyReleased_${unique}`,
      startedKey: `__natuiLifecycleStaleLazyStarted_${unique}`,
      v2EvaluatedKey: `__natuiLifecycleStaleLazyV2_${unique}`,
    };
    const staleGate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[lazyKeys.gateKey] = staleGate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, stableStatusAppSource('stable')),
        writeFile(lazyPath, gatedStaleLazySource(lazyKeys)),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('stale lazy app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'stable');

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, suspenseLazyAppSource());
      await waitFor('stale lazy v1 evaluation to start', () =>
        globals[lazyKeys.startedKey] === true ? true : undefined,
      );
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitForTreeText(app, 'loading');
      assert.equal(staleGate.resolved, false);

      const thirdGenerationLog = logs.length;
      await writeFile(lazyPath, currentLazySource(lazyKeys));
      await waitFor('current lazy v2 evaluation', () =>
        globals[lazyKeys.v2EvaluatedKey] === true ? true : undefined,
      );
      await waitForLog(
        logs,
        thirdGenerationLog,
        /\[natui\] refreshed #2 /,
      );
      await waitForTreeText(app, 'current-v2');

      const logCountBeforeStaleRelease = logs.length;
      staleGate.resolve();
      await waitFor('stale lazy v1 continuation to run', () =>
        globals[lazyKeys.releasedKey] === true ? true : undefined,
      );
      await delay(200);
      const afterStaleRelease = await app.dump();
      assert.equal(statusText(afterStaleRelease), 'current-v2');
      assert.equal(
        logs.length,
        logCountBeforeStaleRelease,
        'the stale lazy resolution did not log another refresh',
      );

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'stale lazy server close',
      );
      server = undefined;
      await waitFor('stale lazy fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      staleGate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'stale lazy cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      for (const key of Object.values(lazyKeys)) delete globals[key];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a Promise callback from a retired generation binds lazy work to the current generation',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecyclePromiseApp_${unique}`;
    const keys: PromiseContextKeys = {
      callbackKey: `__natuiLifecyclePromiseCallback_${unique}`,
      gateKey: `__natuiLifecyclePromiseGate_${unique}`,
      installedKey: `__natuiLifecyclePromiseInstalled_${unique}`,
      v1EvaluatedKey: `__natuiLifecyclePromiseLazyV1_${unique}`,
      v2EvaluatedKey: `__natuiLifecyclePromiseLazyV2_${unique}`,
    };
    const promiseGate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[keys.gateKey] = promiseGate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, promiseContextAppSource('g1', keys)),
        writeFile(
          lazyPath,
          statefulLazySource('v1', keys.v1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('Promise context app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-hidden');
      await waitFor('G1 Promise callback installation', () =>
        globals[keys.installedKey] === true ? true : undefined,
      );
      assert.equal(globals[keys.v1EvaluatedKey], undefined);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, promiseContextAppSource('g2', keys));
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitForTreeText(app, 'g2-hidden');
      assert.equal(promiseGate.resolved, false);

      promiseGate.resolve();
      await waitFor('retired G1 Promise callback', () =>
        globals[keys.callbackKey] === 1 ? true : undefined,
      );
      await waitFor('lazy v1 evaluation from retired context', () =>
        globals[keys.v1EvaluatedKey] === 1 ? true : undefined,
      );
      const v1Tree = await waitForTreeText(app, 'v1:0');
      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const lazyRefreshLog = logs.length;
      await writeFile(
        lazyPath,
        statefulLazySource('v2', keys.v2EvaluatedKey),
      );
      await waitFor('lazy v2 evaluation', () =>
        globals[keys.v2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, lazyRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);
      assert.equal(
        globals[keys.callbackKey],
        1,
        'the Promise callback was installed only by G1',
      );

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'Promise context server close',
      );
      server = undefined;
      await waitFor('Promise context fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      promiseGate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'Promise context cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      for (const key of Object.values(keys)) delete globals[key];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a retired TLA continuation cannot rebind a newly started nested import to the current generation',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleNestedImportApp_${unique}`;
    const gateKey = `__natuiLifecycleNestedImportGate_${unique}`;
    const startedKey = `__natuiLifecycleNestedImportStarted_${unique}`;
    const releasedKey = `__natuiLifecycleNestedImportReleased_${unique}`;
    const evaluatedKey = `__natuiLifecycleNestedImportEvaluated_${unique}`;
    const staleGate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[gateKey] = staleGate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const leafPath = join(fixture, 'leaf.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const normalAppSource = `
import { createElement } from 'react';
import { Leaf } from './leaf.js';

export function App() {
  return createElement(Leaf);
}
`;
    const gatedAppSource = `
import { createElement } from 'react';

const nestedGlobals = globalThis as Record<string, unknown>;
nestedGlobals[${JSON.stringify(startedKey)}] = true;
const nestedGate = nestedGlobals[${JSON.stringify(gateKey)}];
if (!(nestedGate instanceof Promise)) {
  throw new Error('nested import gate is missing');
}
await nestedGate;
nestedGlobals[${JSON.stringify(releasedKey)}] = true;
const { Leaf } = await import('./leaf.js');

export function App() {
  return createElement(Leaf);
}
`;
    const leafSource = (label: string) => `
import { createElement } from 'react';

globalThis[${JSON.stringify(evaluatedKey)}] = ${JSON.stringify(label)};

export function Leaf() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    ${JSON.stringify(label)},
  );
}
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, normalAppSource),
        writeFile(leafPath, leafSource('stable-v1')),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('nested import app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'stable-v1');

      await delay(200);
      await Promise.all([
        writeFile(appPath, gatedAppSource),
        writeFile(leafPath, leafSource('stale-v2')),
      ]);
      await waitFor('retired nested import generation to reach TLA', () =>
        globals[startedKey] === true ? true : undefined,
      );
      assert.equal(staleGate.resolved, false);

      const currentGenerationLog = logs.length;
      await Promise.all([
        writeFile(appPath, normalAppSource),
        writeFile(leafPath, leafSource('current-v3')),
      ]);
      await waitForLog(
        logs,
        currentGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitForTreeText(app, 'current-v3');

      const logCountBeforeStaleRelease = logs.length;
      staleGate.resolve();
      await waitFor('retired nested import continuation', () =>
        globals[releasedKey] === true ? true : undefined,
      );
      await waitFor('stale nested child evaluation', () =>
        globals[evaluatedKey] === 'stale-v2' ? true : undefined,
      );
      await delay(200);
      const afterStaleChild = await app.dump();
      assert.equal(statusText(afterStaleChild), 'current-v3');
      assert.equal(
        logs.length,
        logCountBeforeStaleRelease,
        'the stale nested child did not log another refresh',
      );

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'nested import server close',
      );
      server = undefined;
      await waitFor('nested import fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      staleGate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'nested import cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[gateKey];
      delete globals[startedKey];
      delete globals[releasedKey];
      delete globals[evaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'an unchanged cached loader keeps current ownership for later lazy imports',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleCachedLoaderApp_${unique}`;
    const loaderCountKey = `__natuiLifecycleCachedLoaderCount_${unique}`;
    const lazyV1EvaluatedKey = `__natuiLifecycleCachedLazyV1_${unique}`;
    const lazyV2EvaluatedKey = `__natuiLifecycleCachedLazyV2_${unique}`;
    const globals = globalThis as Record<string, unknown>;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const loaderPath = join(fixture, 'loader.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const appSource = (label: string) => `
import {
  Suspense,
  createElement,
  useState,
} from 'react';
import { LazyLeaf } from './loader.js';

export function App() {
  const [show, setShow] = useState(false);

  if (!show) {
    return createElement(
      'VStack',
      null,
      createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        ${JSON.stringify(label)} + '-hidden',
      ),
      createElement(
        'Button',
        {
          accessibilityIdentifier: 'lifecycle-reveal',
          onPress: () => setShow(true),
        },
        'reveal',
      ),
    );
  }

  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        'loading',
      ),
    },
    createElement(LazyLeaf),
  );
}
`;
    const loaderSource = `
import { lazy } from 'react';

const loaderGlobals = globalThis as Record<string, unknown>;
loaderGlobals[${JSON.stringify(loaderCountKey)}] =
  Number(loaderGlobals[${JSON.stringify(loaderCountKey)}] ?? 0) + 1;

export const LazyLeaf = lazy(() => import('./lazy.js'));
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, appSource('g1')),
        writeFile(loaderPath, loaderSource),
        writeFile(
          lazyPath,
          statefulLazySource('v1', lazyV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('cached loader app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-hidden');
      assert.equal(globals[loaderCountKey], 1);
      assert.equal(globals[lazyV1EvaluatedKey], undefined);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, appSource('g2'));
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      const hiddenG2Tree = await waitForTreeText(app, 'g2-hidden');
      assert.equal(
        globals[loaderCountKey],
        1,
        'the unchanged loader module was reused from the ESM cache in G2',
      );

      const reveal = identifiedNode(
        hiddenG2Tree,
        'Button',
        'lifecycle-reveal',
      );
      app.emit(reveal.id, 'press');
      await waitFor('cached loader lazy v1 evaluation', () =>
        globals[lazyV1EvaluatedKey] === 1 ? true : undefined,
      );
      const v1Tree = await waitForTreeText(app, 'v1:0');
      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const lazyRefreshLog = logs.length;
      await writeFile(
        lazyPath,
        statefulLazySource('v2', lazyV2EvaluatedKey),
      );
      await waitFor('cached loader lazy v2 evaluation', () =>
        globals[lazyV2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, lazyRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'cached loader server close',
      );
      server = undefined;
      await waitFor('cached loader fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'cached loader cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[loaderCountKey];
      delete globals[lazyV1EvaluatedKey];
      delete globals[lazyV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'an active generation owns a first lazy import from an unchanged cached loader',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleActiveCachedLoaderApp_${unique}`;
    const loaderCountKey = `__natuiLifecycleActiveCachedLoaderCount_${unique}`;
    const lazyV1EvaluatedKey = `__natuiLifecycleActiveCachedLazyV1_${unique}`;
    const lazyV2EvaluatedKey = `__natuiLifecycleActiveCachedLazyV2_${unique}`;
    const globals = globalThis as Record<string, unknown>;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const loaderPath = join(fixture, 'loader.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const hiddenAppSource = `
import { createElement } from 'react';
import { LazyLeaf } from './loader.js';

void LazyLeaf;

export function App() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    'g1-hidden',
  );
}
`;
    const visibleAppSource = `
import {
  Suspense,
  createElement,
} from 'react';
import { LazyLeaf } from './loader.js';

export function App() {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        'loading',
      ),
    },
    createElement(LazyLeaf),
  );
}
`;
    const loaderSource = `
import { lazy } from 'react';

const loaderGlobals = globalThis as Record<string, unknown>;
loaderGlobals[${JSON.stringify(loaderCountKey)}] =
  Number(loaderGlobals[${JSON.stringify(loaderCountKey)}] ?? 0) + 1;

export const LazyLeaf = lazy(() => import('./lazy.js'));
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, hiddenAppSource),
        writeFile(loaderPath, loaderSource),
        writeFile(
          lazyPath,
          statefulLazySource('v1', lazyV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('active cached loader app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-hidden');
      assert.equal(globals[loaderCountKey], 1);
      assert.equal(globals[lazyV1EvaluatedKey], undefined);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, visibleAppSource);
      await waitFor('active generation lazy v1 evaluation', () =>
        globals[lazyV1EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      const v1Tree = await waitForTreeText(app, 'v1:0');
      assert.equal(
        globals[loaderCountKey],
        1,
        'the unchanged loader module was reused during the active G2 render',
      );

      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const lazyRefreshLog = logs.length;
      await writeFile(
        lazyPath,
        statefulLazySource('v2', lazyV2EvaluatedKey),
      );
      await waitFor('active cached loader lazy v2 evaluation', () =>
        globals[lazyV2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, lazyRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'active cached loader server close',
      );
      server = undefined;
      await waitFor('active cached loader fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'active cached loader cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[loaderCountKey];
      delete globals[lazyV1EvaluatedKey];
      delete globals[lazyV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a failed generation preserves a lazy child reached through an older cached loader',
  { timeout: 40_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleOlderLoaderApp_${unique}`;
    const failureKey = `__natuiLifecycleOlderLoaderFailure_${unique}`;
    const loaderCountKey = `__natuiLifecycleOlderLoaderCount_${unique}`;
    const lazyV1EvaluatedKey = `__natuiLifecycleOlderLoaderLazyV1_${unique}`;
    const lazyV2EvaluatedKey = `__natuiLifecycleOlderLoaderLazyV2_${unique}`;
    const globals = globalThis as Record<string, unknown>;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const loaderPath = join(fixture, 'loader.ts');
    const lazyPath = join(fixture, 'lazy.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    const originalConsoleError = console.error;
    const expectedReactErrors: Error[] = [];
    let server: NatuiDevServer | undefined;

    const appSource = (label: string, forceLazy: boolean) => `
import {
  Suspense,
  createElement,
  useState,
} from 'react';
import { LazyLeaf } from './loader.js';

export function App() {
  const [show, setShow] = useState(false);

  if (${JSON.stringify(forceLazy)} || show) {
    return createElement(
      Suspense,
      {
        fallback: createElement(
          'Text',
          { accessibilityIdentifier: 'lifecycle-status' },
          'loading',
        ),
      },
      createElement(LazyLeaf),
    );
  }

  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + '-hidden',
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-reveal',
        onPress: () => setShow(true),
      },
      'reveal',
    ),
  );
}
`;
    const loaderSource = `
import { lazy } from 'react';

const loaderGlobals = globalThis as Record<string, unknown>;
loaderGlobals[${JSON.stringify(loaderCountKey)}] =
  Number(loaderGlobals[${JSON.stringify(loaderCountKey)}] ?? 0) + 1;

export const LazyLeaf = lazy(() => import('./lazy.js'));
`;
    const lazySource = (label: string, evaluatedKey: string) => `
import { createElement, useState } from 'react';

const lazyGlobals = globalThis as Record<string, unknown>;
lazyGlobals[${JSON.stringify(evaluatedKey)}] =
  Number(lazyGlobals[${JSON.stringify(evaluatedKey)}] ?? 0) + 1;

export default function LazyLeaf() {
  const [count, setCount] = useState(0);
  if (lazyGlobals[${JSON.stringify(failureKey)}]) {
    throw new Error('older cached loader child exploded');
  }
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;

    try {
      console.error = (...args: unknown[]) => {
        const error = args.find(
          (value): value is Error => value instanceof Error,
        );
        if (error?.message === 'older cached loader child exploded') {
          expectedReactErrors.push(error);
          return;
        }
        originalConsoleError(...args);
      };

      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, appSource('g1', false)),
        writeFile(loaderPath, loaderSource),
        writeFile(
          lazyPath,
          lazySource('v1', lazyV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('older cached loader app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-hidden');
      assert.equal(globals[loaderCountKey], 1);
      assert.equal(globals[lazyV1EvaluatedKey], undefined);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, appSource('g2', false));
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitForTreeText(app, 'g2-hidden');
      assert.equal(
        globals[loaderCountKey],
        1,
        'G2 reused the loader that still carried its G1 owner',
      );

      globals[failureKey] = true;
      const failedGenerationLog = logs.length;
      await writeFile(appPath, appSource('g3', true));
      await waitFor('failed generation lazy v1 evaluation', () =>
        globals[lazyV1EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(
        logs,
        failedGenerationLog,
        /refresh failed; recovered the previous code with a remount/,
      );
      const rolledBackTree = await waitForTreeText(app, 'g2-hidden');
      assert.ok(
        expectedReactErrors.some(
          (error) => error.message === 'older cached loader child exploded',
        ),
      );

      delete globals[failureKey];
      const reveal = identifiedNode(
        rolledBackTree,
        'Button',
        'lifecycle-reveal',
      );
      app.emit(reveal.id, 'press');
      const v1Tree = await waitForTreeText(app, 'v1:0');
      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const lazyRefreshLog = logs.length;
      await writeFile(
        lazyPath,
        lazySource('v2', lazyV2EvaluatedKey),
      );
      await waitFor('older cached loader lazy v2 evaluation', () =>
        globals[lazyV2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, lazyRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'older cached loader server close',
      );
      server = undefined;
      await waitFor('older cached loader fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      console.error = originalConsoleError;
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'older cached loader cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[failureKey];
      delete globals[loaderCountKey];
      delete globals[lazyV1EvaluatedKey];
      delete globals[lazyV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a delayed child preamble adopts the live generation of its unchanged dynamic parent',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleDelayedChildApp_${unique}`;
    const loaderCountKey = `__natuiLifecycleDelayedChildLoaderCount_${unique}`;
    const gateKey = `__natuiLifecycleDelayedChildGate_${unique}`;
    const gateStartedKey = `__natuiLifecycleDelayedChildStarted_${unique}`;
    const gateReleasedKey = `__natuiLifecycleDelayedChildReleased_${unique}`;
    const childV1EvaluatedKey = `__natuiLifecycleDelayedChildV1_${unique}`;
    const childV2EvaluatedKey = `__natuiLifecycleDelayedChildV2_${unique}`;
    const gate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[gateKey] = gate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const loaderPath = join(fixture, 'loader.ts');
    const gatePath = join(fixture, 'gate.ts');
    const childPath = join(fixture, 'child.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const appSource = (label: string) => `
import {
  Suspense,
  createElement,
} from 'react';
import { LazyChild } from './loader.js';

export function App() {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        ${JSON.stringify(label)} + '-loading',
      ),
    },
    createElement(LazyChild),
  );
}
`;
    const loaderSource = `
import { lazy } from 'react';

const loaderGlobals = globalThis as Record<string, unknown>;
loaderGlobals[${JSON.stringify(loaderCountKey)}] =
  Number(loaderGlobals[${JSON.stringify(loaderCountKey)}] ?? 0) + 1;

export const LazyChild = lazy(() => import('./child.js'));
`;
    const gateSource = `
const gateGlobals = globalThis as Record<string, unknown>;
gateGlobals[${JSON.stringify(gateStartedKey)}] = true;
const delayedChildGate = gateGlobals[${JSON.stringify(gateKey)}];
if (!(delayedChildGate instanceof Promise)) {
  throw new Error('delayed child gate is missing');
}
await delayedChildGate;
gateGlobals[${JSON.stringify(gateReleasedKey)}] = true;
`;
    const childSource = (label: string, evaluatedKey: string) => `
import './gate.js';
import { createElement, useState } from 'react';

const childGlobals = globalThis as Record<string, unknown>;
childGlobals[${JSON.stringify(evaluatedKey)}] =
  Number(childGlobals[${JSON.stringify(evaluatedKey)}] ?? 0) + 1;

export default function DelayedChild() {
  const [count, setCount] = useState(0);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, appSource('g1')),
        writeFile(loaderPath, loaderSource),
        writeFile(gatePath, gateSource),
        writeFile(
          childPath,
          childSource('v1', childV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('delayed child app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-loading');
      await waitFor('delayed child static gate to start', () =>
        globals[gateStartedKey] === true ? true : undefined,
      );
      assert.equal(globals[loaderCountKey], 1);
      assert.equal(globals[childV1EvaluatedKey], undefined);
      assert.equal(gate.resolved, false);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, appSource('g2'));
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitForTreeText(app, 'g2-loading');
      assert.equal(
        globals[loaderCountKey],
        1,
        'G2 reused the dynamic parent while its G1 child import was pending',
      );
      assert.equal(globals[childV1EvaluatedKey], undefined);

      gate.resolve();
      await waitFor('delayed child static gate release', () =>
        globals[gateReleasedKey] === true ? true : undefined,
      );
      await waitFor('delayed child v1 preamble and body', () =>
        globals[childV1EvaluatedKey] === 1 ? true : undefined,
      );
      const v1Tree = await waitForTreeText(app, 'v1:0');
      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const childRefreshLog = logs.length;
      await writeFile(
        childPath,
        childSource('v2', childV2EvaluatedKey),
      );
      await waitFor('delayed child v2 evaluation', () =>
        globals[childV2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, childRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'delayed child server close',
      );
      server = undefined;
      await waitFor('delayed child fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      gate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'delayed child cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[loaderCountKey];
      delete globals[gateKey];
      delete globals[gateStartedKey];
      delete globals[gateReleasedKey];
      delete globals[childV1EvaluatedKey];
      delete globals[childV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a delayed child preamble stays pinned when only its child artifact remains current',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecyclePinnedChildApp_${unique}`;
    const gateKey = `__natuiLifecyclePinnedChildGate_${unique}`;
    const gateStartedKey = `__natuiLifecyclePinnedChildStarted_${unique}`;
    const gateReleasedKey = `__natuiLifecyclePinnedChildReleased_${unique}`;
    const replacementLoaderKey =
      `__natuiLifecyclePinnedReplacementLoader_${unique}`;
    const childV1EvaluatedKey = `__natuiLifecyclePinnedChildV1_${unique}`;
    const childV2EvaluatedKey = `__natuiLifecyclePinnedChildV2_${unique}`;
    const gate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[gateKey] = gate.promise;

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const originalLoaderPath = join(fixture, 'loader.ts');
    const replacementLoaderPath = join(fixture, 'replacement-loader.ts');
    const gatePath = join(fixture, 'gate.ts');
    const childPath = join(fixture, 'child.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const pendingAppSource = `
import {
  Suspense,
  createElement,
} from 'react';
import { LazyChild } from './loader.js';

export function App() {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        'g1-loading',
      ),
    },
    createElement(LazyChild),
  );
}
`;
    const currentAppSource = `
import { createElement, useState } from 'react';
import { ReplacementLazyChild } from './replacement-loader.js';

void ReplacementLazyChild;

export function App() {
  const [count, setCount] = useState(0);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      'current:' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;
    const originalLoaderSource = `
import { lazy } from 'react';

export const LazyChild = lazy(() => import('./child.js'));
`;
    const replacementLoaderSource = `
import { lazy } from 'react';

globalThis[${JSON.stringify(replacementLoaderKey)}] = true;

export const ReplacementLazyChild = lazy(() => import('./child.js'));
`;
    const gateSource = `
const gateGlobals = globalThis as Record<string, unknown>;
gateGlobals[${JSON.stringify(gateStartedKey)}] = true;
const pinnedChildGate = gateGlobals[${JSON.stringify(gateKey)}];
if (!(pinnedChildGate instanceof Promise)) {
  throw new Error('pinned child gate is missing');
}
await pinnedChildGate;
gateGlobals[${JSON.stringify(gateReleasedKey)}] = true;
`;
    const childSource = (label: string, evaluatedKey: string) => `
import './gate.js';
import { createElement } from 'react';

const childGlobals = globalThis as Record<string, unknown>;
childGlobals[${JSON.stringify(evaluatedKey)}] =
  Number(childGlobals[${JSON.stringify(evaluatedKey)}] ?? 0) + 1;

export default function PinnedChild() {
  return createElement(
    'Text',
    { accessibilityIdentifier: 'lifecycle-status' },
    ${JSON.stringify(label)},
  );
}
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, pendingAppSource),
        writeFile(originalLoaderPath, originalLoaderSource),
        writeFile(replacementLoaderPath, replacementLoaderSource),
        writeFile(gatePath, gateSource),
        writeFile(
          childPath,
          childSource('stale-v1', childV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('pinned child app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-loading');
      await waitFor('pinned child static gate to start', () =>
        globals[gateStartedKey] === true ? true : undefined,
      );
      assert.equal(globals[childV1EvaluatedKey], undefined);
      assert.equal(globals[replacementLoaderKey], undefined);

      await delay(200);
      const currentGenerationLog = logs.length;
      await writeFile(appPath, currentAppSource);
      await waitForLog(
        logs,
        currentGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      await waitFor('replacement loader evaluation', () =>
        globals[replacementLoaderKey] === true ? true : undefined,
      );
      const currentTree = await waitForTreeText(app, 'current:0');
      const increment = identifiedNode(
        currentTree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedCurrentTree = await waitForTreeText(app, 'current:1');
      const preservedIds = nativeIds(countedCurrentTree);
      assert.equal(gate.resolved, false);

      gate.resolve();
      await waitFor('pinned child static gate release', () =>
        globals[gateReleasedKey] === true ? true : undefined,
      );
      await waitFor('stale pinned child v1 body', () =>
        globals[childV1EvaluatedKey] === 1 ? true : undefined,
      );
      await delay(200);
      const afterStaleChild = await app.dump();
      assert.equal(statusText(afterStaleChild), 'current:1');
      assert.deepEqual(nativeIds(afterStaleChild), preservedIds);

      await delay(200);
      const childEditLog = logs.length;
      await writeFile(
        childPath,
        childSource('must-not-evaluate-v2', childV2EvaluatedKey),
      );
      await waitForLog(logs, childEditLog, /\[natui\] refreshed #2 /);
      assert.equal(
        globals[childV2EvaluatedKey],
        undefined,
        'the stale child lineage was not promoted by child artifact membership',
      );
      const afterChildEdit = await waitForTreeText(app, 'current:1');
      assert.deepEqual(nativeIds(afterChildEdit), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'pinned child server close',
      );
      server = undefined;
      await waitFor('pinned child fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      gate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'pinned child cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[gateKey];
      delete globals[gateStartedKey];
      delete globals[gateReleasedKey];
      delete globals[replacementLoaderKey];
      delete globals[childV1EvaluatedKey];
      delete globals[childV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'a delayed child preamble released during the next render follows the committing generation',
  { timeout: 35_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-lifecycle-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const appKey = `__natuiLifecycleActiveWindowApp_${unique}`;
    const releaseKey = `__natuiLifecycleActiveWindowRelease_${unique}`;
    const loaderCountKey = `__natuiLifecycleActiveWindowLoaderCount_${unique}`;
    const gateKey = `__natuiLifecycleActiveWindowGate_${unique}`;
    const gateStartedKey = `__natuiLifecycleActiveWindowStarted_${unique}`;
    const gateReleasedKey = `__natuiLifecycleActiveWindowReleased_${unique}`;
    const childV1EvaluatedKey = `__natuiLifecycleActiveWindowChildV1_${unique}`;
    const childV2EvaluatedKey = `__natuiLifecycleActiveWindowChildV2_${unique}`;
    const gate = deferred();
    const globals = globalThis as Record<string, unknown>;
    globals[gateKey] = gate.promise;
    globals[releaseKey] = () => gate.resolve();

    const logs: string[] = [];
    const mainPath = join(fixture, 'main.ts');
    const appPath = join(fixture, 'app.ts');
    const loaderPath = join(fixture, 'loader.ts');
    const gatePath = join(fixture, 'gate.ts');
    const childPath = join(fixture, 'child.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    const quitMarkerPath = join(fixture, 'host-quit');
    let server: NatuiDevServer | undefined;

    const appSource = (label: string, releaseDuringEffect: boolean) => `
import {
  Suspense,
  createElement,
  useEffect,
} from 'react';
import { LazyChild } from './loader.js';

export function App() {
  useEffect(() => {
    if (!${JSON.stringify(releaseDuringEffect)}) return;
    const release = globalThis[${JSON.stringify(releaseKey)}];
    if (typeof release !== 'function') {
      throw new Error('active-window child release is missing');
    }
    release();
  }, [${JSON.stringify(releaseDuringEffect)}]);

  return createElement(
    Suspense,
    {
      fallback: createElement(
        'Text',
        { accessibilityIdentifier: 'lifecycle-status' },
        ${JSON.stringify(label)} + '-loading',
      ),
    },
    createElement(LazyChild),
  );
}
`;
    const loaderSource = `
import { lazy } from 'react';

const loaderGlobals = globalThis as Record<string, unknown>;
loaderGlobals[${JSON.stringify(loaderCountKey)}] =
  Number(loaderGlobals[${JSON.stringify(loaderCountKey)}] ?? 0) + 1;

export const LazyChild = lazy(() => import('./child.js'));
`;
    const gateSource = `
const gateGlobals = globalThis as Record<string, unknown>;
gateGlobals[${JSON.stringify(gateStartedKey)}] = true;
const activeWindowGate = gateGlobals[${JSON.stringify(gateKey)}];
if (!(activeWindowGate instanceof Promise)) {
  throw new Error('active-window child gate is missing');
}
await activeWindowGate;
gateGlobals[${JSON.stringify(gateReleasedKey)}] = true;
`;
    const childSource = (label: string, evaluatedKey: string) => `
import './gate.js';
import { createElement, useState } from 'react';

const childGlobals = globalThis as Record<string, unknown>;
childGlobals[${JSON.stringify(evaluatedKey)}] =
  Number(childGlobals[${JSON.stringify(evaluatedKey)}] ?? 0) + 1;

export default function ActiveWindowChild() {
  const [count, setCount] = useState(0);
  return createElement(
    'VStack',
    null,
    createElement(
      'Text',
      { accessibilityIdentifier: 'lifecycle-status' },
      ${JSON.stringify(label)} + ':' + String(count),
    ),
    createElement(
      'Button',
      {
        accessibilityIdentifier: 'lifecycle-increment',
        onPress: () => setCount((value) => value + 1),
      },
      'increment',
    ),
  );
}
`;

    try {
      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(
          mainPath,
          mainSource(appKey, fakeHostPath, quitMarkerPath),
        ),
        writeFile(appPath, appSource('g1', false)),
        writeFile(loaderPath, loaderSource),
        writeFile(gatePath, gateSource),
        writeFile(
          childPath,
          childSource('v1', childV1EvaluatedKey),
        ),
      ]);

      server = await createDevServer({
        entry: mainPath,
        root: PACKAGE_ROOT,
        log(message) {
          logs.push(message);
        },
      });
      await waitForLog(logs, 0, /\[natui\] mounted /);

      const app = await waitFor('active-window child app handle', () =>
        globals[appKey] as NatuiApp | undefined,
      );
      await waitForTreeText(app, 'g1-loading');
      await waitFor('active-window child static gate to start', () =>
        globals[gateStartedKey] === true ? true : undefined,
      );
      assert.equal(globals[loaderCountKey], 1);
      assert.equal(globals[childV1EvaluatedKey], undefined);
      assert.equal(gate.resolved, false);

      await delay(200);
      const secondGenerationLog = logs.length;
      await writeFile(appPath, appSource('g2', true));
      await waitFor('G2 effect to release the child static gate', () =>
        gate.resolved ? true : undefined,
      );
      await waitFor('active-window child v1 preamble and body', () =>
        globals[childV1EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(
        logs,
        secondGenerationLog,
        /\[natui\] refreshed #1 /,
      );
      const v1Tree = await waitForTreeText(app, 'v1:0');
      assert.equal(
        globals[loaderCountKey],
        1,
        'G2 reused the dynamic parent while releasing its pending child',
      );
      const increment = identifiedNode(
        v1Tree,
        'Button',
        'lifecycle-increment',
      );
      app.emit(increment.id, 'press');
      const countedV1Tree = await waitForTreeText(app, 'v1:1');
      const preservedIds = nativeIds(countedV1Tree);

      await delay(200);
      const childRefreshLog = logs.length;
      await writeFile(
        childPath,
        childSource('v2', childV2EvaluatedKey),
      );
      await waitFor('active-window child v2 evaluation', () =>
        globals[childV2EvaluatedKey] === 1 ? true : undefined,
      );
      await waitForLog(logs, childRefreshLog, /\[natui\] refreshed #2 /);
      const v2Tree = await waitForTreeText(app, 'v2:1');
      assert.deepEqual(nativeIds(v2Tree), preservedIds);

      await settleWithin(
        server.close(),
        CLOSE_TIMEOUT_MS,
        'active-window child server close',
      );
      server = undefined;
      await waitFor('active-window child fake host to process quit', async () =>
        (await pathExists(quitMarkerPath)) ? true : undefined,
      );
    } finally {
      gate.resolve();
      if (server) {
        await settleWithin(
          server.close(),
          WAIT_TIMEOUT_MS,
          'active-window child cleanup',
        ).catch(() => undefined);
      }
      delete globals[appKey];
      delete globals[releaseKey];
      delete globals[loaderCountKey];
      delete globals[gateKey];
      delete globals[gateStartedKey];
      delete globals[gateReleasedKey];
      delete globals[childV1EvaluatedKey];
      delete globals[childV2EvaluatedKey];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
