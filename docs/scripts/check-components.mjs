import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptsRoot, '..');
const repoRoot = path.resolve(docsRoot, '..');
const componentSourcePath = path.join(repoRoot, 'packages', 'natui', 'src', 'components.ts');
const packageIndexPath = path.join(repoRoot, 'packages', 'natui', 'src', 'index.ts');
const packageManifestPath = path.join(repoRoot, 'packages', 'natui', 'package.json');
const componentDocsRoot = path.join(docsRoot, 'content', 'docs', 'components');

const hostExportPattern =
  /^\s*export\s+const\s+([A-Z][A-Za-z0-9]*)\s*=\s*host(?:\s*<[^>\r\n]+>)?\s*\(\s*(['"])([A-Z][A-Za-z0-9]*)\2\s*\)\s*;?\s*$/gm;

function fail(messages) {
  for (const message of messages) console.error(`component catalog: ${message}`);
  process.exitCode = 1;
}

function withoutFencedCode(source) {
  const lines = source.split(/\r?\n/);
  let fence;

  return lines
    .map((line) => {
      const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        const marker = match[1];
        if (!fence) fence = { character: marker[0], length: marker.length };
        else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
        return '';
      }

      return fence ? '' : line;
    })
    .join('\n');
}

function identifierPattern(identifier) {
  return new RegExp(`(^|[^A-Za-z0-9_])${identifier}([^A-Za-z0-9_]|$)`);
}

const [componentSource, packageIndex, packageManifestText, componentDocEntries] =
  await Promise.all([
    readFile(componentSourcePath, 'utf8'),
    readFile(packageIndexPath, 'utf8'),
    readFile(packageManifestPath, 'utf8'),
    readdir(componentDocsRoot, { withFileTypes: true }),
  ]);

const errors = [];
const components = [];
const exportedNames = new Set();
const hostKinds = new Set();

for (const match of componentSource.matchAll(hostExportPattern)) {
  const [, exportedName, , hostKind] = match;

  if (exportedName !== hostKind) {
    errors.push(`export ${exportedName} uses mismatched host kind ${hostKind}`);
  }
  if (exportedNames.has(exportedName)) errors.push(`duplicate export ${exportedName}`);
  if (hostKinds.has(hostKind)) errors.push(`duplicate host kind ${hostKind}`);

  exportedNames.add(exportedName);
  hostKinds.add(hostKind);
  components.push(exportedName);
}

if (components.length === 0) errors.push('no public host component exports were found');

if (!/^\s*export\s+\*\s+from\s+['"]\.\/components\.js['"]\s*;?\s*$/m.test(packageIndex)) {
  errors.push('packages/natui/src/index.ts does not re-export ./components.js');
}

const packageManifest = JSON.parse(packageManifestText);
if (!packageManifest.exports?.['./components']) {
  errors.push('packages/natui/package.json does not expose ./components');
}

const detailFiles = componentDocEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx') && entry.name !== 'index.mdx')
  .map((entry) => entry.name)
  .sort();

const headings = [];
const sections = [];
for (const fileName of detailFiles) {
  const rawSource = await readFile(path.join(componentDocsRoot, fileName), 'utf8');
  const source = withoutFencedCode(rawSource);

  for (const line of source.split(/\r?\n/)) {
    const match = /^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) headings.push({ fileName, text: match[1] });
  }

  for (const match of rawSource.matchAll(
    /^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n([\s\S]*?)(?=^[ \t]{0,3}##[ \t]+|(?![\s\S]))/gm,
  )) {
    sections.push({
      fileName,
      text: match[1],
      body: match[2],
    });
  }
}

for (const component of components) {
  const owners = headings.filter((heading) => identifierPattern(component).test(heading.text));
  if (owners.length !== 1) {
    errors.push(
      `${component} must appear in exactly one detailed H2 heading, found ${owners.length}`,
    );
    continue;
  }

  const section = sections.find(
    (candidate) =>
      candidate.fileName === owners[0].fileName &&
      candidate.text === owners[0].text,
  );

  if (!section) {
    errors.push(`${component} section could not be parsed in ${owners[0].fileName}`);
    continue;
  }

  const typeTablePattern = new RegExp(
    `<auto-type-table\\b[^>]*\\bname=["']${component}Props["'][^>]*/>`,
  );
  if (!typeTablePattern.test(section.body)) {
    errors.push(`${component} section is missing its generated ${component}Props table`);
  }
  if (!/^[ \t]*```tsx(?:[ \t]|\r?$)/m.test(section.body)) {
    errors.push(`${component} section is missing a TypeScript example`);
  }
}

const indexSource = withoutFencedCode(
  await readFile(path.join(componentDocsRoot, 'index.mdx'), 'utf8'),
);
const indexedComponents = new Set(
  [...indexSource.matchAll(/`([A-Z][A-Za-z0-9]*)`/g)]
    .map((match) => match[1])
    .filter((identifier) => exportedNames.has(identifier)),
);

for (const component of components) {
  if (!indexedComponents.has(component)) errors.push(`${component} is missing from the index table`);
}
for (const component of indexedComponents) {
  if (!exportedNames.has(component)) errors.push(`${component} is not a public host export`);
}

if (indexedComponents.size !== components.length) {
  errors.push(
    `index table contains ${indexedComponents.size} components, expected ${components.length}`,
  );
}

if (errors.length > 0) {
  fail(errors);
} else {
  console.log(
    `component catalog: ${components.length} public components covered across ${detailFiles.length} group pages`,
  );
}
