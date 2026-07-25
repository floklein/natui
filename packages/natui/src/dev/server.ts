import { nodeResolve } from '@rollup/plugin-node-resolve';
import { transform } from 'esbuild';
import { rmdirSync, rmSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  watch,
  type OutputBundle,
  type OutputOptions,
  type Plugin,
  type PreRenderedChunk,
  type RollupError,
  type RollupWatcher,
  type RollupWatcherEvent,
} from 'rollup';
import {
  beginRefreshTransaction,
  installRefreshRuntime,
  recoverRefreshRuntime,
  refreshRuntime,
} from './refresh.js';
import {
  registerDevRuntimeSession,
  unregisterDevRuntimeSession,
} from './runtime.js';
import {
  EMITTED_MODULE_URL_PLACEHOLDER,
  loadAndInstrumentForRefresh,
} from './transform.js';

export interface DevServerOptions {
  /** Executable application entry. Defaults to src/main.tsx. */
  entry?: string;
  /** Project root used for resolution and watching. Defaults to process.cwd(). */
  root?: string;
  /** Receives concise status output. Defaults to console.error. */
  log?: (message: string) => void;
}

export interface NatuiDevServer {
  /** Absolute entry file being watched. */
  readonly entry: string;
  /** Stop watching, unmount the app, and terminate the native host. */
  close(): Promise<void>;
}

const CODE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function sessionId(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isBareSpecifier(source: string): boolean {
  return (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    !source.startsWith('file:') &&
    !isAbsolute(source) &&
    !source.startsWith('\0')
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sourceCandidates(path: string): string[] {
  const extension = extname(path).toLowerCase();
  const candidates: string[] = [];

  if (extension === '.js') candidates.push(path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx', path);
  else if (extension === '.jsx') candidates.push(path.slice(0, -4) + '.tsx', path);
  else if (extension === '.mjs') candidates.push(path.slice(0, -4) + '.mts', path);
  else if (!extension) {
    candidates.push(path);
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.json']) {
      candidates.push(path + suffix);
    }
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']) {
      candidates.push(join(path, `index${suffix}`));
    }
  } else candidates.push(path);

  return [...new Set(candidates)];
}

async function resolveSourceFile(source: string, importer: string | undefined): Promise<string | null> {
  let path: string;
  if (source.startsWith('file:')) path = fileURLToPath(source);
  else if (isAbsolute(source)) path = source;
  else {
    if (!importer || !source.startsWith('.')) return null;
    path = resolve(dirname(importer), source);
  }

  for (const candidate of sourceCandidates(path)) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function findWorkspaceRoot(root: string): Promise<string> {
  let candidate = root;
  for (;;) {
    try {
      await access(join(candidate, 'pnpm-workspace.yaml'));
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return root;
      candidate = parent;
    }
  }
}

function formatRollupError(error: RollupError): string {
  const location = error.loc
    ? `${error.loc.file ?? error.id ?? 'unknown'}:${error.loc.line}:${error.loc.column}`
    : error.id;
  const label = location ? `${location} ` : '';
  return `${label}${error.message}${error.frame ? `\n${error.frame}` : ''}`;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function findEntryFile(bundle: OutputBundle, entry: string): string | undefined {
  for (const output of Object.values(bundle)) {
    if (
      output.type === 'chunk' &&
      output.isEntry &&
      resolve(output.facadeModuleId ?? '') === entry
    ) {
      return output.fileName;
    }
  }
  return undefined;
}

interface GenerationBundle {
  artifactFiles: string[];
  entryFile: string;
  changedFiles: Array<{
    fileName: string;
    moduleId: string;
  }>;
}

function developmentPlugins(
  root: string,
  id: string,
  entry: string,
  packageIndexUrl: string,
  runtimeUrl: string,
  moduleRevisions: Map<string, number>,
  changedModuleIds: Set<string>,
  onGenerationBundle: (bundle: GenerationBundle) => void,
): Plugin[] {
  const virtualNatui = '\0natui-dev-entry';

  return [
    {
      name: 'natui-resolve',
      watchChange(moduleId) {
        moduleRevisions.set(moduleId, (moduleRevisions.get(moduleId) ?? 0) + 1);
        changedModuleIds.add(moduleId);
      },
      async resolveId(source, importer) {
        if (source === 'natui') return virtualNatui;
        if (source === packageIndexUrl || source === runtimeUrl) {
          return { id: source, external: true };
        }
        if (isBareSpecifier(source)) {
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          if (!resolved) this.error(`natui: cannot resolve package "${source}"`);
          if (resolved.external) return resolved;

          const resolvedPath = resolved.id;
          const isLocalWorkspaceSource =
            isAbsolute(resolvedPath) &&
            isInside(root, resolvedPath) &&
            !resolvedPath.split(sep).includes('node_modules');
          if (isLocalWorkspaceSource && !source.startsWith('natui/')) {
            return resolvedPath;
          }

          return {
            id: resolvedPath.startsWith('file:')
              ? resolvedPath
              : pathToFileURL(resolvedPath).href,
            external: true,
          };
        }

        const resolved = await resolveSourceFile(source, importer);
        if (!resolved) return null;
        if (CODE_EXTENSIONS.has(extname(resolved).toLowerCase()) || extname(resolved) === '.json') {
          return resolved;
        }
        return { id: pathToFileURL(resolved).href, external: true };
      },
      async load(moduleId) {
        if (moduleId === virtualNatui) {
          return [
            `export * from ${JSON.stringify(packageIndexUrl)};`,
            `import { runDevEntry as __natuiRunDevEntry } from ${JSON.stringify(runtimeUrl)};`,
            `export const run = (element, options) => __natuiRunDevEntry(${JSON.stringify(id)}, element, options);`,
          ].join('\n');
        }

        const extension = extname(moduleId).toLowerCase();
        if (extension === '.json') {
          this.addWatchFile(moduleId);
          return `export default ${await readFile(moduleId, 'utf8')};`;
        }
        if (!CODE_EXTENSIONS.has(extension)) return null;

        this.addWatchFile(moduleId);
        const instrumented = await loadAndInstrumentForRefresh(moduleId, root, id);
        const compiled = await transform(instrumented.contents, {
          define: {
            'import.meta.dirname': JSON.stringify(dirname(moduleId)),
            'import.meta.filename': JSON.stringify(moduleId),
            'import.meta.url': JSON.stringify(pathToFileURL(moduleId).href),
            'process.env.NODE_ENV': '"development"',
          },
          format: 'esm',
          jsx: 'automatic',
          jsxDev: true,
          loader: instrumented.loader,
          platform: 'node',
          sourcefile: moduleId,
          sourcemap: 'inline',
          target: 'node22',
        });
        const placeholder = JSON.stringify(EMITTED_MODULE_URL_PLACEHOLDER);
        if (!compiled.code.includes(placeholder)) {
          this.error(`natui: emitted module URL marker is missing from ${moduleId}`);
        }
        return {
          code: compiled.code.replace(placeholder, 'import.meta.url'),
          map: null,
        };
      },
    },
    nodeResolve({
      exportConditions: ['node', 'import', 'default'],
      extensions: ['.mjs', '.js', '.json', '.node', '.mts', '.ts', '.tsx', '.jsx'],
      preferBuiltins: true,
    }),
    {
      name: 'natui-entry-manifest',
      generateBundle(_options, bundle) {
        const fileName = findEntryFile(bundle, entry);
        if (!fileName) {
          this.error(`natui: development build produced no entry module for ${entry}`);
        }
        const changedFiles = Object.values(bundle).flatMap((output) => {
          if (
            output.type !== 'chunk' ||
            output.facadeModuleId === null ||
            !changedModuleIds.has(output.facadeModuleId)
          ) {
            return [];
          }
          return [{
            fileName: output.fileName,
            moduleId: output.facadeModuleId,
          }];
        });
        changedModuleIds.clear();
        const artifactFiles = Object.values(bundle).flatMap((output) =>
          output.type === 'chunk' ? [output.fileName] : [],
        );
        onGenerationBundle({ artifactFiles, entryFile: fileName, changedFiles });
      },
    },
  ];
}

export async function createDevServer(
  options: DevServerOptions = {},
): Promise<NatuiDevServer> {
  process.env.NODE_ENV = 'development';
  installRefreshRuntime();

  const root = resolve(options.root ?? process.cwd());
  const entry = isAbsolute(options.entry ?? '')
    ? resolve(options.entry!)
    : resolve(root, options.entry ?? 'src/main.tsx');
  const log = options.log ?? ((message: string) => console.error(message));
  await access(entry);

  const id = sessionId();
  const runtimeSession = registerDevRuntimeSession(id);
  const cacheBase = join(root, '.natui');
  await mkdir(cacheBase, { recursive: true });
  const cacheDir = await mkdtemp(join(cacheBase, 'dev-'));
  const workspaceRoot = await findWorkspaceRoot(root);
  const packageIndexUrl = new URL('../index.js', import.meta.url).href;
  const runtimeUrl = new URL('./runtime.js', import.meta.url).href;

  let watcher: RollupWatcher | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let nextGenerationBundle: GenerationBundle | undefined;
  let lastEntryFile: string | undefined;
  let evaluationQueue = Promise.resolve();
  let evaluationRunning = false;
  let pendingEvaluation: GenerationBundle | undefined;
  let cancelCurrentEvaluation: ((error: Error) => void) | undefined;
  let currentTransaction: ReturnType<typeof beginRefreshTransaction> | undefined;
  let committedTransaction: ReturnType<typeof beginRefreshTransaction> | undefined;
  let generation = 0;
  let refreshCount = 0;
  let mounted = false;
  const moduleRevisions = new Map<string, number>();
  const changedModuleIds = new Set<string>();
  let firstBuildSettled = false;
  let resolveFirstBuild!: () => void;
  const firstBuildHandled = new Promise<void>((resolveFirst) => {
    resolveFirstBuild = resolveFirst;
  });

  const settleFirstBuild = () => {
    if (firstBuildSettled) return;
    firstBuildSettled = true;
    resolveFirstBuild();
  };

  const removeCacheOnExit = () => {
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // Process exit is already in progress; do not change its status.
    }
    try {
      rmdirSync(cacheBase);
    } catch {
      // Another development session may still own a sibling directory.
    }
  };
  process.once('exit', removeCacheOnExit);

  const evaluateGeneration = async ({
    artifactFiles,
    entryFile,
    changedFiles,
  }: GenerationBundle) => {
    if (closed || entryFile === lastEntryFile) return;
    lastEntryFile = entryFile;
    generation += 1;
    const isInitialAttempt = !mounted;
    const startedAt = performance.now();
    const transaction = beginRefreshTransaction();
    currentTransaction = transaction;
    const generationToken = runtimeSession.beginGeneration(
      artifactFiles.map((fileName) =>
        pathToFileURL(join(cacheDir, fileName)).href,
      ),
      (work) => transaction.run(work),
    );
    let canceled = false;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (error: Error) => {
      if (canceled) return;
      canceled = true;
      runtimeSession.cancelPendingGeneration(generationToken, error);
      rejectCancellation(error);
    };
    cancelCurrentEvaluation = cancel;
    let refreshApplied = false;
    const previousCommittedTransaction = committedTransaction;
    let previousTransactionPaused = false;

    try {
      let outcome: 'mounted' | 'refreshed' | undefined;
      const evaluation = runtimeSession.runGeneration(
        generationToken,
        () => transaction.run(async () => {
          for (const changedFile of changedFiles) {
            if (
              changedFile.fileName === entryFile ||
              !runtimeSession.wasModuleEvaluated(changedFile.moduleId)
            ) {
              continue;
            }
            await import(pathToFileURL(join(cacheDir, changedFile.fileName)).href);
            runtimeSession.ensureGeneration(generationToken);
          }

          const url = pathToFileURL(join(cacheDir, entryFile));
          url.searchParams.set('generation', String(generation));
          await import(url.href);
          runtimeSession.ensureGeneration(generationToken);

          runtimeSession.validateGeneration(generationToken);
          refreshApplied = true;
          previousCommittedTransaction?.pause();
          previousTransactionPaused = previousCommittedTransaction !== undefined;
          transaction.apply();
          refreshRuntime.performReactRefresh();
          outcome = await runtimeSession.commitGeneration(
            generationToken,
            (work) => transaction.run(work),
          );
          transaction.commit();
          previousCommittedTransaction?.retire();
          previousTransactionPaused = false;
          committedTransaction = transaction;
        }),
      );
      // ESM evaluation itself is not abortable. Keep a canceled evaluation's
      // rejection observed while allowing the newest generation to proceed.
      void evaluation.catch(() => undefined);
      await Promise.race([evaluation, cancellation]);
      if (!outcome) {
        throw new Error('natui: development generation produced no render outcome');
      }

      mounted = true;
      const elapsed = Math.round(performance.now() - startedAt);
      if (outcome === 'mounted') {
        log(`[natui] mounted ${entry} in ${elapsed}ms`);
      } else {
        refreshCount += 1;
        log(`[natui] refreshed #${refreshCount} in ${elapsed}ms`);
      }
    } catch (error) {
      const superseded =
        error instanceof Error && error.name === 'NatuiDevSupersededGeneration';
      transaction.rollback();
      let recovered = false;
      try {
        if (mounted && refreshApplied && !superseded && !closed) {
          recoverRefreshRuntime();
        }
        const restore = () => runtimeSession.rollbackGeneration(generationToken);
        await (
          previousCommittedTransaction
            ? runtimeSession.runCommittedGeneration(
                () => previousCommittedTransaction.run(restore),
              )
            : restore()
        );
        recovered = mounted;
      } catch (restoreError) {
        log(
          `[natui] could not restore the previous UI\n${
            restoreError instanceof Error
              ? restoreError.stack ?? restoreError.message
              : String(restoreError)
          }`,
        );
      }

      if (previousTransactionPaused) {
        if (closed) previousCommittedTransaction?.retire();
        else previousCommittedTransaction?.resume();
        previousTransactionPaused = false;
      }

      if (!closed && !superseded) {
        const heading = isInitialAttempt
          ? '[natui] app failed to start'
          : recovered && !refreshApplied
            ? '[natui] refresh failed; keeping the previous UI'
            : recovered
              ? '[natui] refresh failed; recovered the previous code with a remount'
            : '[natui] refresh failed; the previous UI could not be restored';
        log(
          `${heading}\n${
            error instanceof Error ? error.stack ?? error.message : String(error)
          }`,
        );
      }
    } finally {
      if (currentTransaction === transaction) currentTransaction = undefined;
      if (cancelCurrentEvaluation === cancel) cancelCurrentEvaluation = undefined;
    }
  };

  const pumpEvaluations = () => {
    if (closed || evaluationRunning) return;
    evaluationRunning = true;
    evaluationQueue = (async () => {
      while (!closed && pendingEvaluation) {
        const bundle = pendingEvaluation;
        pendingEvaluation = undefined;
        await evaluateGeneration(bundle);
      }
    })()
      .catch((error) => {
        if (!closed) {
          log(
            `[natui] development evaluation failed\n${
              error instanceof Error ? error.stack ?? error.message : String(error)
            }`,
          );
        }
      })
      .finally(() => {
        evaluationRunning = false;
        if (!closed && pendingEvaluation) pumpEvaluations();
      });
  };

  const scheduleEvaluation = (bundle: GenerationBundle) => {
    pendingEvaluation = bundle;
    if (cancelCurrentEvaluation) {
      const superseded = new Error('natui: development generation superseded by a newer build');
      superseded.name = 'NatuiDevSupersededGeneration';
      cancelCurrentEvaluation(superseded);
    }
    pumpEvaluations();
  };

  const revisionedModuleName = (chunk: PreRenderedChunk) => {
    const revision = chunk.facadeModuleId
      ? (moduleRevisions.get(chunk.facadeModuleId) ?? 0)
      : 0;
    return `[name]-r${revision}-[hash].mjs`;
  };

  const output: OutputOptions = {
    assetFileNames: 'assets/[name]-[hash][extname]',
    chunkFileNames: revisionedModuleName,
    dir: cacheDir,
    entryFileNames: revisionedModuleName,
    format: 'esm',
    preserveModules: true,
    preserveModulesRoot: workspaceRoot,
    sourcemap: 'inline',
  };

  const onWatchEvent = (event: RollupWatcherEvent) => {
    if (event.code === 'BUNDLE_END') {
      const bundle = nextGenerationBundle;
      nextGenerationBundle = undefined;
      void event.result.close().catch(() => undefined);
      if (bundle) scheduleEvaluation(bundle);
      settleFirstBuild();
      return;
    }
    if (event.code === 'ERROR') {
      nextGenerationBundle = undefined;
      pendingEvaluation = undefined;
      if (cancelCurrentEvaluation) {
        const superseded = new Error(
          'natui: development generation superseded by a newer build error',
        );
        superseded.name = 'NatuiDevSupersededGeneration';
        cancelCurrentEvaluation(superseded);
      }
      log(formatRollupError(event.error));
      log(
        mounted
          ? '[natui] build failed; keeping the previous UI'
          : '[natui] build failed; fix the error to start the app',
      );
      settleFirstBuild();
    }
  };

  try {
    watcher = watch({
      external(source) {
        if (source === 'natui') return false;
        return NODE_BUILTINS.has(source);
      },
      input: entry,
      onwarn(warning) {
        log(`[natui] ${formatRollupError(warning)}`);
      },
      output,
      plugins: developmentPlugins(
        workspaceRoot,
        id,
        entry,
        packageIndexUrl,
        runtimeUrl,
        moduleRevisions,
        changedModuleIds,
        (bundle) => {
          nextGenerationBundle = bundle;
        },
      ),
      watch: {
        clearScreen: false,
      },
    });
    watcher.on('event', onWatchEvent);
    await firstBuildHandled;
  } catch (error) {
    closed = true;
    process.off('exit', removeCacheOnExit);
    pendingEvaluation = undefined;
    const canceled = new Error('natui: development server closed during startup');
    canceled.name = 'NatuiDevSupersededGeneration';
    cancelCurrentEvaluation?.(canceled);
    currentTransaction?.rollback();
    committedTransaction?.retire();
    runtimeSession.close();
    unregisterDevRuntimeSession(id);
    await watcher?.close().catch(() => undefined);
    await evaluationQueue.catch(() => undefined);
    await rm(cacheDir, { recursive: true, force: true });
    await rmdir(cacheBase).catch(() => undefined);
    throw error;
  }

  log(`[natui] dev server watching ${entry}`);

  return {
    entry,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      process.off('exit', removeCacheOnExit);
      pendingEvaluation = undefined;
      const canceled = new Error('natui: development server closed');
      canceled.name = 'NatuiDevSupersededGeneration';
      cancelCurrentEvaluation?.(canceled);
      currentTransaction?.rollback();
      committedTransaction?.retire();
      runtimeSession.close();
      unregisterDevRuntimeSession(id);

      closePromise = (async () => {
        let closeError: unknown;
        try {
          await watcher?.close();
          await evaluationQueue;
        } catch (error) {
          closeError = error;
        } finally {
          await rm(cacheDir, { recursive: true, force: true }).catch((error) => {
            closeError ??= error;
          });
          await rmdir(cacheBase).catch(() => undefined);
        }
        if (closeError) throw closeError;
      })();
      return closePromise;
    },
  };
}
