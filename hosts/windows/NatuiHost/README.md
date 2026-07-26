# NatUI Windows host (WinUI 3)

Native Windows host for the NatUI wire protocol v1 (see `docs/protocol.md`).
It is the WinUI 3 counterpart of `hosts/macos`: the JS renderer spawns this
exe, writes NDJSON ops to its stdin, and reads events from its stdout.

Status: the base host is compiled and verified on Windows 11 (.NET SDK 9
building net8.0-windows). The full E2E suite (`pnpm verify`)
passes against the real WinUI 3 window: tree dumps, button presses,
optimistic edits with native seq/ack, screenshots, and the controlled-input
stress phase. See "First Windows compile: findings" at the bottom for what
the initial pass fixed. The app-shell suite and embedded V8 runtime are also
verified locally against real windows.

## Layout

| file | contents |
|---|---|
| `Program.cs` | custom `Main`, code-only `App`, window shell, stdin reader thread, `Router` |
| `EmbeddedJsHost.cs` | in-process V8 runtime, host callbacks, timers, and `@natui/core/inproc` bridge |
| `Ipc.cs` | locked NDJSON stdout writer (`ready`, `event`, `window`, `tree`, `shot` with optional `error`), stderr logging |
| `NodeStore.cs` | node registry and op interpreter (same semantics as the Swift `Store.apply`), `UserEdit` |
| `NodeMapper.cs` | node to `FrameworkElement` mapping, prop application, label refresh, events, `NatuiStack` |
| `NodeMapper.Menus.cs` | MenuBar, Toolbar (CommandBar), Menu, ContextMenu, shared `MenuItemSpec` builder, shortcut parsing, command roles |
| `NodeMapper.Overlays.cs` | Sheet and Alert (ContentDialog), Popover (Flyout) |
| `NodeMapper.Structure.cs` | SplitView + Sidebar/Detail slots, TabView/Tab, Section, Table, DisclosureGroup, List/Table selection |
| `NodeMapper.Inputs.cs` | SearchField, DatePicker, Stepper, TextEditor, Link, Label, segmented/radio Picker styles |

## Build

Requires the .NET 8 SDK on Windows 10 1809+ (Windows 11 recommended for the
Segoe Fluent Icons font). The minimum Windows App SDK is 1.8; the exact
package version the host builds against lives in `NatuiHost.csproj`. No
Visual Studio needed:

```
cd hosts\windows\NatuiHost
dotnet build
```

The local `NuGet.config` pins nuget.org as a package source: machines that
only have the "Microsoft Visual Studio Offline Packages" feed configured
cannot restore the WASDK packages without it.

The project is unpackaged (`WindowsPackageType=None`) and self-contained
(`WindowsAppSDKSelfContained` + `SelfContained`), so the output exe runs with
zero machine prerequisites. The first build downloads the Windows App SDK
runtime payload, which takes a while.

Depending on how MSBuild resolves the platform, the exe lands in one of:

```
bin\Debug\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe
bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe
```

Both paths (plus the `bin\Release\...` variant of the first) are probed by the
JS side (`packages/natui/src/bridge/locate.ts`). For anything else, point the
renderer at the exe explicitly:

```
:: cmd
set NATUI_HOST=C:\path\to\NatuiHost.exe

# PowerShell
$env:NATUI_HOST = "C:\path\to\NatuiHost.exe"
```

If `dotnet build` complains about AnyCPU, pass the platform explicitly:
`dotnet build -p:Platform=x64`. For ARM machines:
`dotnet build -p:Platform=arm64 -p:RuntimeIdentifier=win-arm64`.

Do not use `dotnet run` as the spawn target; it inserts a wrapper process
between Node and the app, which breaks kill/EOF semantics.

## Test

```
dotnet test hosts\windows\NatuiHost.Tests -c Release -p:Platform=x64
```

`NatuiHost.Tests` (xunit) covers the host logic that runs without a XAML
runtime: the `seq`/`ack` echo-suppression rule, `NodeStore` remove/clear
bookkeeping, and protocol color parsing. WinUI types *load* in a plain test
host but cannot be *activated* there, so anything that constructs a control
stays covered by the E2E suites instead. `NodeStore` talks to the mapper
through `INodeMapper` for exactly that reason.

## Run

Run the demo from the repo root (the host is found automatically once built):

```
pnpm install
pnpm demo
```

`pnpm demo` is the root development-server script. It builds the `natui`
package, runs `natui-demo`, and applies React Fast Refresh after source edits.
Use `pnpm demo:start` for a one-shot launch without watching.

The host can also evaluate the browser bundle in-process with V8:

```
pnpm build
pnpm --filter natui-demo build:embedded
hosts\windows\NatuiHost\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe --bundle examples\demo\dist\embedded.js
```

Launching the exe by double-click shows a hint window and does nothing else
(or exits immediately if the OS reports the invalid stdin handle as
redirected): the protocol channel only exists when stdin/stdout are pipes.

## Protocol notes

- The debug channel implements `dump`, `screenshot`, `emit`, and `edit`.
  `edit` (`{"t":"edit","id":n,"value":...}`) performs a real optimistic user
  edit through the same code path as typing/toggling/dragging
  (`NatuiNode.UserEdit`: local value write, per-node seq bump, `change` event
  carrying `seq`), so automated tests exercise the seq/ack machinery end to
  end. Unknown node ids are logged to stderr and ignored.
- `screenshot` always replies: `{"t":"shot","path":...}` on success,
  `{"t":"shot","path":...,"error":"reason"}` on any failure (no window,
  render or write failure), with no file written on failure.
- Accessibility props map to UIA: `accessibilityLabel` →
  `AutomationProperties.Name`, `accessibilityHint` →
  `AutomationProperties.HelpText`, `accessibilityIdentifier` →
  `AutomationProperties.AutomationId` (set on the element that produces the
  automation peer, e.g. the inner control or TextBlock).
- In Node mode, stdout carries protocol messages exclusively and all
  diagnostics go to stderr. Embedded mode mirrors those messages through
  `__natui_send` and `__natui_recv`, while redirected standard streams remain
  available as a verification channel. Unknown inbound message types are
  noted on stderr and ignored.

## Design notes

- One inbound NDJSON message becomes exactly one `DispatcherQueue.TryEnqueue`
  hop, so a whole commit batch renders in a single layout pass.
- `NatuiStack` (used for VStack/HStack) is a Grid, not a StackPanel: Spacer
  and `frame: { maxWidth: "infinity" }` need star-sized tracks, which
  StackPanel cannot express. Greediness bubbles up through nested stacks to
  emulate SwiftUI proposing the full parent size down the tree.
- Every node element is a Border "frame shell" with the kind-specific element
  inside. The frame props size the shell; padding, background, and
  cornerRadius shape the inner box. This reproduces the macOS modifier order
  (padding → background → cornerRadius clip → frame): a background fills the
  padded bounds and never bleeds into frame-added space. Inside the shell,
  greedy kinds stretch and everything else centers (SwiftUI's default frame
  alignment); List rows lead-align.
- Stack cross-alignment defaults to center on both axes, like SwiftUI stacks;
  `alignment: leading/center/trailing` (VStack) and `top/center/bottom`
  (HStack) map to the children's cross-axis alignment. The root container
  mirrors the macOS RootView (`VStack(alignment: .leading, spacing: 0)`).
- Text, Button, and Toggle labels preserve mixed text and element children in
  document order. Button and Toggle use a horizontal stack with spacing 4.
- WinUI events fire for programmatic changes too (unlike SwiftUI bindings),
  so every change handler is double-guarded: an `applyingRemote` depth counter
  plus a compare against the stored prop value (TextChanged can arrive on a
  later dispatcher tick, after the counter was released).
- `update` ops honor the protocol's `seq`/`ack` echo suppression and skip
  structurally equal props (`JsonNode.DeepEquals`, .NET 8), exactly like the
  Swift host.
- Toggle maps to CheckBox rather than ToggleSwitch: it is the closest
  analogue of SwiftUI's macOS checkbox toggle (compact, trailing label).
- Text/#text render as a TextBlock inside a Border box (the node's inner
  element), because TextBlock has no Background/CornerRadius.
- The window stays alive after close (`DispatcherShutdownMode =
  OnExplicitShutdown`); JS orchestrates shutdown via `quit`, and stdin EOF is
  treated as "parent died, exit now".

## App-shell kinds (kitchen-sink expansion)

The `NodeMapper.*.cs` partials add the ~22 app-shell kinds of protocol v1:
MenuBar, Toolbar, Menu, ContextMenu, SplitView (+ Sidebar/Detail), TabView/
Tab, Sheet, Alert, Popover (+ PopoverContent), Section, Table, DisclosureGroup,
SearchField, DatePicker, Stepper, TextEditor, Link, Label, and the segmented/
radioGroup Picker styles, plus List/Table selection and Table sort requests.

Status: the blocking `windows-host` CI job compile-checks this expansion, and
`pnpm verify:kitchen` passes locally against a real WinUI 3 window.

### Host implementation notes

- Toolbar items before and after `flexibleSpace` use the CommandBar left and
  right regions. Stable updates patch controls in place so search text and
  focus survive.
- DatePicker uses native date, time, or paired date-time controls and preserves
  the protocol's canonical local ISO forms.
- Direct and sectioned List rows share controlled selection and badge support.
- Toggle and Picker styles, TextField secure mode, and DatePicker component
  modes can swap the inner native control while keeping the React node stable.
- Sheets and alerts use ContentDialog popup layers. Popovers and menus use
  flyouts, so open popup content is outside RenderTargetBitmap screenshots.
- MenuBar and Toolbar hoist into the chrome row at creation, wherever they sit
  in the tree. Portable apps keep them at the root as the public API requires.
- SplitView supplies a native visibility button, emits controlled changes, and
  clamps its pane to the requested minimum and maximum widths.
- Alert keeps every action, maps cancel to native close and Escape behavior,
  and applies critical styling to destructive actions.
- A Menu label supports `#text` children (joined), a `systemImage` icon, or
  both (icon then text). Element children inside a Menu label are ignored.
- Table header buttons use native FontIcon sort chevrons.
- ZStack propagates flexible-space proposals, Image has a paintable box,
  container foreground color cascades, and rounded panels clip children.
- Button variants map to the corresponding native WinUI styles.

## Known gaps and deliberate divergences

- `window.minWidth`/`minHeight` use
  `OverlappedPresenter.PreferredMinimumWidth/Height`, which
  constrains the whole window frame rather than the client area; the macOS
  host constrains the content size, so the effective minimum differs by the
  title-bar height.
- Stack `spacing` defaults to 8 when the prop is absent, approximating
  SwiftUI's default stack spacing.

## First Windows compile: findings

What the first pass on a real Windows machine actually had to fix
(2026-07). The protocol logic itself needed no changes; every issue was
XAML/tooling bootstrap:

1. Two compile errors: `Application.Start(_ => { _ = new App(); })` assigns
   to the lambda *parameter* named `_` (CS0029), and `Colors.Red` needed the
   `Microsoft.UI.Colors` qualifier.
2. `Application.Resources` and `DispatcherShutdownMode` are NOT usable in the
   App constructor of a code-only app: the underlying COM object finishes
   initializing only after `Application.Start`'s callback returns, and
   touching them earlier throws E_UNEXPECTED (0x8000FFFF) as a silent
   0xC000027B stowed-exception crash. Both moved to `OnLaunched`.
3. A code-only project generates no `resources.pri`, and the WASDK
   self-contained targets deliberately do not copy the framework's own
   (`Microsoft.WindowsAppSDK.SelfContained.targets` deletes it). Without one,
   every `ms-appx:///` lookup fails and `XamlControlsResources` throws
   "Cannot locate resource from
   'ms-appx:///Microsoft.UI.Xaml/Themes/themeresources.xaml'". Fixed with
   `<AppxGeneratePriEnabled>true</AppxGeneratePriEnabled>` in the csproj
   (PRI generation is otherwise skipped for projects with no XAML items).
4. The App class must implement `IXamlMetadataProvider` (delegating to
   `XamlControlsXamlMetaDataProvider`): the XAML compiler normally generates
   this from App.xaml, and without it `XamlControlsResources` activation
   fails with "Cannot find a resource with the given key:
   AcrylicBackgroundFillColorDefaultBrush".
5. Unhandled-exception hooks (AppDomain + `Application.UnhandledException`)
   now route startup failures to stderr; a WinExe otherwise dies invisibly
   with exit code 0xC000027B and nothing in the event log.
6. `atom` (the demo's logo) has no Segoe Fluent Icons counterpart; mapped to
   E950 "Component". The other glyph codepoints render as intended.

Verified working, via `pnpm verify` (full E2E against the real window) plus
manual passes: the stdout handshake (first bytes, no BOM, LF endings), the
`edit`/`emit`/`dump` debug round trips, native seq/ack echo suppression and
enforcement under the stress phase, `RenderTargetBitmap` screenshots (and the
error reply on an unwritable path), DPI-scaled `ResizeClient` + centering,
Spacer/star-track layout, ListView row stretching, Divider hairlines, and
theme resource lookups by string key.

`smoke.mjs` in this directory is a dependency-free host-only check
(handshake, one commit, dump, screenshot, quit) that is handy when the host
dies before the JS renderer sees it: `node smoke.mjs` after a debug build.
