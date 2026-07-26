#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMacIcon,
  createWindowsIcon,
} from '../packages/create-natui-app/src/icons.mjs';
import { packageApplication } from './package-app.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const demoDirectory = path.join(repoRoot, 'examples', 'demo');
const iconDirectory = path.join(demoDirectory, '.natui', 'icons');
const configPath = path.join(demoDirectory, 'natui.app.json');

export async function packageDemo() {
  await mkdir(iconDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(iconDirectory, 'AppIcon.icns'), createMacIcon()),
    writeFile(path.join(iconDirectory, 'AppIcon.ico'), createWindowsIcon()),
  ]);
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
