# natui Windows host (WinUI 3)

Native Windows host for the natui wire protocol v1 (see `docs/protocol.md`).
It is the WinUI 3 counterpart of `hosts/macos`: the JS renderer spawns this
exe, writes NDJSON ops to its stdin, and reads events from its stdout.

Important: this host was written on macOS and has never been compiled or run.
The protocol logic mirrors the Swift host closely, but expect a short
touch-up pass on a Windows machine (see the checklist at the bottom).

## Layout

| file | contents |
|---|---|
| `Program.cs` | custom `Main`, code-only `App`, window shell, stdin reader thread, `Router` |
| `Ipc.cs` | locked NDJSON stdout writer (`ready`, `event`, `window`, `tree`, `shot` with optional `error`), stderr logging |
| `NodeStore.cs` | node registry and op interpreter (same semantics as the Swift `Store.apply`), `UserEdit` |
| `NodeMapper.cs` | node to `FrameworkElement` mapping, prop application, label refresh, events, `NatuiStack` |

## Build

Requires the .NET 8 SDK on Windows 10 1809+ (Windows 11 recommended for the
Segoe Fluent Icons font). No Visual Studio needed:

```
cd hosts\windows\NatuiHost
dotnet build
```

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

## Run

Run the demo from the repo root (the host is found automatically once built):

```
pnpm install
pnpm demo
```

(`pnpm demo` is the root script; it builds the natui package and runs the
`natui-demo` example via `pnpm --filter natui-demo dev`.)

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
- Stdio is the only transport; stdout carries protocol messages exclusively
  and all diagnostics go to stderr (there is no `log` message type). Unknown
  inbound message types are noted on stderr and ignored.

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
- Button/Toggle labels: pure `#text` children collapse to a plain string;
  mixed labels like `<Button><Image/> Delete</Button>` render every child in
  document order in a horizontal stack (spacing 4), `#text` children as
  inline text, exactly like the macOS host's `labelContent`.
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

## Known gaps and deliberate divergences

- `window.minWidth`/`minHeight` use
  `OverlappedPresenter.PreferredMinimumWidth/Height` (WASDK 1.7), which
  constrains the whole window frame rather than the client area; the macOS
  host constrains the content size, so the effective minimum differs by the
  title-bar height.
- Mixed element children inside `Text` (e.g. `<Text>Total: <Image/></Text>`)
  are dropped; only the `#text` parts render. The macOS host renders them
  inline. Button/Toggle mixed labels are supported, and bare `#text` children
  of containers (stacks, ScrollView, List) render as plain text like on macOS.
- A `Spacer` inside a `ZStack` has no track to fill (ZStack is a plain Grid
  overlay), so it collapses to zero size instead of expanding the stack the
  way SwiftUI's ZStack proposal does.
- `padding`/`background` on `Image` are not painted (FontIcon carries no box
  properties of its own).
- Button variants `bordered`, `plain`, and `link` all render as the default
  button style; only `prominent` (AccentButtonStyle) is mapped.
- A TextField's `secure` flag is fixed at creation; toggling it later is not
  supported (would need an element swap).
- `color` on containers does not cascade to children (WinUI panels have no
  Foreground); set it on leaf nodes.
- `cornerRadius` on panels rounds the background but does not clip children.
- Stack `spacing` defaults to 8 when the prop is absent, approximating
  SwiftUI's default stack spacing.

## Checklist for the first Windows compile

Things most likely to need touch-up, in rough order of suspicion:

1. csproj shape: `Microsoft.WindowsAppSDK 1.7.*` + `WindowsPackageType=None`
   + self-contained flags. If startup dies with REGDB_E_CLASSNOTREG, check
   that the WASDK payload sits next to the exe.
2. `XamlControlsResources` added in the App constructor (code-only app). If
   controls render unstyled or throw on template application, this is it.
3. `Application.DispatcherShutdownMode = OnExplicitShutdown` in the App
   constructor: verify the property exists at that point (it is settable on
   Application in WASDK 1.4+).
4. `AppWindow.ResizeClient` + `XamlRoot.RasterizationScale` DPI math in
   `Router.ConfigureWindow`, and `DisplayArea`-based centering.
5. `RenderTargetBitmap`/`BitmapEncoder` screenshot path in an unpackaged app,
   including the `DataReader` buffer copies.
6. Theme resource lookups by string key: `AccentButtonStyle`,
   `TextFillColorSecondaryBrush`, `SymbolThemeFontFamily`,
   `ApplicationPageBackgroundThemeBrush`. All are wrapped in try/catch with
   fallbacks, but confirm the keys resolve.
7. Echo suppression under fast typing: type quickly in the demo TextField and
   confirm no character loss or caret jumps (exercises seq/ack plus the
   TextChanged double-guard).
8. `NatuiStack` layout against the macOS screenshots: Spacer pushing content,
   the Slider row filling the window width, ListView rows stretching
   (ItemContainerStyle), Divider hairlines.
9. The frame-shell layout pass (`EnsureElement`'s Border wrapper +
   `SyncInnerAlignment`): backgrounds hugging padded content inside a larger
   frame, VStack children centered by default (leading at the root), mixed
   Button labels (icon + text) in order, list rows lead-aligned.
10. `OverlappedPresenter.PreferredMinimumWidth/Height` in
    `Router.ConfigureWindow`: confirm the members exist in the resolved WASDK
    1.7 build and that the physical-pixel scaling feels right when resizing
    below `minWidth`/`minHeight`.
11. The `edit` debug round trip: send `{"t":"edit","id":n,"value":"x"}` to a
    TextField node and confirm one `change` event with a `seq`, the control
    repainting, and no echo loop.
12. Segoe Fluent glyph codepoints in `NodeMapper.Glyphs` render as intended
    (they are shared with Segoe MDL2 Assets for Windows 10).
13. Stdout handshake: `{"t":"ready","platform":"windows","protocol":1}` must
    be the first bytes on stdout, no BOM, LF line endings.
