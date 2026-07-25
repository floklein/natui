import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { transform } from 'esbuild';
import { instrumentForRefresh } from '../src/dev/transform.js';

test('development transform adds stable component registrations and hook signatures', async () => {
  const root = resolve('refresh-transform-fixture');
  const filename = join(root, 'src', 'Counter.tsx');
  const source = `
    import { useState } from 'react';
    export function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>{count}</button>;
    }
  `;

  const instrumented = await instrumentForRefresh(
    source,
    filename,
    root,
    'test-session',
  );

  assert.match(instrumented.contents, /test-session:\.\/src\/Counter\.tsx /);
  assert.match(instrumented.contents, /__natuiRefreshSig\(\)/);
  assert.match(instrumented.contents, /__natuiRefreshReg\(/);

  const compiled = await transform(instrumented.contents, {
    format: 'esm',
    jsx: 'automatic',
    loader: instrumented.loader,
    target: 'node22',
  });
  assert.match(compiled.code, /jsx/);
});

test('development transform binds dynamic imports to their declaring module', async () => {
  const root = resolve('refresh-transform-fixture');
  const filename = join(root, 'src', 'lazy.ts');
  const source = `
    const _natuiImport = 'user binding';
    export function loadLazy() {
      return import('./Lazy.js');
    }
  `;

  const instrumented = await instrumentForRefresh(
    source,
    filename,
    root,
    'test-session',
  );

  const helperDeclaration = instrumented.contents.match(
    /const (\w+) = __natuiModuleRuntime\.importModule/,
  );
  assert.ok(helperDeclaration);
  const helperName = helperDeclaration[1];
  assert.notEqual(helperName, '_natuiImport');
  assert.match(
    instrumented.contents,
    new RegExp(
      `${helperName}\\(\\(\\) => import\\(['"]\\.\\/Lazy\\.js['"]\\)\\)`,
    ),
  );
});

test('development transform preserves contextual and nested import expressions', async () => {
  const root = resolve('refresh-transform-fixture');
  const filename = join(root, 'src', 'imports.ts');
  const source = `
    export async function loadAwait(pick: () => Promise<string>) {
      return import(await pick());
    }

    export function* loadYield(pick: () => string) {
      return import(yield pick());
    }

    export async function loadOptions(pick: () => Promise<object>) {
      return import('./data.json', await pick());
    }

    export function loadNested() {
      return import(import('./specifier.js'));
    }
  `;

  const instrumented = await instrumentForRefresh(
    source,
    filename,
    root,
    'test-session',
  );
  const helperDeclaration = instrumented.contents.match(
    /const (\w+) = __natuiModuleRuntime\.importModule/,
  );
  assert.ok(helperDeclaration);
  assert.equal(
    instrumented.contents.match(
      new RegExp(`${helperDeclaration[1]}\\(`, 'g'),
    )?.length,
    5,
  );

  await transform(instrumented.contents, {
    format: 'esm',
    loader: instrumented.loader,
    target: 'node22',
  });
});
