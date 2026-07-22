# Roadmap

## Phase 0: POC

- [x] Typed React primitives
- [x] React 19 custom renderer
- [x] Stable node and event IDs
- [x] Commit-batched snapshots
- [x] Native event roundtrip
- [x] Controlled inputs
- [x] SwiftUI host source generation
- [x] WinUI host source generation
- [x] Bun standalone controller builds
- [x] macOS application packaging
- [x] Runtime behavior tests
- [ ] WinUI build and interaction verification on Windows

## Phase 1: Developer loop

- Configuration in TypeScript as well as JSON
- Fast controller restart without rebuilding the native shell
- React Fast Refresh
- Structured native and controller logs
- Native error overlay
- Protocol acknowledgements, limits, and crash recovery
- Platform and component capability negotiation
- Snapshot inspector and replay tool

## Phase 2: Native surface

- Navigation split views and tabs
- Menus, commands, keyboard shortcuts, and window management
- Virtualized lists and tables
- Dialogs, alerts, context menus, and popovers
- File pickers and drag and drop
- Images and bundled asset catalogs
- Focus, validation, and richer accessibility traits
- Native animations and transitions
- A typed native-module boundary

## Phase 3: Performance

- Measure commit size, reconstruction time, memory, and input latency
- Add incremental transactions only where measurements justify them
- Reuse native controls by stable node ID
- Coalesce continuous slider and text events safely
- Background decoding with UI-thread application
- Lazy host construction for long lists

## Phase 4: Runtime

- Embed QuickJS-NG or another compact engine in-process
- Provide Scheduler-compatible task and microtask queues
- Add memory and execution limits
- Precompile trusted application bytecode per engine version
- Preserve the current application API and protocol fixtures during migration

## Parallel AOT investigation

- Run NatUI examples through Perry's React compatibility layer
- Measure binary size, startup, and package compatibility
- Estimate SwiftUI and WinUI backend work
- Decide whether a restricted AOT mode is worth supporting alongside the runtime renderer

## Release gates

Before calling NatUI production-ready:

1. Both native hosts build and run in CI on supported OS versions.
2. Interaction, accessibility, and keyed identity tests pass on real controls.
3. Sidecar or engine crashes recover predictably.
4. macOS signing, notarization, sandboxing, and nested helper rules are documented and automated.
5. Windows MSIX packaging, signing, runtime deployment, and Store requirements are automated.
6. The protocol has size, depth, timeout, and capability limits.
7. Native-module permissions are explicit and reviewable.
8. The component behavior matrix is documented for both platforms.
