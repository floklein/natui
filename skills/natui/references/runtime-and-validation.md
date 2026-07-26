# Runtime and validation

## Start from a compatible checkout

`@natui/core` and `create-natui-app` come from npm, but the native hosts still
require a source checkout. Use Node.js 22 or newer, pnpm 11, and the native
toolchain for the target platform.

```bash
git clone https://github.com/floklein/natui.git
cd natui
corepack enable
pnpm install
pnpm build
```

Build the package before workspace typechecking because workspace examples may
resolve declarations from `packages/natui/dist`.

## Use Node mode for development

Create a Node entrypoint that calls `run`:

```tsx
import { run } from '@natui/core';
import { App } from './App.js';

await run(<App />, {
  title: 'My NatUI app',
  width: 640,
  height: 480,
});
```

Let `run` spawn the native host and communicate through its standard streams.
Do not launch a host separately and expect the renderer to attach.

Build the host for the current platform:

```bash
# macOS
pnpm build:host:macos
```

```powershell
# Windows
dotnet build hosts/windows/NatuiHost -p:Platform=x64
```

The bridge searches known build outputs. Set `NATUI_HOST` to the exact
executable when the desired host is elsewhere or several artifacts exist. Do
not use `dotnet run` as the Windows spawn target because its wrapper breaks the
expected process and standard-stream lifecycle.

Read [source setup](https://natui.dev/docs/start/source-setup.md) and the
[macOS](https://natui.dev/docs/start/macos.md) or
[Windows](https://natui.dev/docs/start/windows.md) guide before changing setup
instructions.

## Use embedded mode for a single native process

Use `@natui/core/components` in UI modules that must bundle without Node.js built-ins.
Call `runEmbedded` from `@natui/core/inproc` in the embedded host bootstrap:

```tsx
import { runEmbedded } from '@natui/core/inproc';
import { App } from './App.js';

await runEmbedded(<App />, {
  title: 'My embedded NatUI app',
  width: 640,
  height: 480,
});
```

Bundle for a browser-like JavaScript target, then pass the bundle to the host
with `--bundle`.

macOS embeds JavaScriptCore and Windows embeds V8. Do not reuse Node-only
imports in the embedded bundle. Read the
[runtime modes guide](https://natui.dev/docs/guides/runtime-modes.md) before
changing bundling or lifecycle code.

## Match validation to the claim

| Validation | What it proves |
| --- | --- |
| `pnpm test` | Renderer, bridge, protocol, and component contracts |
| `pnpm build` | Public package compilation and declarations |
| `pnpm typecheck` | Workspace TypeScript compatibility |
| Native host build | Swift or C# host compilation for the selected target |
| `pnpm verify` | Base application behavior in a real native window |
| `pnpm verify:kitchen` | App shell and multi-component behavior in a real native window |
| `pnpm verify:embedded` | In-process JavaScript runtime behavior |
| `dump()` | Materialized native tree and props |
| `emit()` | Event dispatch through the bridge |
| `edit()` | Optimistic native edit and controlled-state acknowledgement |
| `screenshot()` | Host-rendered visible pixels at a specific moment |

Run the smallest set that fully supports the requested claim. A compile or tree
dump does not prove popup placement, focus, accessibility, or visible pixels.

## Use deterministic debug helpers

Capture the application returned by `run`:

```tsx
const app = await run(<App />);

const tree = await app.dump();
await app.screenshot('/absolute/path/natui-result.png');
app.emit(nodeId, 'press');
app.edit(nodeId, 'new value');
```

Use absolute screenshot paths. Cleanly call `app.quit()` in custom verification
flows. Read [testing and debugging](https://natui.dev/docs/guides/testing-and-debugging.md)
and [verification status](https://natui.dev/docs/status/verification.md) before
describing test coverage.
