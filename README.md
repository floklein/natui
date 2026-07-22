# NatUI

NatUI is an experimental React renderer for native desktop apps. You write ordinary React components in TypeScript, then NatUI packages the same app logic with a SwiftUI host for macOS and a WinUI 3 host for Windows.

The rendered controls are native. There is no DOM, browser window, HTML, or CSS layer.

```tsx
import { Button, HStack, Text, VStack, Window, useState } from "@natui/core";

export default function Counter() {
  const [count, setCount] = useState(0);

  return (
    <Window title="Counter" width={420} height={280}>
      <VStack padding={24} spacing={16}>
        <Text fontSize={36} fontWeight="bold">{count}</Text>
        <HStack spacing={12}>
          <Button title="Decrement" onPress={() => setCount((n) => n - 1)} />
          <Button title="Increment" onPress={() => setCount((n) => n + 1)} />
        </HStack>
      </VStack>
    </Window>
  );
}
```

## What the POC proves

- Normal React function components and composition work.
- React hooks, context, effects, memoization, closures, and keyed reconciliation stay in JavaScript.
- Each React commit becomes one immutable, versioned native tree snapshot.
- SwiftUI and WinUI construct platform controls from that snapshot.
- Native events cross back to React through stable handler tokens.
- Bun packages the controller as standalone macOS and Windows executables.
- The macOS app is compiled and locally signed by the CLI.
- A complete WinUI 3 C# project is generated from macOS, ready to compile on Windows.

## Quick start

Requirements for the full macOS build:

- Node.js 22 or later
- Bun 1.3 or later
- Xcode with Swift 6

```bash
npm install
npm run doctor
npm run check
npm run build:poc
```

Artifacts are written to:

```text
build/macos/NatUI Counter.app
build/windows/NatUIHost
```

Open the macOS POC:

```bash
open "build/macos/NatUI Counter.app"
```

On Windows, from the generated project directory:

```powershell
dotnet build NatUIHost.csproj -c Release
dotnet run --project NatUIHost.csproj
```

The WinUI host requires Windows 10 1809 or later, the .NET 10 SDK, Developer Mode, and the Windows application development workload.

## Commands

```text
natui build macos
natui build windows
natui build all
natui build all --config natui.config.json --out-dir build
natui doctor
```

The root `natui.config.json` points to the included counter example. It also defines the product name, bundle identifier, native window size, target versions, and Windows architecture.

## Native component set

The POC currently includes:

- `Window`
- `VStack`, `HStack`, and `ZStack`
- `Text`
- `Button`
- `TextField`
- `Toggle`
- `Slider`
- `Image`
- `ScrollView`
- `Progress`
- `Spacer` and `Divider`
- `NativeView` as a future extension point

Shared modifiers include spacing, alignment, padding, frame constraints, foreground and background colors, corner radius, opacity, disabled state, visibility, and accessibility labels.

## Architecture

```text
React TypeScript
      |
      v
react-reconciler shadow tree
      |
      v
versioned NDJSON snapshots and events
      |
      +----------------------+
      |                      |
      v                      v
SwiftUI host            WinUI 3 host
macOS native UI         Windows native UI
```

The controller is currently a bundled Bun sidecar. That is the fastest credible way to preserve complete JavaScript and React behavior while proving both native rendering targets. The protocol is engine-neutral, so a production implementation can embed a smaller runtime without changing application code.

Read [Architecture](docs/ARCHITECTURE.md), [research and alternatives](docs/RESEARCH.md), the [verified POC results](docs/VERIFICATION.md), and the [roadmap](docs/ROADMAP.md) for the tradeoffs and next steps.

## Honest POC boundaries

This is not production-ready yet.

- Native host application happens asynchronously after the React commit.
- Synchronous layout measurement and imperative native refs are not supported.
- A full tree snapshot is sent after each commit. Incremental native patches are a later optimization.
- The Bun helper adds roughly 60 MB before compression.
- macOS currently builds for the host architecture, not as a universal binary.
- WinUI source generation is verified on macOS, but a Windows machine or CI runner is required for native compilation and interaction testing.
- The native component and modifier surface is intentionally small.
- Native modules, navigation, menus, lists with virtualization, assets, persistence, and Fast Refresh still need formal APIs.

## Project layout

```text
packages/core       Typed React components and shared props
packages/runtime    React reconciler, shadow tree, protocol, controller
packages/cli        Bundling, native source generation, and packaging
examples/counter    End-to-end interactive example
docs                Architecture, research, and roadmap
```

## Development

```bash
npm run typecheck
npm test
npm run build
npm run build:poc
```

`react` and `react-reconciler` are pinned exactly because the custom renderer API is experimental and can change between releases.

## License

MIT
