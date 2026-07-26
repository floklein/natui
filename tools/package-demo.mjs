#!/usr/bin/env node

import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMacIcon,
  createWindowsIcon,
} from '../packages/create-natui-app/src/icons.mjs';
import {
  packageApplication,
  prepareContainedDirectory,
  resolveContainedWritePath,
} from './package-app.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const demoDirectory = path.join(repoRoot, 'examples', 'demo');
const configPath = path.join(demoDirectory, 'natui.app.json');

export async function writeDemoIcons({
  repositoryDirectory = repoRoot,
  applicationDirectory = demoDirectory,
} = {}) {
  const resolvedRepository = await realpath(repositoryDirectory);
  const resolvedApplication = await prepareContainedDirectory(
    resolvedRepository,
    applicationDirectory,
    'demo application directory',
  );
  const iconDirectory = await prepareContainedDirectory(
    resolvedApplication,
    path.join(resolvedApplication, '.natui', 'icons'),
    'generated icon directory',
  );
  const icons = [
    ['AppIcon.icns', createMacIcon()],
    ['AppIcon.ico', createWindowsIcon()],
  ];
  const destinations = await Promise.all(icons.map(([name]) => (
    resolveContainedWritePath(
      resolvedApplication,
      path.join(iconDirectory, name),
      `generated icon ${name}`,
    )
  )));
  await Promise.all(icons.map(([, bytes], index) => writeFile(destinations[index], bytes)));
}

export async function packageDemo() {
  await writeDemoIcons();
  return packageApplication({ configPath });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageDemo();
    console.log(`NatUI demo application bundle: ${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
