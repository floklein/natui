import { transformAsync, types as babelTypes, type PluginObj } from '@babel/core';
import { readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import type { Loader } from 'esbuild';
import {
  REFRESH_MODULE_RUNTIME_GLOBAL,
  refreshBabelPlugin,
} from './refresh.js';

export const EMITTED_MODULE_URL_PLACEHOLDER =
  '__natui_dev_internal_emitted_module_url__';

function loaderFor(filename: string): Loader {
  switch (extname(filename).toLowerCase()) {
    case '.tsx':
      return 'tsx';
    case '.ts':
    case '.mts':
      return 'ts';
    case '.jsx':
      return 'jsx';
    default:
      return 'js';
  }
}

function parserPlugins(filename: string): ('jsx' | 'typescript')[] {
  const extension = extname(filename).toLowerCase();
  const plugins: ('jsx' | 'typescript')[] = [];
  if (['.ts', '.tsx', '.mts'].includes(extension)) plugins.push('typescript');
  if (['.jsx', '.tsx'].includes(extension)) plugins.push('jsx');
  return plugins;
}

function normalizedModuleId(root: string, filename: string): string {
  const path = relative(root, filename).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

function sourceIdentitySuffix(sourceIdentity: string): string {
  if (!sourceIdentity.startsWith('file:')) return '';
  const url = new URL(sourceIdentity);
  return `${url.search}${url.hash}`;
}

interface InstrumentationNames {
  importHelper: string;
  importMeta: string;
  moduleRuntime: string;
  refreshReg: string;
  refreshRuntime: string;
  refreshSig: string;
}

function collectIdentifierNamesPlugin(
  onNames: (names: Set<string>) => void,
): PluginObj {
  return {
    visitor: {
      Program(path) {
        const names = new Set<string>();
        path.traverse({
          Identifier(identifierPath) {
            names.add(identifierPath.node.name);
          },
          JSXIdentifier(identifierPath) {
            names.add(identifierPath.node.name);
          },
        });
        onNames(names);
      },
    },
  };
}

async function instrumentationNames(
  source: string,
  filename: string,
): Promise<InstrumentationNames> {
  let sourceNames: Set<string> | undefined;
  await transformAsync(source, {
    ast: false,
    babelrc: false,
    code: false,
    configFile: false,
    filename,
    parserOpts: {
      createImportExpressions: false,
      sourceType: 'module',
      plugins: parserPlugins(filename),
    },
    plugins: [
      collectIdentifierNamesPlugin((names) => {
        sourceNames = names;
      }),
    ],
  });
  if (!sourceNames) {
    throw new Error(`natui: could not inspect identifiers in ${filename}`);
  }

  const occupiedNames = sourceNames;
  const reserved = new Set<string>();
  const allocate = (base: string) => {
    let candidate = base;
    let suffix = 2;
    // The identifier set comes from the parsed AST, which is authoritative for
    // anything that can actually bind. A raw `source.includes` on top of it
    // only ever defended a name mentioned inside a string or comment.
    while (occupiedNames.has(candidate) || reserved.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    reserved.add(candidate);
    return candidate;
  };

  return {
    importHelper: allocate('__natuiImport'),
    importMeta: allocate('__natuiImportMeta'),
    moduleRuntime: allocate('__natuiModuleRuntime'),
    refreshReg: allocate('__natuiRefreshReg'),
    refreshRuntime: allocate('__natuiRefreshRuntime'),
    refreshSig: allocate('__natuiRefreshSig'),
  };
}

function bindImportMetaPlugin(importMetaName: string): PluginObj {
  return {
    visitor: {
      MetaProperty(path) {
        if (
          path.node.meta.name === 'import' &&
          path.node.property.name === 'meta'
        ) {
          path.replaceWith(babelTypes.identifier(importMetaName));
        }
      },
    },
  };
}

function bindDynamicImportsPlugin(helperName: string): PluginObj {
  return {
    visitor: {
      CallExpression: {
        exit(path) {
          if (path.node.callee.type !== 'Import') return;

          const argumentPaths = path.get('arguments');
          const sensitiveArguments = argumentPaths.map((argumentPath) => {
            let sensitive =
              argumentPath.isAwaitExpression() ||
              argumentPath.isYieldExpression();
            argumentPath.traverse({
              Function(functionPath) {
                functionPath.skip();
              },
              AwaitExpression(awaitPath) {
                sensitive = true;
                awaitPath.skip();
              },
              YieldExpression(yieldPath) {
                sensitive = true;
                yieldPath.skip();
              },
            });
            return sensitive;
          });
          const lastSensitiveArgument = sensitiveArguments.lastIndexOf(true);
          const argumentAssignments: ReturnType<
            typeof babelTypes.assignmentExpression
          >[] = [];
          const dynamicArguments = path.node.arguments.map((argument, index) => {
            const argumentPath = argumentPaths[index];
            const mustPreserveOuterEvaluation =
              index <= lastSensitiveArgument;
            if (!mustPreserveOuterEvaluation || !argumentPath.isExpression()) {
              return babelTypes.cloneNode(argument);
            }

            const temporary = path.scope.generateUidIdentifier('natuiImportArg');
            path.scope.push({ id: temporary });
            argumentAssignments.push(
              babelTypes.assignmentExpression(
                '=',
                babelTypes.cloneNode(temporary),
                babelTypes.cloneNode(argumentPath.node),
              ),
            );
            return babelTypes.cloneNode(temporary);
          });
          const dynamicImport = babelTypes.callExpression(
            babelTypes.cloneNode(path.node.callee),
            dynamicArguments,
          );
          const wrappedImport = babelTypes.callExpression(
            babelTypes.identifier(helperName),
            [babelTypes.arrowFunctionExpression([], dynamicImport)],
          );
          path.replaceWith(
            argumentAssignments.length > 0
              ? babelTypes.sequenceExpression([
                  ...argumentAssignments,
                  wrappedImport,
                ])
              : wrappedImport,
          );
          path.skip();
        },
      },
    },
  };
}

export async function instrumentForRefresh(
  source: string,
  filename: string,
  root: string,
  familyPrefix: string,
  sourceIdentity = filename,
): Promise<{ contents: string; loader: Loader }> {
  const moduleId =
    `${familyPrefix}:${normalizedModuleId(root, filename)}` +
    sourceIdentitySuffix(sourceIdentity);
  const names = await instrumentationNames(source, filename);
  const result = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    envName: 'development',
    filename,
    parserOpts: {
      createImportExpressions: false,
      sourceType: 'module',
      plugins: parserPlugins(filename),
    },
    plugins: [
      bindImportMetaPlugin(names.importMeta),
      bindDynamicImportsPlugin(names.importHelper),
      [
        refreshBabelPlugin,
        {
          skipEnvCheck: true,
          refreshReg: names.refreshReg,
          refreshSig: names.refreshSig,
        },
      ],
    ],
    sourceMaps: 'inline',
  });

  if (result?.code === undefined || result.code === null) {
    throw new Error(`natui: React Refresh transform returned no code for ${filename}`);
  }

  const preamble = [
    `const ${names.moduleRuntime} = globalThis[${JSON.stringify(REFRESH_MODULE_RUNTIME_GLOBAL)}]?.(${JSON.stringify(familyPrefix)}, ${JSON.stringify(sourceIdentity)}, ${JSON.stringify(EMITTED_MODULE_URL_PLACEHOLDER)});`,
    `if (!${names.moduleRuntime}) throw new Error("natui: React Refresh runtime is not installed");`,
    `const ${names.importMeta} = ${names.moduleRuntime}.importMeta;`,
    `const ${names.refreshRuntime} = ${names.moduleRuntime}.refreshRuntime;`,
    `const ${names.importHelper} = ${names.moduleRuntime}.importModule;`,
    `const ${names.refreshReg} = (type, id) => ${names.refreshRuntime}.register(type, ${JSON.stringify(`${moduleId} `)} + id);`,
    `const ${names.refreshSig} = ${names.refreshRuntime}.createSignatureFunctionForTransform;`,
    '',
  ].join('\n');

  const shebang = result.code.startsWith('#!')
    ? result.code.slice(0, result.code.indexOf('\n') + 1)
    : '';
  const code = shebang ? result.code.slice(shebang.length) : result.code;

  return {
    contents: `${shebang}${preamble}${code}`,
    loader: loaderFor(filename),
  };
}

export async function loadAndInstrumentForRefresh(
  filename: string,
  root: string,
  familyPrefix: string,
  sourceIdentity = filename,
): Promise<{ contents: string; loader: Loader }> {
  return instrumentForRefresh(
    await readFile(filename, 'utf8'),
    filename,
    root,
    familyPrefix,
    sourceIdentity,
  );
}
