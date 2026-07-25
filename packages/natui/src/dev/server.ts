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
  writeFile,
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
  canonicalSourceUrl,
  resolveSourceSpecifier,
  SOURCE_RESOLUTION_OPTIONS,
} from './resolution.js';
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
const MISSING_SOURCE_RACE_WINDOW_MS = 2_000;

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

function absoluteModuleUrl(source: string): URL | undefined {
  if (isAbsolute(source)) return undefined;
  try {
    return new URL(source);
  } catch {
    return undefined;
  }
}

function localSourceSpecifierUrl(
  source: string,
  importer: string | undefined,
  entry: string,
): URL | undefined {
  const absoluteUrl = absoluteModuleUrl(source);
  if (absoluteUrl?.protocol === 'file:') return absoluteUrl;
  if (!source.startsWith('.')) return undefined;
  return new URL(
    source,
    importer?.startsWith('file:')
      ? importer
      : pathToFileURL(importer ?? entry),
  );
}

function physicalModulePath(moduleId: string): string {
  const url = absoluteModuleUrl(moduleId);
  return url?.protocol === 'file:' ? fileURLToPath(url) : moduleId;
}

function moduleSourceUrl(moduleId: string): URL {
  return absoluteModuleUrl(moduleId) ?? pathToFileURL(moduleId);
}

function filesystemIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function isEntryModuleIdentity(
  moduleId: string,
  entry: string,
): boolean {
  const moduleUrl = moduleSourceUrl(moduleId);
  return (
    !moduleUrl.search &&
    !moduleUrl.hash &&
    filesystemIdentity(physicalModulePath(moduleId)) ===
      filesystemIdentity(entry)
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

function sourceCandidatesForSpecifier(
  source: string,
  importer: string | undefined,
  entry: string,
): {
  candidates: string[];
  sourceUrl: URL | undefined;
} | null {
  const sourceUrl = localSourceSpecifierUrl(source, importer, entry);
  if (sourceUrl) {
    return {
      candidates: sourceCandidates(fileURLToPath(sourceUrl)),
      sourceUrl,
    };
  }
  if (!isAbsolute(source)) return null;
  return {
    candidates: sourceCandidates(source),
    sourceUrl: undefined,
  };
}

function resolvedLocalModuleId(
  path: string,
  sourceUrl: URL | undefined,
  main = false,
): string {
  const resolvedUrl = canonicalSourceUrl(pathToFileURL(path), main);
  if (!sourceUrl?.search && !sourceUrl?.hash) {
    return fileURLToPath(resolvedUrl);
  }
  resolvedUrl.search = sourceUrl.search;
  resolvedUrl.hash = sourceUrl.hash;
  return resolvedUrl.href;
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

function findEntryFile(bundle: OutputBundle): string | undefined {
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk' && output.isEntry) {
      return output.fileName;
    }
  }
  return undefined;
}

interface GenerationBundle {
  artifactFiles: string[];
  entryFile: string;
  moduleFiles: Map<string, string>;
  moduleRevisions: Map<string, ModuleRevision>;
  changedFiles: Array<{
    fileName: string;
    moduleId: string;
  }>;
}

interface ModuleRevision {
  revision: number;
  sourceVersion: number;
}

interface ActiveModuleRevisionBuild {
  attempt: number;
  committed: Map<string, ModuleRevision>;
  modules: Map<string, ModuleRevision>;
  sourceVersions: Map<string, number>;
}

function createModuleRevisionTracker() {
  let attempt = 0;
  let activeBuild: ActiveModuleRevisionBuild | undefined;
  let committedModules = new Map<string, ModuleRevision>();
  const sourceVersions = new Map<string, number>();

  const getActiveBuild = () => {
    if (!activeBuild) {
      throw new Error('natui: module revision requested outside a development build');
    }
    return activeBuild;
  };

  const moduleRevision = (moduleId: string): ModuleRevision => {
    const build = getActiveBuild();
    const existing = build.modules.get(moduleId);
    if (existing) return existing;

    const sourceVersion = build.sourceVersions.get(moduleId) ?? 0;
    const committed = build.committed.get(moduleId);
    const next = {
      revision:
        committed?.sourceVersion === sourceVersion
          ? committed.revision
          : build.attempt,
      sourceVersion,
    };
    build.modules.set(moduleId, next);
    return next;
  };

  return {
    beginBuild() {
      activeBuild = {
        attempt: ++attempt,
        committed: new Map(committedModules),
        modules: new Map(),
        sourceVersions: new Map(sourceVersions),
      };
    },
    commit(modules: Map<string, ModuleRevision>) {
      committedModules = new Map(modules);
    },
    markChanged(moduleId: string) {
      sourceVersions.set(moduleId, (sourceVersions.get(moduleId) ?? 0) + 1);
    },
    revisionFor(moduleId: string) {
      return moduleRevision(moduleId).revision;
    },
    snapshot(moduleIds: Iterable<string>) {
      return new Map(
        [...moduleIds].map((moduleId) => [
          moduleId,
          { ...moduleRevision(moduleId) },
        ]),
      );
    },
  };
}

type ModuleRevisionTracker = ReturnType<typeof createModuleRevisionTracker>;

function createMissingSourceMonitor(rebuildTriggerPath: string) {
  const candidateGroups = new Map<
    string,
    {
      available: boolean;
      candidates: string[];
      expiresAt: number;
    }
  >();
  let checking = false;
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let triggerVersion = 0;

  const groupKey = (candidates: readonly string[]) => candidates.join('\0');
  const stopIfIdle = () => {
    if (candidateGroups.size > 0 || !interval) return;
    clearInterval(interval);
    interval = undefined;
  };
  const check = async () => {
    if (checking || closed) return;
    checking = true;
    try {
      let shouldTrigger = false;
      for (const [key, group] of candidateGroups) {
        if (!group.available) {
          for (const candidate of group.candidates) {
            if (await isFile(candidate)) {
              group.available = true;
              break;
            }
          }
          if (!group.available && Date.now() >= group.expiresAt) {
            candidateGroups.delete(key);
            continue;
          }
        }
        shouldTrigger ||= group.available;
      }
      if (shouldTrigger) {
        await writeFile(rebuildTriggerPath, String(++triggerVersion));
      }
    } catch {
      // Rollup's own watcher remains the primary recovery path. Keep polling
      // so a transient trigger write failure does not strand a missing import.
    } finally {
      checking = false;
      stopIfIdle();
    }
  };
  const start = () => {
    if (interval || closed) return;
    interval = setInterval(() => void check(), 50);
    interval.unref();
  };

  return {
    close() {
      closed = true;
      candidateGroups.clear();
      if (interval) clearInterval(interval);
      interval = undefined;
    },
    resolved(candidates: readonly string[]) {
      candidateGroups.delete(groupKey(candidates));
      stopIfIdle();
    },
    track(candidates: readonly string[]) {
      const key = groupKey(candidates);
      if (!candidateGroups.has(key)) {
        candidateGroups.set(key, {
          available: false,
          candidates: [...candidates],
          expiresAt: Date.now() + MISSING_SOURCE_RACE_WINDOW_MS,
        });
      } else {
        const group = candidateGroups.get(key)!;
        if (!group.available) {
          group.expiresAt = Date.now() + MISSING_SOURCE_RACE_WINDOW_MS;
        }
      }
      start();
    },
    triggerObserved() {
      for (const [key, group] of candidateGroups) {
        if (group.available) candidateGroups.delete(key);
      }
      stopIfIdle();
    },
  };
}

type MissingSourceMonitor = ReturnType<typeof createMissingSourceMonitor>;

async function prepareDevServerResources(
  root: string,
  entry: string,
  id: string,
) {
  const cacheBase = join(root, '.natui');
  let cacheDir: string | undefined;
  let runtimeSession:
    | ReturnType<typeof registerDevRuntimeSession>
    | undefined;

  try {
    await mkdir(cacheBase, { recursive: true });
    cacheDir = await mkdtemp(join(cacheBase, 'dev-'));
    const rebuildTriggerPath = join(cacheDir, '.missing-source-rebuild');
    await writeFile(rebuildTriggerPath, '0');
    const workspaceRoot = await findWorkspaceRoot(root);
    runtimeSession = registerDevRuntimeSession(id, entry);
    return {
      cacheBase,
      cacheDir,
      rebuildTriggerPath,
      runtimeSession,
      workspaceRoot,
    };
  } catch (error) {
    if (runtimeSession) {
      try {
        runtimeSession.close();
      } catch {
        // Continue releasing the remaining resources.
      }
      unregisterDevRuntimeSession(id);
    }
    if (cacheDir) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await rmdir(cacheBase).catch(() => undefined);
    throw error;
  }
}

function developmentPlugins(
  root: string,
  id: string,
  entry: string,
  packageIndexUrl: string,
  runtimeUrl: string,
  moduleRevisionTracker: ModuleRevisionTracker,
  missingSourceMonitor: MissingSourceMonitor,
  rebuildTriggerPath: string,
  committedModuleFiles: Map<string, string>,
  onGenerationBundle: (bundle: GenerationBundle) => void,
): Plugin[] {
  const virtualNatui = '\0natui-dev-entry';
  const moduleIdsByPhysicalPath = new Map<string, Set<string>>();

  return [
    {
      name: 'natui-resolve',
      buildStart() {
        this.addWatchFile(rebuildTriggerPath);
        moduleRevisionTracker.beginBuild();
      },
      watchChange(moduleId) {
        const physicalPath = physicalModulePath(moduleId);
        const sourceModuleIds = moduleIdsByPhysicalPath.get(
          filesystemIdentity(physicalPath),
        );
        if (!sourceModuleIds) {
          moduleRevisionTracker.markChanged(moduleId);
          return;
        }
        for (const sourceModuleId of sourceModuleIds) {
          moduleRevisionTracker.markChanged(sourceModuleId);
        }
      },
      async resolveId(source, importer) {
        if (source === '@natui/core') return virtualNatui;
        if (source === packageIndexUrl || source === runtimeUrl) {
          return { id: source, external: true };
        }
        const absoluteUrl = absoluteModuleUrl(source);
        const importerIsEntry =
          importer === undefined ||
          isEntryModuleIdentity(importer, entry);
        const parentUrl = canonicalSourceUrl(
          moduleSourceUrl(importer ?? entry),
          importerIsEntry,
        );
        if (absoluteUrl && absoluteUrl.protocol !== 'file:') {
          return {
            id: resolveSourceSpecifier(
              source,
              parentUrl,
              importerIsEntry,
            ),
            external: true,
          };
        }
        if (isBareSpecifier(source)) {
          let resolvedUrl: string;
          try {
            resolvedUrl = resolveSourceSpecifier(
              source,
              parentUrl,
              importerIsEntry,
            );
          } catch (error) {
            this.error(
              error instanceof Error
                ? error
                : `natui: cannot resolve package "${source}": ${String(error)}`,
            );
          }
          const url = new URL(resolvedUrl);
          if (url.protocol !== 'file:') {
            return { id: resolvedUrl, external: true };
          }
          const resolvedPath = fileURLToPath(url);
          if (!(await isFile(resolvedPath))) {
            this.error(`natui: cannot resolve package "${source}"`);
          }
          const isLocalWorkspaceSource =
            isAbsolute(resolvedPath) &&
            isInside(root, resolvedPath) &&
            !resolvedPath.split(sep).includes('node_modules');
          if (isLocalWorkspaceSource && !source.startsWith('@natui/core/')) {
            const extension = extname(resolvedPath).toLowerCase();
            if (
              CODE_EXTENSIONS.has(extension) ||
              extension === '.json'
            ) {
              return url.search || url.hash
                ? resolvedUrl
                : resolvedPath;
            }
          }

          return {
            id: resolvedUrl,
            external: true,
          };
        }

        const sourceCandidateGroup = sourceCandidatesForSpecifier(
          source,
          importer,
          entry,
        );
        if (!sourceCandidateGroup) return null;
        const { candidates, sourceUrl } = sourceCandidateGroup;
        let resolved: string | undefined;
        for (const candidate of candidates) {
          if (await isFile(candidate)) {
            resolved = candidate;
            break;
          }
        }
        if (!resolved) {
          missingSourceMonitor.track(candidates);
          const watchedPaths = new Set<string>();
          for (const candidate of candidates) {
            watchedPaths.add(candidate);
            let parent = dirname(candidate);
            for (;;) {
              try {
                await access(parent);
                break;
              } catch {
                watchedPaths.add(parent);
                const nextParent = dirname(parent);
                if (nextParent === parent) break;
                parent = nextParent;
              }
            }
          }
          for (const watchedPath of watchedPaths) {
            this.addWatchFile(watchedPath);
          }
          return null;
        }
        missingSourceMonitor.resolved(candidates);
        const extension = extname(resolved).toLowerCase();
        if (CODE_EXTENSIONS.has(extension) || extension === '.json') {
          return resolvedLocalModuleId(
            resolved,
            sourceUrl,
            importer === undefined,
          );
        }
        const resolvedId = resolvedLocalModuleId(
          resolved,
          sourceUrl,
          importer === undefined,
        );
        return {
          id: resolvedId.startsWith('file:')
            ? resolvedId
            : pathToFileURL(resolved).href,
          external: true,
        };
      },
      async load(moduleId) {
        if (moduleId === virtualNatui) {
          return [
            `export * from ${JSON.stringify(packageIndexUrl)};`,
            `import { runDevEntry as __natuiRunDevEntry } from ${JSON.stringify(runtimeUrl)};`,
            `export const run = (element, options) => __natuiRunDevEntry(${JSON.stringify(id)}, element, options);`,
          ].join('\n');
        }

        const physicalPath = physicalModulePath(moduleId);
        const physicalIdentity = filesystemIdentity(physicalPath);
        const sourceModuleIds =
          moduleIdsByPhysicalPath.get(physicalIdentity) ?? new Set<string>();
        sourceModuleIds.add(moduleId);
        moduleIdsByPhysicalPath.set(physicalIdentity, sourceModuleIds);

        const extension = extname(physicalPath).toLowerCase();
        if (extension === '.json') {
          this.addWatchFile(physicalPath);
          const rawContents = await readFile(physicalPath, 'utf8');
          const contents =
            rawContents.charCodeAt(0) === 0xfeff
              ? rawContents.slice(1)
              : rawContents;
          try {
            JSON.parse(contents);
          } catch (error) {
            this.error(
              `natui: invalid JSON in ${physicalPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          return `export default JSON.parse(${JSON.stringify(contents)});`;
        }
        if (!CODE_EXTENSIONS.has(extension)) return null;

        this.addWatchFile(physicalPath);
        const instrumented = await loadAndInstrumentForRefresh(
          physicalPath,
          root,
          id,
          moduleId,
        );
        const compiled = await transform(instrumented.contents, {
          define: {
            'process.env.NODE_ENV': '"development"',
          },
          format: 'esm',
          jsx: 'automatic',
          jsxDev: true,
          loader: instrumented.loader,
          platform: 'node',
          sourcefile: physicalPath,
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
    {
      name: 'natui-entry-manifest',
      generateBundle(_options, bundle) {
        const fileName = findEntryFile(bundle);
        if (!fileName) {
          this.error(`natui: development build produced no entry module for ${entry}`);
        }
        const moduleFiles = new Map<string, string>();
        const changedFiles = Object.values(bundle).flatMap((output) => {
          if (
            output.type !== 'chunk' ||
            output.facadeModuleId === null
          ) {
            return [];
          }
          moduleFiles.set(output.facadeModuleId, output.fileName);
          if (committedModuleFiles.get(output.facadeModuleId) === output.fileName) {
            return [];
          }
          return [{
            fileName: output.fileName,
            moduleId: output.facadeModuleId,
          }];
        });
        const artifactFiles = Object.values(bundle).flatMap((output) =>
          output.type === 'chunk' ? [output.fileName] : [],
        );
        onGenerationBundle({
          artifactFiles,
          entryFile: fileName,
          moduleFiles,
          moduleRevisions: moduleRevisionTracker.snapshot(moduleFiles.keys()),
          changedFiles,
        });
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
  const requestedEntry = isAbsolute(options.entry ?? '')
    ? resolve(options.entry!)
    : resolve(root, options.entry ?? 'src/main.tsx');
  const log = options.log ?? ((message: string) => console.error(message));
  await access(requestedEntry);
  const entry = fileURLToPath(
    canonicalSourceUrl(pathToFileURL(requestedEntry), true),
  );

  const id = sessionId();
  const {
    cacheBase,
    cacheDir,
    rebuildTriggerPath,
    runtimeSession,
    workspaceRoot,
  } = await prepareDevServerResources(root, entry, id);
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
  const moduleRevisionTracker = createModuleRevisionTracker();
  const missingSourceMonitor = createMissingSourceMonitor(rebuildTriggerPath);
  const committedModuleFiles = new Map<string, string>();
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
    moduleFiles,
    moduleRevisions,
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
            const moduleUrl = pathToFileURL(
              join(cacheDir, changedFile.fileName),
            ).href;
            const moduleRuntime = runtimeSession.captureModuleRuntime(
              changedFile.moduleId,
              moduleUrl,
            );
            await moduleRuntime.importModule(() => import(moduleUrl));
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
          committedModuleFiles.clear();
          for (const [moduleId, fileName] of moduleFiles) {
            committedModuleFiles.set(moduleId, fileName);
          }
          moduleRevisionTracker.commit(moduleRevisions);
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
      ? moduleRevisionTracker.revisionFor(chunk.facadeModuleId)
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
        if (source === '@natui/core') return false;
        return NODE_BUILTINS.has(source);
      },
      input: entry,
      onwarn(warning) {
        log(`[natui] ${formatRollupError(warning)}`);
      },
      output,
      preserveSymlinks:
        SOURCE_RESOLUTION_OPTIONS.preserveSymlinks ||
        SOURCE_RESOLUTION_OPTIONS.preserveSymlinksMain,
      plugins: developmentPlugins(
        workspaceRoot,
        id,
        entry,
        packageIndexUrl,
        runtimeUrl,
        moduleRevisionTracker,
        missingSourceMonitor,
        rebuildTriggerPath,
        committedModuleFiles,
        (bundle) => {
          nextGenerationBundle = bundle;
        },
      ),
      watch: {
        // Rollup re-arms changed files on Linux. Let that subscription settle
        // before rebuilding so a rapid follow-up save is not missed.
        buildDelay: 50,
        clearScreen: false,
        onInvalidate(moduleId) {
          if (moduleId === rebuildTriggerPath) {
            missingSourceMonitor.triggerObserved();
          }
        },
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
    missingSourceMonitor.close();
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
      missingSourceMonitor.close();
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
