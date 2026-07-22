/**
 * Live dev loop: keeps the native window open and swaps the React tree
 * whenever a source file changes. State resets on reload (like a browser
 * refresh) but the window, size, and position survive.
 *
 * Run: pnpm dev:watch
 */
import { watch } from 'node:fs';
import { createElement } from 'react';
import { run } from 'natui';
import { App } from './App.js';

const app = await run(<App />, {
  title: 'natui demo (dev)',
  width: 480,
  height: 620,
  minWidth: 380,
  minHeight: 420,
});

console.error('[dev] mounted; watching for changes…');

const srcDir = new URL('.', import.meta.url).pathname;
let generation = 0;
let reloading = false;

watch(srcDir, { recursive: true }, (_event, filename) => {
  if (!filename || !/\.(tsx?|jsx?)$/.test(filename) || /(^|\/)(dev|verify)\.tsx$/.test(filename)) return;
  if (reloading) return;
  reloading = true;
  // fs.watch fires in bursts while editors write; coalesce.
  setTimeout(async () => {
    reloading = false;
    generation += 1;
    try {
      // Cache-busted re-import re-evaluates App.tsx itself; its transitive
      // imports may still come from the loader cache (good enough for a
      // remount loop; react-refresh-style reload is out of scope).
      const fresh = (await import(`./App.js?gen=${generation}`)) as { App: React.FC };
      app.update(createElement(fresh.App));
      console.error(`[dev] reloaded (#${generation}: ${filename})`);
    } catch (err) {
      console.error(`[dev] reload failed, keeping previous tree:`, err);
    }
  }, 80);
});
