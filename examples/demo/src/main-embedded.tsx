/**
 * Stage 2 entry: this file is bundled with esbuild and evaluated inside
 * the native host's JavaScript engine in the NatUI process itself. One native
 * process, no Node at runtime.
 *
 * Build + run:
 *   pnpm build:embedded
 *   ../../hosts/macos/.build/release/natui-host --bundle dist/embedded.js
 *   ..\..\hosts\windows\NatuiHost\bin\Release\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe --bundle dist\embedded.js
 */
import { runEmbedded } from 'natui/inproc';
import { App } from './App.js';

void runEmbedded(
  <App />,
  {
    title: 'NatUI demo (embedded JS)',
    width: 480,
    height: 620,
    minWidth: 380,
    minHeight: 420,
  },
).catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
