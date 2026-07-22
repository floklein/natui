# natui architecture

```
┌─────────────────────────── Node process ───────────────────────────┐
│                                                                     │
│  Your app (React TSX)                                               │
│    <VStack><Text>…</Text><Button onPress={…}>…</Button></VStack>    │
│           │                                                         │
│           ▼                                                         │
│  react-reconciler (0.33, React 19)                                  │
│    custom host config → shadow tree of plain JS nodes               │
│    mutations buffered per commit, flushed in resetAfterCommit       │
│           │                              ▲                          │
│           ▼ ops (NDJSON)                 │ events (NDJSON)          │
│  Transport (stdio)                       │                          │
└───────────┼──────────────────────────────┼──────────────────────────┘
            ▼                              │
┌─────────────────────────── native host ──┴──────────────────────────┐
│  macOS: Swift + SwiftUI          │  Windows: C# + WinUI 3           │
│  per-node @Observable class      │  node registry + control map     │
│  recursive NodeView switch       │  NatuiStack(Grid) + controls     │
│  SwiftUI layout (VStack/HStack)  │  WinUI layout (Grid/StackPanel)  │
└──────────────────────────────────┴──────────────────────────────────┘
```

## The core bet: no Yoga, native layout owns everything

React Native (including react-native-macos/-windows) runs Yoga flexbox layout in
its own engine and positions native views absolutely. That impedance mismatch is
exactly why react-native-windows abandoned XAML as its host tree for the New
Architecture: XAML's layout, focus, and accessibility kept fighting a foreign
layout system.

natui inverts this: the React tree maps 1:1 onto the platform's own declarative
primitives (`VStack` → SwiftUI `VStack`, → WinUI Grid column stack). The host
platform does all layout, theming, accessibility, and animation. This is the same
philosophy as `@expo/ui` (React props driving real SwiftUI), extended to the
whole app and to two desktop platforms.

What we give up: pixel-identical layout across platforms and the CSS-ish styling
of RN. What we get: honest native look/behavior, dark mode, focus rings,
accessibility, and dramatically smaller native hosts (~1k lines each; the
proton-native post-mortem says keeping this surface tiny is existential).

## The reconciler (packages/natui)

- react-reconciler **mutation mode** with a JS-side shadow tree. Instances are
  plain objects `{id, kind, props, handlers, children, created}`.
- Render-phase methods (`createInstance`, `appendInitialChild`) only build the
  shadow tree, instances may be discarded before commit. Ops are emitted in
  commit-phase methods only, when a node attaches to an attached parent
  (`materialize` serializes the whole subtree at that moment).
- All ops from one React commit are buffered and flushed as **one atomic
  `commit` message** in `resetAfterCommit`, the host applies them in a single
  UI-thread hop, so SwiftUI/WinUI render once per React commit.
- Event handler props (functions) never cross the wire: they're stripped into a
  local registry; hosts always emit interaction events, JS dispatches to the
  handler if registered.
- Every other prop is **validated and deep-copied** before serialization
  (documented JSON only: strings, finite numbers, booleans, null, arrays and
  plain objects). Invalid values are reported with node kind and prop path and
  omitted; a commit batch is all-or-nothing, so the native tree can never see
  a partially applied commit.
- Host events run at `DiscreteEventPriority` and are flushed synchronously
  (via the update-priority API that replaced `getCurrentEventPriority` in
  React 19 reconcilers). Slider drags are discrete too: drag responsiveness
  comes from the host's optimistic local value plus seq/ack, and the
  synchronous flush is what lets the bridge enforce controlled values right
  after each event.

## Controlled inputs over an async bridge (seq/ack)

The classic failure: a controlled TextField round-trips through JS, and a slow
echo reverts fast typing. natui solves it protocol-level:

- hosts apply **optimistic local writes** and attach a monotonic per-node `seq`
  to change events;
- the JS bridge records the highest processed seq and attaches it as `ack` to
  update ops;
- a host receiving an update with `ack` older than its local counter keeps its
  local `value` (user kept typing) while still applying everything else.
  When `ack` catches up, JS is authoritative, so controlled transforms
  (uppercasing, rejecting input) still win.
- when React does not adopt a change at all (handler bails out, clamps, or is
  missing), the bridge synthesizes a corrective update after the synchronous
  flush, so the host always settles back on React's value. This covers every
  controlled kind including Slider.

The contract tests (`packages/natui/test/`) pin these behaviors against a
reference host implementation, and `examples/demo/src/verify.tsx` re-proves
them against the real SwiftUI host via the `edit` debug message (a real
optimistic edit: local write, seq, change event).

## The hosts

Each host is deliberately dumb: a node store, a view mapper, an NDJSON pump.
No layout logic, no diffing (React did that), no business logic.

**macOS** (`hosts/macos`): per-node `@Observable` classes give fine-grained
invalidation (a keystroke re-renders one view, not the tree). A recursive
`NodeView` switches on kind inside `@ViewBuilder` (no AnyView, preserving
structural identity); children render via `ForEach(children, id: \.id)` so moves
are moves, not teardowns. Runs as a bare SwiftPM executable, an embedded
Info.plist (`-sectcreate __TEXT __info_plist`) plus `setActivationPolicy(.regular)`
gives it real GUI-app identity (keyboard focus, Retina) without an .app bundle.

**Windows** (`hosts/windows`): WinUI 3 unpackaged + self-contained, spawnable as
a plain exe. GUI-subsystem processes inherit stdio pipes from Node
(`STARTF_USESTDHANDLES`), so the transport is identical to macOS. One wrinkle
SwiftUI doesn't have: WinUI events fire on *programmatic* changes too, so prop
application sets an `applyingRemote` guard to avoid echo loops. Stacks are Grids
(not StackPanels) so `Spacer` can be a star-sized track.

## Debug surface

The protocol carries a debug channel that made this POC verifiable end-to-end
without touching the GUI:

- `dump` → host returns its actual native tree (assert against it),
- `emit` → host synthesizes a user event (drive the app),
- `edit` → host performs a real optimistic user edit (the seq/ack path),
- `screenshot` → host renders its own window to PNG (no screen-recording
  permission needed); hosts always reply, with an `error` field on failure,
  and the JS side times out rather than hanging if a host misbehaves.

`examples/demo/src/verify.tsx` uses all four to prove counter/todo/toggle/
slider round trips plus the controlled-input stress cases (fast typing,
rejected and clamped edits, slider clamping) against the real SwiftUI host.

## Production path (researched, staged)

- **Stage 0, now**: Node is the parent, spawns the host, NDJSON over stdio.
  Perfect dev loop (tsx watch), zero packaging.
- **Stage 1, shippable**: invert control. Compile the JS app to a single-file
  sidecar (`bun build --compile`, ~50 MB, or Node SEA) placed in
  `Contents/Resources`; the native host spawns it at launch and ties its
  lifetime to the app. This is exactly Tauri's blessed "Node.js as a sidecar"
  pattern. Same protocol, same transport interface.
- **Stage 2, in-process**: embed the JS engine. **The macOS half is built and
  verified in this repo**: `natui-host --bundle dist/embedded.js` evaluates the
  esbuild bundle inside **JavaScriptCore.framework** (system-provided, JIT,
  Swift-native API) on the main run loop. React's scheduler needs only
  `setTimeout` (DispatchQueue-backed polyfill in `JSHost.swift`) and
  `queueMicrotask` (`Promise.resolve().then`: JSC drains its job queue on
  returning to native). The bundle and the host exchange the same protocol
  messages as plain function calls (`__natui_send` / `__natui_recv`, see
  `packages/natui/src/inproc.ts`); the stdio channel stays alive as a debug
  port, which is how `examples/demo/src/verify-embedded.mjs` proves the whole
  loop (mount, synthesized presses, screenshot) with **zero Node at runtime**.
  App code stays engine-neutral by importing components from
  `natui/components` (no Node built-ins) and its entry from `natui/inproc`.
  - Windows: **Microsoft.JavaScript.Hermes** NuGet, exposes a Node-API C ABI
    that C# can P/Invoke; this is precisely what react-native-windows ships on.
    Not yet built (needs a Windows machine, like the WinUI host itself).

## What's deliberately out of scope for the POC

- react-refresh (state-preserving hot reload). `examples/demo/src/dev.tsx` is a
  watch-and-remount loop on `NatuiApp.update()`: the window survives, state
  resets, and only the re-imported app module is fresh (transitive imports may
  stay cached by the loader).
- Animations API, gestures, menus, multi-window (`window` message is already
  separate from the tree for this reason).
- A `natui doctor`/CLI packaging story (Stage 1: the .app bundle wrapper around
  the proven `--bundle` mode).

Accessibility basics are in scope: `accessibilityLabel`, `accessibilityHint`,
and `accessibilityIdentifier` are common props mapped to the platform AX
attributes; everything else rides on the native controls' defaults.
