import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDevServer,
  type NatuiDevServer,
} from '../src/dev/server.js';
import type { TreeNode } from '../src/protocol.js';
import type { NatuiApp } from '../src/run.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAKE_HOST_ENV = 'NATUI_DEV_INTEGRATION_FAKE_HOST';
const WAIT_TIMEOUT_MS = 15_000;

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
  unvisitedEvaluations: string;
}

function entrySource(keys: FixtureKeys): string {
  return `
import { createElement } from 'react';
import { run } from 'natui';
import { App } from './app.js';
import { moduleIdentity } from './store.js';

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
      ${JSON.stringify(label)} + ':' + String(count),
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

test(
  'createDevServer preserves store identity and component state across leaf refreshes',
  { timeout: 60_000 },
  async () => {
    const fixture = await mkdtemp(
      join(PACKAGE_ROOT, 'natui-dev-integration-'),
    );
    const unique = `${process.pid}-${Date.now()}`;
    const keys: FixtureKeys = {
      app: `__natuiDevIntegrationApp_${unique}`,
      leafEvaluations: `__natuiDevIntegrationLeafEvaluations_${unique}`,
      moduleIdentity: `__natuiDevIntegrationModule_${unique}`,
      showUnvisited: `__natuiDevIntegrationShowUnvisited_${unique}`,
      storeIdentity: `__natuiDevIntegrationStore_${unique}`,
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
    const leafPath = join(fixture, 'leaf.ts');
    const unvisitedPath = join(fixture, 'unvisited.ts');
    const fakeHostPath = join(fixture, 'fake-host.cjs');
    let server: NatuiDevServer | undefined;

    try {
      console.error = (...args: unknown[]) => {
        const error = args.find((value): value is Error => value instanceof Error);
        if (error?.message.startsWith('leaf ')) {
          expectedReactErrors.push(error);
          return;
        }
        originalConsoleError(...args);
      };

      await Promise.all([
        writeFile(fakeHostPath, FAKE_HOST_SOURCE),
        writeFile(entryPath, entrySource(keys)),
        writeFile(join(fixture, 'app.ts'), appSource(keys)),
        writeFile(join(fixture, 'store.ts'), storeSource(keys.storeIdentity)),
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

      const unvisitedRefreshLog = logs.length;
      await writeFile(
        unvisitedPath,
        unvisitedSource(keys.unvisitedEvaluations, 'unvisited-v2'),
      );
      await waitForLog(logs, unvisitedRefreshLog, /\[natui\] refreshed #5 /);
      const afterUnvisitedEdit = await waitForTreeText(app, 'recovered:4');
      assert.deepEqual(
        nativeIds(afterUnvisitedEdit),
        idsAfterDeepFollowupRecovery,
      );
      assert.strictEqual(
        globals[keys.unvisitedEvaluations],
        undefined,
        'editing an unloaded lazy module did not execute it eagerly',
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
      delete globals[keys.unvisitedEvaluations];
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
