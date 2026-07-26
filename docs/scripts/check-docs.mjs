import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptsRoot, '..');
const repoRoot = path.resolve(docsRoot, '..');
const contentRoot = path.join(docsRoot, 'content', 'docs');
const publicRoot = path.join(docsRoot, 'public');
const sourceAppSchema = path.join(repoRoot, 'schemas', 'natui-app.schema.json');
const publicAppSchema = path.join(publicRoot, 'schemas', 'natui-app.schema.json');

const errors = [];
const pages = [];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(fullPath)));
    else output.push(fullPath);
  }
  return output;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
}

function routeFor(filePath) {
  const relative = path.relative(contentRoot, filePath).replaceAll(path.sep, '/');
  const withoutExtension = relative.replace(/\.mdx?$/i, '');
  const segments = withoutExtension.split('/');
  if (segments.at(-1) === 'index') segments.pop();
  return `/docs${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
}

function parseFrontmatter(source, filePath) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    errors.push(`${relativePath(filePath)}:1 is missing leading frontmatter`);
    return {};
  }

  const values = new Map();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    const property = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!property) continue;

    const [, key, rawValue] = property;
    if (values.has(key)) {
      errors.push(`${relativePath(filePath)}:${index + 2} repeats frontmatter key ${key}`);
      continue;
    }

    if (/^[>|]/.test(rawValue.trim())) {
      errors.push(
        `${relativePath(filePath)}:${index + 2} uses unsupported block YAML for ${key}`,
      );
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value.trim());
  }

  for (const key of ['title', 'description']) {
    if (!values.get(key)) {
      errors.push(`${relativePath(filePath)} frontmatter requires a non-empty ${key}`);
    }
  }

  return Object.fromEntries(values);
}

function stripCode(source) {
  const lines = source.split(/\r?\n/);
  let fence;

  return lines
    .map((line) => {
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { character: marker[0], length: marker.length };
        else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
        return '';
      }
      if (fence) return '';
      return line.replace(/(`+)([\s\S]*?)\1/g, '');
    })
    .join('\n');
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function unescapedTableCodePipes(source) {
  const matches = [];
  const lines = source.split(/\r?\n/);
  let fence;

  for (const [index, line] of lines.entries()) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence || !line.trimStart().startsWith('|')) continue;

    for (const code of line.matchAll(/`([^`\r\n]*)`/g)) {
      if (/(^|[^\\])\|/.test(code[1])) {
        matches.push(index + 1);
        break;
      }
    }
  }

  return matches;
}

function headingSlugs(source) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of stripCode(source).split(/\r?\n/)) {
    const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = heading
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const allFiles = await walk(contentRoot);
const contentFiles = allFiles.filter((filePath) => /\.mdx?$/i.test(filePath));
const metaFiles = allFiles.filter((filePath) => path.basename(filePath) === 'meta.json');

try {
  const [sourceSchema, publishedSchema] = await Promise.all([
    readFile(sourceAppSchema, 'utf8'),
    readFile(publicAppSchema, 'utf8'),
  ]);
  if (sourceSchema !== publishedSchema) {
    errors.push(
      'docs/public/schemas/natui-app.schema.json must exactly match schemas/natui-app.schema.json',
    );
  }
} catch (error) {
  errors.push(`cannot compare the published application schema: ${error.message}`);
}

for (const metaFile of metaFiles) {
  try {
    const parsed = JSON.parse(await readFile(metaFile, 'utf8'));
    if (!parsed.title || !Array.isArray(parsed.pages)) {
      errors.push(`${relativePath(metaFile)} requires title and pages`);
    }
  } catch (error) {
    errors.push(`${relativePath(metaFile)} is invalid JSON: ${error.message}`);
  }
}

for (const filePath of contentFiles) {
  const source = await readFile(filePath, 'utf8');
  const frontmatter = parseFrontmatter(source, filePath);
  pages.push({
    filePath,
    route: routeFor(filePath),
    source,
    frontmatter,
    headings: headingSlugs(source),
  });

  const fullTextPatterns = [
    [/\u2014/u, 'contains a forbidden em dash'],
    [/\uFFFD/u, 'contains a replacement character'],
    [/cite[^]*/u, 'contains an internal citation token'],
    [/\bturn\d+(?:search|fetch|view|open)\d+\b/iu, 'contains an internal source reference'],
    [/<\/?oai-mem-citation\b/iu, 'contains a memory citation tag'],
    [
      /::(?:code-comment|created-thread|git-(?:stage|commit|create-branch|push|create-pr))\{/u,
      'contains an application directive',
    ],
    [/<script\b/iu, 'contains a script element'],
    [
      /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/u,
      'contains a value that resembles a secret',
    ],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'contains a private key'],
    [
      /(?:\b[A-Za-z]:\\Users\\[^\\\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/u,
      'contains a machine-local user path',
    ],
  ];

  for (const [pattern, message] of fullTextPatterns) {
    const match = pattern.exec(source);
    if (match) errors.push(`${relativePath(filePath)}:${lineNumber(source, match.index)} ${message}`);
  }

  const prose = stripCode(source);
  const prosePatterns = [
    [/\b(?:TODO|TBD|FIXME)\b/u, 'contains unfinished prose'],
    [/\blorem ipsum\b/iu, 'contains placeholder prose'],
    [/\bas an AI language model\b/iu, 'contains assistant boilerplate'],
    [/\bI hope this helps\b/iu, 'contains assistant boilerplate'],
    [/\bWelcome to Fumadocs\b/iu, 'contains starter copy'],
    [/<[A-Z][A-Za-z0-9]*\b/u, 'contains an unresolved MDX component'],
  ];

  for (const [pattern, message] of prosePatterns) {
    const match = pattern.exec(prose);
    if (match) errors.push(`${relativePath(filePath)}:${lineNumber(prose, match.index)} ${message}`);
  }

  for (const line of unescapedTableCodePipes(source)) {
    errors.push(
      `${relativePath(filePath)}:${line} contains an unescaped pipe inside a table code span`,
    );
  }
}

const routeMap = new Map(pages.map((page) => [page.route, page]));
const knownRoutes = new Set(['/', '/docs', '/llms.txt', '/llms-full.txt', ...routeMap.keys()]);

for (const page of pages) {
  const prose = stripCode(page.source);
  const targets = [];
  for (const match of prose.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    targets.push({ target: match[1].trim().split(/\s+(?=["'])/)[0], offset: match.index });
  }
  for (const match of prose.matchAll(/\b(?:href|src)\s*=\s*(['"])(.*?)\1/gu)) {
    targets.push({ target: match[2], offset: match.index });
  }

  for (const { target: rawTarget, offset } of targets) {
    const target = rawTarget.replace(/^<|>$/g, '');
    const diagnostic = `${relativePath(page.filePath)}:${lineNumber(prose, offset)} link ${target}`;

    if (!target || target === '#') {
      errors.push(`${diagnostic} is empty`);
      continue;
    }
    if (target.includes('\\')) {
      errors.push(`${diagnostic} uses backslashes`);
      continue;
    }
    if (/^(?:https?:|mailto:|tel:|\/\/)/i.test(target)) continue;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
      errors.push(`${diagnostic} uses an unsafe or unsupported scheme`);
      continue;
    }

    const [pathname, fragment] = target.split('#', 2);
    if (!pathname && fragment) {
      if (!page.headings.has(fragment)) errors.push(`${diagnostic} has an unresolved fragment`);
      continue;
    }

    if (pathname.startsWith('/')) {
      if (pathname.startsWith('/images/')) {
        const assetPath = path.join(publicRoot, pathname.slice(1));
        if (!(await exists(assetPath))) errors.push(`${diagnostic} does not resolve to a public asset`);
        continue;
      }

      const normalized = pathname.replace(/\/+$/, '') || '/';
      const targetPage = routeMap.get(normalized);
      if (!knownRoutes.has(normalized)) {
        errors.push(`${diagnostic} does not resolve to an application route`);
      } else if (fragment && targetPage && !targetPage.headings.has(fragment)) {
        errors.push(`${diagnostic} has an unresolved fragment`);
      }
      continue;
    }

    const resolved = path.resolve(path.dirname(page.filePath), pathname);
    const candidates = [
      resolved,
      `${resolved}.md`,
      `${resolved}.mdx`,
      path.join(resolved, 'index.md'),
      path.join(resolved, 'index.mdx'),
    ];
    if (!(await Promise.any(candidates.map(async (candidate) => {
      if (await exists(candidate)) return true;
      throw new Error('missing');
    })).catch(() => false))) {
      errors.push(`${diagnostic} does not resolve to a file`);
    }
  }

  for (const match of page.source.matchAll(
    /<auto-type-table\s+path="([^"]+)"\s+name="([^"]+)"\s*\/>/g,
  )) {
    const [, sourcePath, symbol] = match;
    const resolved = path.resolve(path.dirname(page.filePath), sourcePath);
    if (!(await exists(resolved))) {
      errors.push(
        `${relativePath(page.filePath)}:${lineNumber(page.source, match.index)} type source ${sourcePath} is missing`,
      );
      continue;
    }
    const typeSource = await readFile(resolved, 'utf8');
    const symbolPattern = new RegExp(
      `\\bexport\\s+(?:declare\\s+)?(?:interface|type|class|function|const)\\s+${symbol}\\b`,
    );
    if (!symbolPattern.test(typeSource)) {
      errors.push(
        `${relativePath(page.filePath)}:${lineNumber(page.source, match.index)} type ${symbol} is not exported by ${sourcePath}`,
      );
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`docs check: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `docs check: ${pages.length} pages, ${metaFiles.length} navigation files, and all internal links are valid`,
  );
}
