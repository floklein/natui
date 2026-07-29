import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureRefreshRuntime,
  captureRefreshWorkRunner,
  REFRESH_MODULE_RUNTIME_GLOBAL,
  type ReactRefreshRuntime,
} from './refresh.js';
import {
  canonicalSourceUrl,
  resolveSourceSpecifier,
} from './resolution.js';
import type { ReactNode } from 'react';
import {
  runWithController,
  type NatuiApp,
  type NatuiAppController,
  type RunOptions,
} from '@natui/core/internal';

interface PendingRun {
  element: ReactNode;
  options: RunOptions;
}

interface GenerationState {
  artifacts: Set<string>;
  canceled: boolean;
  cancelError: Error | undefined;
  evaluatedModules: Set<string>;
  token: symbol;
  workRunner: WorkRunner;
}

interface GenerationContext {
  moduleOwner?: ModuleOwner;
  session: DevRuntimeSession;
  token: symbol;
}

type WorkRunner = <T>(work: () => T) => T;

interface ModuleOwner {
  artifactId: string;
  fallback?: ModuleOwner;
  pinned: boolean;
  refreshRuntime: ReactRefreshRuntime;
  refreshWorkRunner: WorkRunner;
  token: symbol;
}

interface DevModuleRuntime {
  importMeta: ImportMeta;
  importModule<T>(load: () => Promise<T>): Promise<T>;
  refreshRuntime: ReactRefreshRuntime;
}

const generationStorage = new AsyncLocalStorage<GenerationContext>();

function sourceIdentityUrl(sourceIdentity: string): URL {
  return sourceIdentity.startsWith('file:')
    ? new URL(sourceIdentity)
    : pathToFileURL(sourceIdentity);
}

function sourceImportMeta(
  sourceIdentity: string,
  main: boolean,
): ImportMeta {
  const sourceUrl = canonicalSourceUrl(
    sourceIdentityUrl(sourceIdentity),
    main,
  );
  const filename = fileURLToPath(sourceUrl);
  const importMeta = Object.create(null) as ImportMeta;
  Object.assign(importMeta, {
    dirname: dirname(filename),
    filename,
    main,
    resolve(specifier: string) {
      return resolveSourceSpecifier(specifier, sourceUrl, main);
    },
    url: sourceUrl.href,
  });
  return importMeta;
}

function supersededGenerationError(): Error {
  const error = new Error('natui: development generation was superseded');
  error.name = 'NatuiDevSupersededGeneration';
  return error;
}

function normalizeArtifactId(moduleUrl: string): string {
  try {
    const url = new URL(moduleUrl);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return moduleUrl;
  }
}

class DevRuntimeSession {
  private activeGeneration: GenerationState | undefined;
  private app: NatuiApp | undefined;
  private appPromise: Promise<NatuiApp> | undefined;
  private closed = false;
  private committedArtifacts = new Set<string>();
  private committedGenerationToken: symbol | undefined;
  private committedWorkRunner: WorkRunner | undefined;
  private controller: NatuiAppController | undefined;
  private currentRun: PendingRun | undefined;
  private readonly evaluatedModules = new Set<string>();
  private hadAppAtGenerationStart = false;
  private pendingRun: PendingRun | undefined;
  private reactErrors: Error[] = [];

  private readonly entryUrl: string;

  constructor(entry: string) {
    this.entryUrl = canonicalSourceUrl(pathToFileURL(entry), true).href;
  }

  beginGeneration(
    artifacts: Iterable<string>,
    workRunner: WorkRunner,
  ): symbol {
    if (this.closed) throw new Error('natui: the development session is closed');
    if (this.activeGeneration) {
      throw new Error('natui: a development generation is already being evaluated');
    }
    const token = Symbol('natui development generation');
    this.activeGeneration = {
      artifacts: new Set([...artifacts].map(normalizeArtifactId)),
      canceled: false,
      cancelError: undefined,
      evaluatedModules: new Set(),
      token,
      workRunner,
    };
    this.hadAppAtGenerationStart = this.currentRun !== undefined;
    this.pendingRun = undefined;
    this.reactErrors = [];
    return token;
  }

  runGeneration<T>(token: symbol, evaluate: () => T): T {
    this.requireGeneration(token);
    return generationStorage.run({ session: this, token }, evaluate);
  }

  runCommittedGeneration<T>(evaluate: () => T): T {
    const token = this.committedGenerationToken;
    if (!token) return evaluate();
    return generationStorage.run({ session: this, token }, evaluate);
  }

  ensureGeneration(token: symbol): void {
    this.requireGeneration(token);
  }

  captureModuleRuntime(
    moduleId: string,
    moduleUrl: string,
  ): DevModuleRuntime {
    const artifactId = normalizeArtifactId(moduleUrl);
    const context = generationStorage.getStore();
    if (context?.session === this) {
      if (context.moduleOwner) {
        const sourceOwner = this.resolveLiveOwner(context.moduleOwner);
        const active = this.activeGeneration;
        // A child can clear a static TLA gate while the next generation is
        // rendering through an unchanged parent. Register it in both the
        // candidate transaction and the paused committed transaction so
        // either a successful commit or a rollback keeps the module live.
        if (
          active &&
          !active.canceled &&
          sourceOwner.token === this.committedGenerationToken &&
          sourceOwner.token !== active.token &&
          !sourceOwner.pinned &&
          active.artifacts.has(sourceOwner.artifactId) &&
          active.artifacts.has(artifactId)
        ) {
          const activeOwner = active.workRunner(() =>
            this.captureOwner(active.token, artifactId),
          );
          const fallbackOwner = this.ownerForArtifact(sourceOwner, artifactId);
          this.markModuleEvaluated(active.token, moduleId);
          this.markModuleEvaluated(fallbackOwner.token, moduleId);
          return this.createModuleRuntime(
            this.combineOwners(activeOwner, fallbackOwner),
            moduleId,
          );
        }

        // Decide from the initiating parent artifact before replacing its
        // identity with the child artifact. A stale parent must not be
        // revived only because its child also appears in the current bundle.
        const sourceLineageIsLive =
          (
            sourceOwner.token === active?.token &&
            !active.canceled
          ) ||
          sourceOwner.token === this.committedGenerationToken ||
          (
            !sourceOwner.pinned &&
            this.committedArtifacts.has(sourceOwner.artifactId)
          );
        const inheritedOwner = this.ownerForArtifact(
          sourceOwner,
          artifactId,
          sourceOwner.pinned || !sourceLineageIsLive,
        );
        if (
          !inheritedOwner.pinned &&
          inheritedOwner.token !== this.activeGeneration?.token &&
          inheritedOwner.token !== this.committedGenerationToken &&
          this.committedArtifacts.has(artifactId)
        ) {
          return this.runCommittedWork(() => {
            const token = this.committedGenerationToken;
            if (!token) return this.createModuleRuntime(inheritedOwner, moduleId);
            this.markModuleEvaluated(token, moduleId);
            return this.createModuleRuntime(
              this.captureOwner(token, artifactId),
              moduleId,
            );
          });
        }

        this.markOwnerEvaluated(inheritedOwner, moduleId);
        return this.createModuleRuntime(inheritedOwner, moduleId);
      }

      const active = this.activeGeneration;
      if (
        active?.token === context.token ||
        this.committedGenerationToken === context.token
      ) {
        this.markModuleEvaluated(context.token, moduleId);
        return this.createModuleRuntime(
          this.captureOwner(context.token, artifactId),
          moduleId,
        );
      }
    }

    // Long-lived timers, promises, and I/O callbacks can retain an older
    // generation's ALS store. A module that starts now belongs to the latest
    // committed app, while a module already suspended in an older generation
    // captured that older transaction when its preamble first ran.
    return this.runCommittedWork(() => {
      const token = this.committedGenerationToken;
      if (!token) {
        return {
          importMeta: sourceImportMeta(
            moduleId,
            this.isEntryModule(moduleId),
          ),
          importModule: (load) => load(),
          refreshRuntime: captureRefreshRuntime(),
        };
      }
      this.markModuleEvaluated(token, moduleId);
      return this.createModuleRuntime(
        this.captureOwner(token, artifactId),
        moduleId,
      );
    });
  }

  async run(
    token: symbol,
    element: ReactNode,
    options: RunOptions = {},
  ): Promise<NatuiApp> {
    this.requireGeneration(token);
    if (this.pendingRun) {
      throw new Error('natui: a development entry may call run() only once');
    }

    this.pendingRun = { element, options };
    if (!this.appPromise) {
      const userOnUncaughtError = options.onUncaughtError;
      const userOnHostExit = options.onHostExit;
      const starting = runWithController(
        element,
        {
          ...options,
          onUncaughtError: (error) => {
            this.reactErrors.push(error);
            try {
              userOnUncaughtError?.(error);
            } catch (handlerError) {
              console.error('[natui] development onUncaughtError handler failed:', handlerError);
            }
          },
          // The dev server evaluates the user entry in-process, so run()'s
          // default (process.exit) would take the watcher and HMR clients down
          // with the host and make a restart impossible. Report and keep going.
          onHostExit: (code) => {
            this.app = undefined;
            console.error(
              code === null
                ? '[natui] host was terminated by a signal; the development server is still watching'
                : `[natui] host exited with code ${code}; the development server is still watching`,
            );
            userOnHostExit?.(code);
          },
        },
        (controller) => {
          this.controller = controller;
        },
        (work) => this.runCommittedWork(work),
      );
      this.appPromise = starting;
      try {
        const app = await starting;
        const generation = this.activeGeneration;
        if (
          this.closed ||
          generation?.token !== token ||
          generation.canceled
        ) {
          app.quit();
          throw generation?.cancelError ?? supersededGenerationError();
        }
        this.app = app;
      } catch (error) {
        if (this.appPromise === starting) this.appPromise = undefined;
        this.app = undefined;
        this.controller = undefined;
        throw error;
      }
    }

    return this.appPromise;
  }

  validateGeneration(token: symbol): void {
    this.requireGeneration(token);
    if (!this.pendingRun) {
      throw new Error(
        'natui: the development entry did not call run(); use an executable entry such as src/main.tsx',
      );
    }
  }

  async commitGeneration(
    token: symbol,
    workRunner: WorkRunner,
  ): Promise<'mounted' | 'refreshed'> {
    this.validateGeneration(token);
    const pending = this.pendingRun;
    if (!pending) throw new Error('natui: missing development run');

    const app = await this.appPromise;
    if (!app) throw new Error('natui: the development app did not start');

    if (this.hadAppAtGenerationStart) await app.update(pending.element);
    this.requireGeneration(token);
    if (this.reactErrors.length > 0) throw this.reactErrors[0];

    for (const moduleId of this.activeGeneration?.evaluatedModules ?? []) {
      this.evaluatedModules.add(moduleId);
    }
    this.committedArtifacts = new Set(
      this.activeGeneration?.artifacts ?? [],
    );
    this.committedGenerationToken = token;
    this.committedWorkRunner = workRunner;
    this.currentRun = pending;
    this.activeGeneration = undefined;
    this.pendingRun = undefined;
    return this.hadAppAtGenerationStart ? 'refreshed' : 'mounted';
  }

  async rollbackGeneration(token: symbol): Promise<void> {
    if (this.activeGeneration?.token !== token) return;
    const previous = this.currentRun;
    const app = this.app;
    const controller = this.controller;
    this.reactErrors = [];

    try {
      if (previous && app) {
        await app.update(previous.element);
        if (this.reactErrors.length > 0) throw this.reactErrors[0];
      } else if (!previous) {
        controller?.quit();
        this.app = undefined;
        this.appPromise = undefined;
        this.controller = undefined;
      }
    } finally {
      if (this.activeGeneration?.token === token) {
        this.activeGeneration = undefined;
      }
      this.pendingRun = undefined;
      this.reactErrors = [];
    }
  }

  abortGeneration(token?: symbol): void {
    if (token !== undefined && this.activeGeneration?.token !== token) return;
    this.activeGeneration = undefined;
    this.pendingRun = undefined;
    this.reactErrors = [];
  }

  cancelPendingGeneration(token: symbol, error: Error): void {
    const generation = this.activeGeneration;
    if (!generation || generation.token !== token || generation.canceled) return;
    generation.canceled = true;
    generation.cancelError = error;
    this.controller?.cancelPendingUpdate(error);
  }

  markModuleEvaluated(token: symbol, moduleId: string): void {
    const generation = this.activeGeneration;
    if (generation?.token === token) {
      if (!generation.canceled) generation.evaluatedModules.add(moduleId);
      return;
    }
    if (this.committedGenerationToken === token) {
      this.evaluatedModules.add(moduleId);
    }
  }

  wasModuleEvaluated(moduleId: string): boolean {
    return this.evaluatedModules.has(moduleId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortGeneration();
    this.controller?.quit();
    this.app = undefined;
    this.appPromise = undefined;
    this.controller = undefined;
    this.committedArtifacts.clear();
    this.committedGenerationToken = undefined;
    this.committedWorkRunner = undefined;
    this.currentRun = undefined;
    this.evaluatedModules.clear();
  }

  private requireGeneration(token: symbol): GenerationState {
    const generation = this.activeGeneration;
    if (!generation || generation.token !== token || generation.canceled) {
      throw generation?.cancelError ?? supersededGenerationError();
    }
    return generation;
  }

  private isEntryModule(moduleId: string): boolean {
    return (
      canonicalSourceUrl(sourceIdentityUrl(moduleId), true).href ===
      this.entryUrl
    );
  }

  private runCommittedWork<T>(work: () => T): T {
    const token = this.committedGenerationToken;
    const runner = this.committedWorkRunner;
    if (!token || !runner) return work();
    return generationStorage.run(
      { session: this, token },
      () => runner(work),
    );
  }

  private captureOwner(token: symbol, artifactId: string): ModuleOwner {
    return {
      artifactId,
      pinned: false,
      refreshRuntime: captureRefreshRuntime(),
      refreshWorkRunner: captureRefreshWorkRunner(),
      token,
    };
  }

  private committedOwnerFor(owner: ModuleOwner): ModuleOwner | undefined {
    const token = this.committedGenerationToken;
    if (!token) return undefined;
    if (owner.token === token) return owner;
    if (owner.pinned || !this.committedArtifacts.has(owner.artifactId)) {
      return undefined;
    }
    return this.runCommittedWork(() =>
      this.captureOwner(token, owner.artifactId),
    );
  }

  private markOwnerEvaluated(owner: ModuleOwner, moduleId: string): void {
    this.markModuleEvaluated(owner.token, moduleId);
    if (owner.fallback) this.markOwnerEvaluated(owner.fallback, moduleId);
  }

  private combineOwners(
    primary: ModuleOwner,
    fallback: ModuleOwner,
  ): ModuleOwner {
    if (primary.token === fallback.token) return primary;
    const refreshRuntime = new Proxy(primary.refreshRuntime, {
      get(target, property, receiver) {
        if (property === 'register') {
          return (type: unknown, id: string) => {
            primary.refreshRuntime.register(type, id);
            fallback.refreshRuntime.register(type, id);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as ReactRefreshRuntime;
    return {
      ...primary,
      fallback,
      refreshRuntime,
    };
  }

  private ownerForArtifact(
    owner: ModuleOwner,
    artifactId: string,
    pinned = owner.pinned,
  ): ModuleOwner {
    return {
      ...owner,
      artifactId,
      fallback: owner.fallback
        ? this.ownerForArtifact(
            owner.fallback,
            artifactId,
            pinned || owner.fallback.pinned,
          )
        : undefined,
      pinned,
    };
  }

  private resolveLiveOwner(owner: ModuleOwner): ModuleOwner {
    const active = this.activeGeneration;
    if (
      (owner.token === active?.token && !active.canceled) ||
      owner.token === this.committedGenerationToken
    ) {
      return owner;
    }
    if (owner.fallback) return this.resolveLiveOwner(owner.fallback);
    return owner;
  }

  private createModuleRuntime(
    owner: ModuleOwner,
    moduleId: string,
  ): DevModuleRuntime {
    return {
      importMeta: sourceImportMeta(
        moduleId,
        this.isEntryModule(moduleId),
      ),
      importModule: (load) => {
        const liveOwner = this.resolveLiveOwner(owner);
        const active = this.activeGeneration;
        const context = generationStorage.getStore();
        if (
          context?.session === this &&
          context.token === active?.token &&
          liveOwner.token !== active.token &&
          active.artifacts.has(liveOwner.artifactId)
        ) {
          const activeOwner = this.captureOwner(
            active.token,
            liveOwner.artifactId,
          );
          const committedOwner = this.committedOwnerFor(liveOwner);
          const currentOwner = committedOwner
            ? this.combineOwners(activeOwner, committedOwner)
            : activeOwner;
          return generationStorage.run(
            {
              moduleOwner: currentOwner,
              session: this,
              token: active.token,
            },
            () => currentOwner.refreshWorkRunner(load),
          );
        }

        if (
          liveOwner.token !== active?.token &&
          liveOwner.token !== this.committedGenerationToken &&
          this.committedArtifacts.has(liveOwner.artifactId)
        ) {
          return this.runCommittedWork(() => {
            const token = this.committedGenerationToken;
            if (!token) return load();
            const currentOwner = this.captureOwner(
              token,
              liveOwner.artifactId,
            );
            return generationStorage.run(
              { moduleOwner: currentOwner, session: this, token },
              () => currentOwner.refreshWorkRunner(load),
            );
          });
        }

        const executionOwner =
          liveOwner.pinned ||
          liveOwner.token === active?.token ||
          liveOwner.token === this.committedGenerationToken
            ? liveOwner
            : { ...liveOwner, pinned: true };
        return generationStorage.run(
          {
            moduleOwner: executionOwner,
            session: this,
            token: executionOwner.token,
          },
          () => executionOwner.refreshWorkRunner(load),
        );
      },
      refreshRuntime: owner.refreshRuntime,
    };
  }
}

const sessions = new Map<string, DevRuntimeSession>();

type DevRuntimeGlobal = typeof globalThis & {
  [REFRESH_MODULE_RUNTIME_GLOBAL]?: (
    sessionId: string,
    moduleId: string,
    moduleUrl: string,
  ) => DevModuleRuntime | undefined;
};

(globalThis as DevRuntimeGlobal)[REFRESH_MODULE_RUNTIME_GLOBAL] = (
  sessionId,
  moduleId,
  moduleUrl,
) => {
  return sessions.get(sessionId)?.captureModuleRuntime(moduleId, moduleUrl);
};

export function registerDevRuntimeSession(
  id: string,
  entry: string,
): DevRuntimeSession {
  if (sessions.has(id)) throw new Error(`natui: duplicate development session "${id}"`);
  const session = new DevRuntimeSession(entry);
  sessions.set(id, session);
  return session;
}

export function unregisterDevRuntimeSession(id: string): void {
  sessions.delete(id);
}

export function runDevEntry(
  sessionId: string,
  element: ReactNode,
  options: RunOptions = {},
): Promise<NatuiApp> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`natui: unknown development session "${sessionId}"`);
  const generation = generationStorage.getStore();
  if (!generation || generation.session !== session) {
    throw new Error('natui: run() was called outside a development generation');
  }
  return session.run(generation.token, element, options);
}
