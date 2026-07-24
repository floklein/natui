export const siteName = 'NatUI';
export const siteTitle = 'Real native UI. Written in React.';
export const siteDescription =
  'Build real SwiftUI and WinUI 3 desktop interfaces with React and TypeScript.';

const configuredSiteUrl = process.env.SITE_URL?.trim();

export const siteUrl = new URL(configuredSiteUrl || 'http://localhost:3000');

if (
  !['http:', 'https:'].includes(siteUrl.protocol) ||
  siteUrl.username ||
  siteUrl.password ||
  siteUrl.pathname !== '/' ||
  siteUrl.search ||
  siteUrl.hash
) {
  throw new Error('SITE_URL must be an HTTP or HTTPS origin without a path, query, or hash.');
}

const hostedBuild =
  process.env.DOCS_PUBLIC_BUILD === '1' ||
  process.env.VERCEL === '1' ||
  process.env.CF_PAGES === '1' ||
  process.env.NETLIFY === 'true';

const localHostname =
  siteUrl.hostname === 'localhost' ||
  siteUrl.hostname.endsWith('.localhost') ||
  siteUrl.hostname === '127.0.0.1' ||
  siteUrl.hostname === '[::1]';

if (hostedBuild && localHostname) {
  throw new Error('SITE_URL must be a public origin for a hosted documentation build.');
}

export function absoluteUrl(pathname: string): string {
  return new URL(pathname, siteUrl).toString();
}

export function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
