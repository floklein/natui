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
    case '.cts':
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
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
  if (['.jsx', '.tsx'].includes(extension)) plugins.push('jsx');
  return plugins;
}

function normalizedModuleId(root: string, filename: string): string {
  const path = relative(root, filename).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

function bindDynamicImportsPlugin(state: { helperName: string }): PluginObj {
  return {
    visitor: {
      Program(path) {
        state.helperName = path.scope.generateUidIdentifier('natuiImport').name;
      },
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
              sensitiveArguments[index] ||
              (index < lastSensitiveArgument && !argumentPath.isPure());
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
            babelTypes.identifier(state.helperName),
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
): Promise<{ contents: string; loader: Loader }> {
  const moduleId = `${familyPrefix}:${normalizedModuleId(root, filename)}`;
  const dynamicImportState = { helperName: '' };
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
      bindDynamicImportsPlugin(dynamicImportState),
      [
        refreshBabelPlugin,
        {
          skipEnvCheck: true,
          refreshReg: '__natuiRefreshReg',
          refreshSig: '__natuiRefreshSig',
        },
      ],
    ],
    sourceMaps: 'inline',
  });

  if (result?.code === undefined || result.code === null) {
    throw new Error(`natui: React Refresh transform returned no code for ${filename}`);
  }
  if (!dynamicImportState.helperName) {
    throw new Error(`natui: dynamic import transform did not initialize for ${filename}`);
  }

  const preamble = [
    `const __natuiModuleRuntime = globalThis[${JSON.stringify(REFRESH_MODULE_RUNTIME_GLOBAL)}]?.(${JSON.stringify(familyPrefix)}, ${JSON.stringify(filename)}, ${JSON.stringify(EMITTED_MODULE_URL_PLACEHOLDER)});`,
    'if (!__natuiModuleRuntime) throw new Error("natui: React Refresh runtime is not installed");',
    'const __natuiRefreshRuntime = __natuiModuleRuntime.refreshRuntime;',
    `const ${dynamicImportState.helperName} = __natuiModuleRuntime.importModule;`,
    `const __natuiRefreshReg = (type, id) => __natuiRefreshRuntime.register(type, ${JSON.stringify(`${moduleId} `)} + id);`,
    'const __natuiRefreshSig = __natuiRefreshRuntime.createSignatureFunctionForTransform;',
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
): Promise<{ contents: string; loader: Loader }> {
  return instrumentForRefresh(await readFile(filename, 'utf8'), filename, root, familyPrefix);
}
