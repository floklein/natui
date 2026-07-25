# NatUI

[![CI](https://github.com/floklein/natui/actions/workflows/ci.yml/badge.svg)](https://github.com/floklein/natui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Write React and TypeScript. Get real native desktop UI through SwiftUI on
macOS and WinUI 3 on Windows. There is no webview, Electron runtime, Yoga, or
browser layout engine. The platform owns layout, controls, dark mode, focus,
and accessibility.

> [!IMPORTANT]
> NatUI is still in Alpha and is not a published registry package.
> Use it from a source checkout while packaging and compatibility policies are
> still being designed.

```tsx
import { useState } from 'react';
import { Button, HStack, Text, VStack, run } from 'natui';

function App() {
  const [count, setCount] = useState(0);

  return (
    <VStack spacing={12} padding={20} alignment="leading">
      <Text font="largeTitle" weight="bold">Hello, native</Text>
      <HStack spacing={8}>
        <Button variant="bordered" onPress={() => setCount((value) => value - 1)}>
          −
        </Button>
        <Text font="title2" monospaced>{String(count)}</Text>
        <Button variant="bordered" onPress={() => setCount((value) => value + 1)}>
          +
        </Button>
      </HStack>
    </VStack>
  );
}

await run(<App />, { title: 'my app', width: 480, height: 320 });
```

That `<VStack>` becomes a real SwiftUI `VStack` in an `NSWindow`, or a native
WinUI grid stack on Windows. React 19 still owns state, keys, effects,
conditional rendering, and reconciliation.

<p align="center">
  <img src="screenshots/03-final.png" width="480" alt="The NatUI demo running as native SwiftUI in dark mode">
</p>

## Quick start from source

Shared prerequisites:

- Git
- Node.js 22 or newer
- pnpm 11

Clone the repository and install the workspace:

```bash
git clone https://github.com/floklein/natui.git
cd natui
corepack enable
pnpm install
pnpm build
```

### macOS

Requires macOS 14 or newer and Xcode command line tools with a Swift 6
toolchain.

```bash
pnpm build:host:macos
pnpm demo
```

### Windows

Requires Windows 10 1809 or newer and the .NET 8 SDK. Windows 11 is
recommended.

```powershell
dotnet build hosts/windows/NatuiHost -p:Platform=x64
pnpm demo
```

The JavaScript side locates the built host automatically. Set `NATUI_HOST` to
an explicit executable path when using a different build location. See the
[Windows host guide](hosts/windows/NatuiHost/README.md) for ARM builds,
troubleshooting, and current platform differences.

## Documentation

- [Set up AI agents](docs/content/docs/agents.mdx)
- [Get started](docs/content/docs/start/index.mdx)
- [Browse all 37 components](docs/content/docs/components/index.mdx)
- [Read the guides](docs/content/docs/guides/index.mdx)
- [Explore the API](docs/content/docs/api/index.mdx)
- [Review platform support](docs/content/docs/status/platform-support.mdx)
- [See the roadmap](docs/content/docs/status/roadmap.mdx)

Run the documentation site locally:

```bash
pnpm docs:dev
```

Validate its links, examples, component coverage, production build, and smoke
tests with:

```bash
pnpm docs:check
pnpm docs:build
pnpm docs:smoke
```

## How it works

```text
React 19 ── react-reconciler 0.33 ── shadow tree ── NDJSON ops ──► native host
                                                    ◄── events ──  SwiftUI / WinUI 3
```

A custom React reconciler batches each commit into one atomic operation batch.
It streams that batch to a focused native host process, which materializes the
tree with the platform's declarative UI framework. Events stream back at
React's interactive priorities.

Controlled inputs use protocol-level sequence acknowledgements to suppress
stale echoes, so optimistic native edits remain responsive even when the
JavaScript process is delayed.

Read the [architecture guide](docs/content/docs/internals/architecture.mdx)
and [wire protocol](docs/content/docs/internals/protocol.mdx) for the full
design.

## Components

The current public surface contains 37 typed host components:

- Layout: `VStack`, `HStack`, `ZStack`, `Spacer`, `Divider`, `ScrollView`,
  `List`, `Section`
- Content: `Text`, `Label`, `Image`, `ProgressView`, `Link`
- Inputs: `Button`, `TextField`, `TextEditor`, `SearchField`, `Toggle`,
  `Slider`, `Stepper`, `Picker`, `DatePicker`, `DisclosureGroup`
- App shell and navigation: `SplitView`, `Sidebar`, `Detail`, `TabView`, `Tab`,
  `MenuBar`, `Toolbar`
- Menus and data: `Menu`, `ContextMenu`, `Table`
- Presentation: `Sheet`, `Alert`, `Popover`, `PopoverContent`

Common props include selection tags, badges, and accessibility metadata such
as `accessibilityLabel`, `accessibilityHint`, and
`accessibilityIdentifier`. See the [component
catalog](docs/content/docs/components/index.mdx) for props, examples, and
platform notes.

## Runtime modes

The default development mode runs React in Node.js and communicates with the
native host over standard input and output.

Both hosts can also evaluate a bundled React application in-process. macOS
uses JavaScriptCore and Windows uses V8. The application is then one native
process with no Node.js runtime:

```bash
pnpm build
cd examples/demo
pnpm build:embedded
# macOS
../../hosts/macos/.build/release/natui-host --bundle dist/embedded.js
```

```powershell
# Windows
..\..\hosts\windows\NatuiHost\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe --bundle dist\embedded.js
```

Read the [runtime modes guide](docs/content/docs/guides/runtime-modes.mdx) for
the lifecycle and packaging tradeoffs.

## Examples and verification

`examples/demo` is the smallest end-to-end application.
`examples/kitchen-sink` is a small project manager that exercises the app
shell and most component kinds.

| Command | Purpose |
|---|---|
| `pnpm demo` | Build the package and open the base native demo |
| `pnpm verify` | Drive the base demo through native tree dumps, edits, and screenshots |
| `pnpm verify:kitchen` | Verify app-shell and multi-component workflows |
| `pnpm verify:embedded` | Verify the platform's in-process JavaScript runtime |
| `pnpm test` | Run renderer, bridge, protocol, and component contract tests |
| `pnpm typecheck` | Typecheck all workspace projects |
| `pnpm build` | Build the public `natui` package |

The real-window suites validate native tree state, interactions, controlled
input behavior, and host-rendered PNG files. They complement the contract
suite but are not a complete visual or accessibility audit. See
[verification status](docs/content/docs/status/verification.mdx) for the
exact coverage and evidence limits.

## Platform status

| Capability | macOS | Windows |
|---|---|---|
| Native toolkit | SwiftUI | WinUI 3 |
| Base demo | Real-window verified | Real-window verified |
| Kitchen-sink app shell | Real-window verified | Real-window verified |
| Host build in CI | Yes | Yes |
| Embedded JavaScript runtime | JavaScriptCore, verified | V8, verified |

Both embedded runtimes use the same `natui/inproc` entry point and `--bundle`
host argument. Both hosts implement all 37 public components. Component docs
define the shared contract and call out platform-native conventions. GUI suites
remain local because CI has no normal window session.

## Package entry points

The workspace exposes:

- `natui` for components, `run`, and advanced protocol exports
- `natui/components` for component-only bundles without Node.js built-ins
- `natui/inproc` for the embedded host entry point

## License

MIT, see [LICENSE](LICENSE).
