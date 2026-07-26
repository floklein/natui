import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptsRoot, '..');
const repoRoot = path.resolve(docsRoot, '..');
const contentRoot = path.join(docsRoot, 'content', 'docs');
const componentContentRoot = path.join(contentRoot, 'components');
const componentSourcePath = path.join(repoRoot, 'packages', 'natui', 'src', 'components.ts');
const generatedRoot = path.join(docsRoot, '.next', 'typecheck-examples');

async function walk(directory) {
  const output = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(fullPath)));
    else if (entry.isFile() && entry.name.endsWith('.mdx')) output.push(fullPath);
  }

  return output;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
}

const examples = [];
const componentSource = await readFile(componentSourcePath, 'utf8');
const componentNames = [
  ...componentSource.matchAll(
    /^\s*export\s+const\s+([A-Z][A-Za-z0-9]*)\s*=\s*host(?:\s*<[^>\r\n]+>)?\s*\(/gm,
  ),
].map((match) => match[1]);

const exampleContextNames = [
  'completed',
  'confirming',
  'content',
  'due',
  'email',
  'enabled',
  'expanded',
  'exportAs',
  'handleAction',
  'handleAlertButton',
  'handleCommand',
  'handleRowAction',
  'name',
  'navigation',
  'notes',
  'open',
  'quantity',
  'query',
  'rows',
  'save',
  'selected',
  'selection',
  'setConfirming',
  'setDue',
  'setEmail',
  'setEnabled',
  'setExpanded',
  'setName',
  'setNotes',
  'setOpen',
  'setQuery',
  'setQuantity',
  'setSelected',
  'setSelection',
  'setSize',
  'setSort',
  'setTab',
  'setVisibility',
  'setVolume',
  'size',
  'sort',
  'submit',
  'tab',
  'total',
  'visibility',
  'volume',
];

function typecheckFences(source) {
  const found = [];
  let fence;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = /^[ \t]*(`{3,})[ \t]*(.*)$/.exec(line);
    if (!marker) continue;

    const [, ticks, info] = marker;
    if (!fence) {
      fence = ticks.length;
      if (/\btypecheck\b/.test(info)) found.push({ info: info.trim(), line: index + 1 });
    } else if (ticks.length >= fence && info.trim() === '') {
      fence = undefined;
    }
  }

  return found;
}

function wrapComponentExample(code) {
  const indented = code
    .trim()
    .split(/\r?\n/)
    .map((line) => `      ${line}`)
    .join('\n');

  return [
    `import { ${componentNames.join(', ')} } from '@natui/core/components';`,
    ...exampleContextNames.map((name) => `declare const ${name}: any;`),
    '',
    'function DocumentationExample() {',
    '  return (',
    '    <>',
    indented,
    '    </>',
    '  );',
    '}',
  ].join('\n');
}

const skipped = [];

for (const filePath of await walk(contentRoot)) {
  const source = await readFile(filePath, 'utf8');
  let index = 0;

  for (const match of source.matchAll(
    /^[ \t]*```(?:ts|tsx)[ \t]+typecheck[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm,
  )) {
    index += 1;
    examples.push({
      code: match[1],
      filePath,
      generatedName: `${relativePath(filePath).replaceAll('/', '__')}__${index}.tsx`,
      kind: 'standalone',
    });
  }

  const fences = typecheckFences(source);
  if (fences.length !== index) {
    const mislabeled = fences.filter((fence) => !/^(?:ts|tsx)[ \t]+typecheck$/.test(fence.info));
    if (mislabeled.length > 0) {
      for (const fence of mislabeled) {
        skipped.push(`${relativePath(filePath)}:${fence.line} \`\`\`${fence.info}`);
      }
    } else {
      skipped.push(
        `${relativePath(filePath)} declares ${fences.length} typecheck fences but ${index} were collected`,
      );
    }
  }

  if (path.dirname(filePath) !== componentContentRoot) continue;

  let componentIndex = 0;
  for (const match of source.matchAll(
    /^[ \t]*```tsx[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm,
  )) {
    componentIndex += 1;
    examples.push({
      code: wrapComponentExample(match[1]),
      filePath,
      generatedName: `${relativePath(filePath).replaceAll('/', '__')}__component_${componentIndex}.tsx`,
      kind: 'component',
    });
  }
}

if (skipped.length > 0) {
  throw new Error(
    `Typecheck examples were declared but not collected:\n${skipped.join('\n')}\nUse \`\`\`ts typecheck or \`\`\`tsx typecheck.`,
  );
}

if (examples.length === 0) {
  throw new Error('No ```ts typecheck or ```tsx typecheck examples were found.');
}

await rm(generatedRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });

const generatedFiles = await Promise.all(
  examples.map(async (example) => {
    const generatedPath = path.join(generatedRoot, example.generatedName);
    await writeFile(
      generatedPath,
      `// Generated from ${relativePath(example.filePath)}\n${example.code.trim()}\n`,
      'utf8',
    );
    return generatedPath;
  }),
);

const program = ts.createProgram(generatedFiles, {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  baseUrl: docsRoot,
  paths: {
    '@natui/core': ['../packages/natui/src/index.ts'],
    '@natui/core/components': ['../packages/natui/src/components.ts'],
    '@natui/core/inproc': ['../packages/natui/src/inproc.ts'],
    '@natui/core/dev': ['../packages/natui/src/dev/index.ts'],
    '@natui/core/config': ['../packages/natui/app-config.d.ts'],
  },
});

const diagnostics = ts.getPreEmitDiagnostics(program);

if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  };
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  process.exitCode = 1;
} else {
  console.log(`documentation examples: ${examples.length} TypeScript examples are valid`);
}
