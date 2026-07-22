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
| `Ipc.cs` | locked NDJSON stdout writer (`ready`, `event`, `window`, `tree`, `shot`), stderr logging |
| `NodeStore.cs` | node registry and op interpreter (same semantics as the Swift `Store.apply`) |
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
pnpm --filter demo start
```

Launching the exe by double-click shows a hint window and does nothing else
(or exits immediately if the OS reports the invalid stdin handle as
redirected): the protocol channel only exists when stdin/stdout are pipes.

## Design notes

- One inbound NDJSON message becomes exactly one `DispatcherQueue.TryEnqueue`
  hop, so a whole commit batch renders in a single layout pass.
- `NatuiStack` (used for VStack/HStack) is a Grid, not a StackPanel: Spacer
  and `frame: { maxWidth: "infinity" }` need star-sized tracks, which
  StackPanel cannot express. Greediness bubbles up through nested stacks to
  emulate SwiftUI proposing the full parent size down the tree.
- WinUI events fire for programmatic changes too (unlike SwiftUI bindings),
  so every change handler is double-guarded: an `applyingRemote` depth counter
  plus a compare against the stored prop value (TextChanged can arrive on a
  later dispatcher tick, after the counter was released).
- `update` ops honor the protocol's `seq`/`ack` echo suppression and skip
  structurally equal props (`JsonNode.DeepEquals`, .NET 8), exactly like the
  Swift host.
- Toggle maps to CheckBox rather than ToggleSwitch: it is the closest
  analogue of SwiftUI's macOS checkbox toggle (compact, trailing label).
- Text/#text render as a TextBlock inside a Border shell, because TextBlock
  has no Background/CornerRadius.
- The window stays alive after close (`DispatcherShutdownMode =
  OnExplicitShutdown`); JS orchestrates shutdown via `quit`, and stdin EOF is
  treated as "parent died, exit now".

## Known gaps and deliberate divergences

- `window.minWidth`/`minHeight` are ignored (needs
  `OverlappedPresenter.PreferredMinimumWidth/Height` or a WM_GETMINMAXINFO
  hook).
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
9. Segoe Fluent glyph codepoints in `NodeMapper.Glyphs` render as intended
   (they are shared with Segoe MDL2 Assets for Windows 10).
10. Stdout handshake: `{"t":"ready","platform":"windows","protocol":1}` must
    be the first bytes on stdout, no BOM, LF line endings.
