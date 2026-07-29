/**
 * Build the universal macOS host binary without the Xcode build system.
 * `swift build --arch arm64 --arch x86_64` routes through XCBuild, which
 * rejects SwiftPM's `.swiftLanguageMode(.v5)` under swift-tools-version 6.0
 * ("SWIFT_VERSION '' is unsupported"). Building each architecture with the
 * native SwiftPM build system and merging with lipo produces the same
 * artifact at the same path, so tools/package-host.mjs needs no change.
 *
 * Both the CI rehearsal and the Publish workflow run this script, keeping
 * the two builds identical by construction.
 *
 * Writes hosts/macos/.build/apple/Products/Release/natui-host and prints
 * the path.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRIPLES = ['arm64-apple-macosx', 'x86_64-apple-macosx'];

function run(command, args) {
  // cwd stays at the repo root, matching how pnpm build:host:macos invokes
  // swift build, so the package's relative linker flags resolve the same way.
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: REPO_ROOT });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`build-host-macos-universal: ${command} exited with ${result.status}`);
    process.exit(1);
  }
}

if (process.platform !== 'darwin') {
  console.error('build-host-macos-universal: this script only runs on macOS');
  process.exit(1);
}

const slices = [];
for (const triple of TRIPLES) {
  run('swift', [
    'build',
    '-c',
    'release',
    '--triple',
    triple,
    '--package-path',
    'hosts/macos',
  ]);
  slices.push(join(REPO_ROOT, 'hosts/macos/.build', triple, 'release', 'natui-host'));
}

const output = join(REPO_ROOT, 'hosts/macos/.build/apple/Products/Release/natui-host');
mkdirSync(dirname(output), { recursive: true });
run('lipo', ['-create', ...slices, '-output', output]);
run('lipo', ['-info', output]);
console.log(output);
