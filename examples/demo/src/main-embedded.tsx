/**
 * Stage 2 entry: this file is bundled with esbuild and evaluated inside
 * JavaScriptCore in the NatUI host process itself. One native process,
 * no Node at runtime.
 *
 * Build + run:
 *   pnpm build:embedded
 *   ../../hosts/macos/.build/release/natui-host --bundle dist/embedded.js
 */
import { runEmbedded } from 'natui/inproc';
import { App } from './App.js';

void runEmbedded(<App />, {
  title: 'NatUI demo (embedded JSC)',
  width: 480,
  height: 620,
  minWidth: 380,
  minHeight: 420,
});
