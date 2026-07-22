# POC verification

Verified on July 22, 2026 with macOS 27 arm64, Xcode 27.0, Swift 6.4, Node.js 24.14.0, Bun 1.3.14, React 19.2.8, and react-reconciler 0.33.0.

## Automated checks

```text
npm run check
  TypeScript project build: passed
  Vitest: 3 files, 14 tests passed

npm run smoke:controller
  macOS standalone controller: built and executed
  hello frame: received
  initial snapshot: received
  native-style press event: sent
  follow-up React state snapshot: received

npm run smoke:windows-controller
  Windows x64 baseline controller: cross-compiled
  PE executable signature: verified
```

Renderer coverage includes initial commits, context, passive effects, state updates, controlled text input, keyed reordering and stable IDs, stale-handler cleanup, nested prop serialization, cycle rejection, and 100 sequential native events.

## macOS native artifact

Artifact:

```text
build/macos/NatUI Counter.app
```

Verified:

- SwiftUI host compiled and linked for macOS arm64.
- Bundled controller compiled as a macOS arm64 Mach-O executable.
- `Info.plist` passes `plutil -lint`.
- The nested helper and application pass strict deep `codesign --verify`.
- Final local app bundle is about 61 MB.
- The application launches as `dev.natui.counter` with a real SwiftUI accessibility tree.

Interactive checks:

1. Pressing the native increment button changed count from `0` to `1` through React state.
2. Changing the native TextField from `Ada` to `Grace` updated the dependent greeting.
3. Toggling the native checkbox changed its controlled value from on to off.
4. Setting the native Slider to `0.8` updated the text to `80%` and the native ProgressView to `0.8`.

## Windows artifact

Artifact:

```text
build/windows/NatUIHost
```

Verified on macOS:

- The bundled controller is a Windows x86-64 PE executable.
- Generated XAML, project, manifest, and publish-profile XML all parse successfully.
- Generated C# passes Roslyn syntax parsing.
- NuGet restore succeeds for .NET 10 and Windows App SDK 2.2.0.
- Source inspection confirms real `Microsoft.UI.Xaml.Controls` including Button, TextBox, ToggleSwitch, Slider, ProgressBar, Grid, and ScrollViewer.
- The generated folder is about 94 MB, mostly the self-contained controller.

Not verified on this machine:

- WinUI XAML compilation and linking
- Windows launch and interactive event flow
- MSIX packaging or Store signing

Those steps require Windows because Microsoft's XAML compiler and manifest tools are Windows executables.
