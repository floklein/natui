/**
 * Assert a release tag matches every workspace package version before the
 * Publish workflow makes anything public. `pnpm release:check` validates far
 * more, but it needs an install and a build; this check runs on a bare
 * checkout so the release job can gate `gh release create` on it. Without
 * it, a tag pushed on a mismatched tree publishes host assets no package
 * version can ever resolve, and the release cannot be re-cut for that tag.
 *
 * Usage: node tools/verify-release-tag.mjs <tag>   (e.g. v0.3.0)
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!tag) {
  console.error('verify-release-tag: expected a tag argument, e.g. v0.3.0');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readVersion = (dir) =>
  JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).version;

const version = readVersion('.');
const failures = [];

// Plain X.Y.Z only: prerelease tags would create a "latest" GitHub release
// and then fail release:check anyway, leaving a half-published tag.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  failures.push(
    `package version "${version}" is not plain X.Y.Z; prerelease tags are not supported`,
  );
}
if (tag !== `v${version}`) {
  failures.push(`tag ${tag} does not match the package version (expected v${version})`);
}
for (const dir of ['packages/natui', 'packages/natui-dev', 'packages/create-natui-app']) {
  const packageVersion = readVersion(dir);
  if (packageVersion !== version) {
    failures.push(`${dir}/package.json has ${packageVersion}, expected ${version}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify-release-tag: ${failure}`);
  process.exit(1);
}
console.log(`verify-release-tag: ${tag} matches all package versions`);
