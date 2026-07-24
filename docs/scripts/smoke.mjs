import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptsRoot, '..');
const contentRoot = path.join(docsRoot, 'content', 'docs');
const require = createRequire(import.meta.url);
const externalBaseUrl = process.env.DOCS_BASE_URL?.replace(/\/+$/, '');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`documentation server exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('documentation server did not become ready within 45 seconds');
}

async function request(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...init,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    response,
    body,
    text: new TextDecoder().decode(body),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertTextResponse(result, pathname, contentType) {
  assert(result.response.status === 200, `${pathname} returned ${result.response.status}`);
  assert(
    result.response.headers.get('content-type')?.includes(contentType),
    `${pathname} did not return ${contentType}`,
  );
}

function normalized(value) {
  return value.replace(/\r\n/g, '\n').trim();
}

function variesBy(result, headerName) {
  return (
    result.response.headers
      .get('vary')
      ?.split(',')
      .some((value) => value.trim().toLowerCase() === headerName.toLowerCase()) ?? false
  );
}

function isExcludedFromSharedCaches(result) {
  const cacheControl = result.response.headers.get('cache-control')?.toLowerCase() ?? '';
  return cacheControl.includes('private') || cacheControl.includes('no-store');
}

function assertNegotiationCacheSafe(result, label) {
  assert(
    variesBy(result, 'Accept') || isExcludedFromSharedCaches(result),
    `${label} is shared-cacheable without Vary: Accept`,
  );
}

function assertPermanentlyCached(result, label) {
  const cacheControl = result.response.headers.get('cache-control')?.toLowerCase() ?? '';
  assert(
    cacheControl.includes('s-maxage=31536000') || cacheControl.includes('immutable'),
    `${label} is not permanently cached`,
  );
}

async function listDocumentationRoutes(directory = contentRoot) {
  const routes = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      routes.push(...(await listDocumentationRoutes(fullPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;

    const relative = path.relative(contentRoot, fullPath).replaceAll(path.sep, '/');
    const segments = relative.replace(/\.mdx$/, '').split('/');
    if (segments.at(-1) === 'index') segments.pop();
    routes.push(`/docs${segments.length > 0 ? `/${segments.join('/')}` : ''}`);
  }

  return routes;
}

function assertPng(result, pathname) {
  assert(result.response.status === 200, `${pathname} returned ${result.response.status}`);
  assert(
    result.response.headers.get('content-type')?.includes('image/png'),
    `${pathname} is not a PNG`,
  );
  assert(result.body.length > 10_000, `${pathname} is unexpectedly small`);

  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert(
    pngSignature.every((value, index) => result.body[index] === value),
    `${pathname} has an invalid PNG signature`,
  );

  const pngView = new DataView(
    result.body.buffer,
    result.body.byteOffset,
    result.body.byteLength,
  );
  assert(pngView.getUint32(16) === 1200, `${pathname} width is not 1200`);
  assert(pngView.getUint32(20) === 630, `${pathname} height is not 630`);
}

let child;
let logs = '';

try {
  if (!externalBaseUrl) {
    await readFile(path.join(docsRoot, '.next', 'BUILD_ID'), 'utf8');
  }

  const port = externalBaseUrl ? undefined : await reservePort();
  const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;

  if (!externalBaseUrl) {
    const nextCli = require.resolve('next/dist/bin/next');
    child = spawn(process.execPath, [nextCli, 'start', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: docsRoot,
      windowsHide: true,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'production',
        SITE_URL: baseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk) => {
      logs = `${logs}${chunk.toString()}`.slice(-12_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
  }

  await waitForServer(baseUrl, child);

  const home = await request(baseUrl, '/');
  assertTextResponse(home, '/', 'text/html');
  assert(/<html/i.test(home.text) && /natui/i.test(home.text), '/ is missing homepage content');
  assert(
    /<title>Real native UI\. Written in React\.<\/title>/.test(home.text),
    '/ does not use the homepage title in HTML metadata',
  );
  assert(/rel="canonical"/.test(home.text), '/ is missing its canonical URL');
  assert(/\/og\/image\.png/.test(home.text), '/ is missing its Open Graph image');

  const start = await request(baseUrl, '/docs/start');
  assertTextResponse(start, '/docs/start', 'text/html');
  assert(/Set up natui from source/.test(start.text), '/docs/start is missing its page content');
  assert(/Copy Markdown/.test(start.text), '/docs/start is missing Copy Markdown');
  assert(/View Markdown/.test(start.text), '/docs/start is missing View Markdown');
  assert(/View source/.test(start.text), '/docs/start is missing View source');
  assert(
    !/Open in (?:ChatGPT|Claude|Scira AI|Cursor)/.test(start.text),
    '/docs/start exposes an external AI provider action',
  );
  assert(
    /\/og\/docs\/start\/image\.png/.test(start.text),
    '/docs/start is missing its page Open Graph image',
  );
  assert(
    /summary_large_image/.test(start.text),
    '/docs/start is missing summary_large_image metadata',
  );

  const search = await request(baseUrl, '/api/search?query=TextEditor');
  assertTextResponse(search, '/api/search?query=TextEditor', 'application/json');
  const searchJson = JSON.parse(search.text);
  assert(Array.isArray(searchJson), 'search response is not an array');
  const searchText = JSON.stringify(searchJson);
  assert(/TextEditor/.test(searchText), 'search does not return TextEditor');
  assert(
    /\/docs\/components\/inputs/.test(searchText),
    'TextEditor search result does not point to the inputs page',
  );
  assert(
    !/typetable|type-table-components/i.test(searchText),
    'search exposes unresolved generated type-table data',
  );

  for (const [query, expectedRoute] of [
    ['minSidebarWidth', '/docs/components/app-shell-navigation'],
    ['requestTimeoutMs', '/docs/api/bridge'],
  ]) {
    const apiSearch = await request(baseUrl, `/api/search?query=${encodeURIComponent(query)}`);
    assertTextResponse(apiSearch, `/api/search?query=${query}`, 'application/json');
    const apiSearchText = JSON.stringify(JSON.parse(apiSearch.text));
    assert(apiSearchText.includes(query), `search does not return generated API prop ${query}`);
    assert(
      apiSearchText.includes(expectedRoute),
      `${query} search result does not point to ${expectedRoute}`,
    );
    assert(
      !/typetable|type-table-components/i.test(apiSearchText),
      `${query} search result exposes unresolved type-table data`,
    );
  }

  const llmsIndex = await request(baseUrl, '/llms.txt');
  assert(llmsIndex.response.status === 200, '/llms.txt did not return 200');
  assertPermanentlyCached(llmsIndex, '/llms.txt');
  assert(/\/docs\/start/.test(llmsIndex.text), '/llms.txt is missing /docs/start');
  assert(/\/docs\/components/.test(llmsIndex.text), '/llms.txt is missing /docs/components');

  const llmsFull = await request(baseUrl, '/llms-full.txt');
  assert(llmsFull.response.status === 200, '/llms-full.txt did not return 200');
  assertPermanentlyCached(llmsFull, '/llms-full.txt');
  assert(llmsFull.text.length > 1_000, '/llms-full.txt is unexpectedly small');
  assert(/^# /m.test(llmsFull.text), '/llms-full.txt has no Markdown headings');
  assert(/TextEditor/.test(llmsFull.text), '/llms-full.txt is missing TextEditor');
  assert(
    /\| Property \| Type \| Required \| Description \|/.test(llmsFull.text),
    '/llms-full.txt is missing expanded API type tables',
  );
  assert(
    llmsFull.text.includes('((value: string) => void)'),
    '/llms-full.txt is missing exact generated TypeScript signatures',
  );
  assert(!/<TypeTable\b/.test(llmsFull.text), '/llms-full.txt contains unresolved TypeTable JSX');

  const startMarkdown = await request(baseUrl, '/docs/start.md');
  assertTextResponse(startMarkdown, '/docs/start.md', 'text/markdown');
  assertPermanentlyCached(startMarkdown, '/docs/start.md');
  assert(/^# Start$/m.test(startMarkdown.text), '/docs/start.md is missing its canonical heading');
  assert(
    (startMarkdown.text.match(/^# /gm) ?? []).length === 1,
    '/docs/start.md contains duplicate top-level headings',
  );
  assert(!/<html/i.test(startMarkdown.text), '/docs/start.md returned HTML');

  const negotiatedMarkdown = await request(baseUrl, '/docs/start', {
    headers: { Accept: 'text/markdown' },
  });
  assertTextResponse(negotiatedMarkdown, 'Markdown negotiation', 'text/markdown');
  assertNegotiationCacheSafe(negotiatedMarkdown, 'Markdown negotiation');
  assert(
    normalized(negotiatedMarkdown.text) === normalized(startMarkdown.text),
    'negotiated Markdown differs from /docs/start.md',
  );

  const explicitMarkdown = await request(baseUrl, '/docs/start.md', {
    headers: { Accept: 'text/markdown' },
  });
  assertTextResponse(explicitMarkdown, '/docs/start.md with Markdown Accept', 'text/markdown');
  assert(
    normalized(explicitMarkdown.text) === normalized(startMarkdown.text),
    '/docs/start.md changes when Markdown is explicitly accepted',
  );

  const explicitHtml = await request(baseUrl, '/docs/start', {
    headers: { Accept: 'text/html' },
  });
  assertTextResponse(explicitHtml, 'HTML negotiation', 'text/html');
  assertNegotiationCacheSafe(explicitHtml, 'HTML negotiation');

  const og = await request(baseUrl, '/og/docs/start/image.png');
  assertPng(og, '/og/docs/start/image.png');

  const homeOg = await request(baseUrl, '/og/image.png');
  assertPng(homeOg, '/og/image.png');

  const documentationRoutes = await listDocumentationRoutes();

  const sitemap = await request(baseUrl, '/sitemap.xml');
  assertTextResponse(sitemap, '/sitemap.xml', 'application/xml');
  const sitemapPaths = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    ([, value]) => new URL(value).pathname,
  );
  assert(
    documentationRoutes.every((route) => sitemapPaths.includes(route)),
    '/sitemap.xml is missing a documentation route',
  );

  const robots = await request(baseUrl, '/robots.txt');
  assertTextResponse(robots, '/robots.txt', 'text/plain');
  assert(/Sitemap: https?:\/\/[^/]+\/sitemap\.xml/.test(robots.text), '/robots.txt is missing the sitemap URL');

  for (const route of documentationRoutes) {
    const suffix = route.slice('/docs'.length);
    const markdownPath = suffix ? `${route}.md` : '/docs.md';
    const ogPath = `/og/docs${suffix}/image.png`;

    const htmlPage = await request(baseUrl, route);
    assertTextResponse(htmlPage, route, 'text/html');
    assert(htmlPage.text.includes(ogPath), `${route} is missing its Open Graph image URL`);
    assert(
      /summary_large_image/.test(htmlPage.text),
      `${route} is missing summary_large_image metadata`,
    );
    assert(
      /natui documentation:/.test(htmlPage.text),
      `${route} is missing descriptive social image alt text`,
    );

    const markdownPage = await request(baseUrl, markdownPath);
    assertTextResponse(markdownPage, markdownPath, 'text/markdown');
    assertPermanentlyCached(markdownPage, markdownPath);
    assert(
      (markdownPage.text.match(/^# /gm) ?? []).length === 1,
      `${markdownPath} must contain exactly one top-level heading`,
    );
    assert(!/<TypeTable\b/.test(markdownPage.text), `${markdownPath} contains TypeTable JSX`);
    assert(!/<script\b/i.test(markdownPage.text), `${markdownPath} contains a script element`);

    const pageOg = await request(baseUrl, ogPath);
    assertPng(pageOg, ogPath);
  }

  const unknownMarkdown = await request(baseUrl, '/docs/not-a-page.md');
  assert(unknownMarkdown.response.status === 404, 'unknown Markdown route did not return 404');

  const unknownNegotiated = await request(baseUrl, '/docs/not-a-page', {
    headers: { Accept: 'text/markdown' },
  });
  assert(
    unknownNegotiated.response.status === 404,
    'unknown negotiated Markdown route did not return 404',
  );

  const unknownOg = await request(baseUrl, '/og/docs/not-a-page/image.png');
  assert(unknownOg.response.status === 404, 'unknown OG route did not return 404');

  const encodedUnknownOg = await request(baseUrl, '/og/docs/not%20a%20page/image.png');
  assert(encodedUnknownOg.response.status === 404, 'encoded unknown OG route did not return 404');

  console.log(
    `docs smoke: homepage, search, AI output, and ${documentationRoutes.length} documentation routes passed`,
  );
} catch (error) {
  console.error(`docs smoke: ${error.message}`);
  if (logs.trim()) console.error(logs.trim());
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 4_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
