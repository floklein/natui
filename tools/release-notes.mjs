/**
 * Print the CHANGELOG.md section for one version, for the GitHub release the
 * Publish workflow creates. Fails when the section is missing so a release
 * cannot ship without notes.
 *
 * Usage: node tools/release-notes.mjs <version>
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('release-notes: expected a version argument, e.g. 0.3.0');
  process.exit(1);
}

const changelog = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'CHANGELOG.md'),
  'utf8',
);

const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.startsWith(`## ${version},`) || line === `## ${version}`);
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith('## ')) {
    end = i;
    break;
  }
}
console.log(lines.slice(start + 1, end).join('\n').trim());
