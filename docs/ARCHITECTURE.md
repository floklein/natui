# Architecture

## Goals

NatUI has four architectural goals:

1. Application code should be recognizable, idiomatic React TypeScript.
2. macOS pixels should come from SwiftUI and Windows pixels should come from WinUI 3.
3. The public component API should not depend on the JavaScript engine or bridge transport.
4. Unsupported semantics should fail clearly instead of quietly falling back to web content.

## Runtime layers

### Core

`@natui/core` provides typed semantic components. They create React host elements such as `vstack`, `text`, and `button`. The package also re-exports React hooks so an application can use one import surface.

The API deliberately describes intent rather than copying CSS. `VStack` is a vertical native layout, `foreground` is a semantic native color, and `onPress` is a native activation event.

### Reconciler

`@natui/runtime` uses `react-reconciler` in mutation mode. React mutates an in-memory host tree with stable node IDs. After `resetAfterCommit`, NatUI serializes the entire visible tree and atomically replaces the current event-handler map.

A full snapshot is the right first protocol for SwiftUI because it is deterministic, easy to replay, and recovers naturally after a dropped connection. It also keeps the native hosts free from partial-transaction states.

### Protocol

Host-bound messages are newline-delimited JSON:

```json
{"protocol":1,"type":"hello","platform":"macos","capabilities":["snapshots","events","controlled-inputs"]}
{"protocol":1,"type":"snapshot","revision":3,"root":{"id":"n1","type":"text","props":{"content":"Hello"},"events":{},"children":[]}}
```

Native events flow in the other direction:

```json
{"protocol":1,"type":"event","handler":"n4:press","payload":null}
```

Protocol invariants:

- stdout contains protocol frames only.
- Every snapshot has a monotonically increasing revision.
- Native hosts ignore revisions older than the last applied revision.
- Functions never cross the process boundary. A commit installs handler tokens atomically.
- Unknown or stale handler tokens produce a structured error.
- Unsupported prop values are omitted, normalized, or rejected before transmission.

### Controller process

The same bundled React application is compiled once per target platform so `Platform.select` can use native-specific values. Bun produces a standalone controller for the target architecture. The host launches the controller with redirected standard input, output, and error streams.

This process boundary is a POC packaging choice, not part of the public API.

### SwiftUI host

The macOS host decodes snapshots into a recursive value tree owned by a main-actor observable model. A recursive SwiftUI view maps node types to `VStack`, `HStack`, `Text`, `Button`, `TextField`, and other native views. `ForEach` uses React-assigned IDs.

The CLI compiles the host with `swiftc`, assembles a normal `.app` bundle, includes the controller in `Contents/Resources`, and applies a local signature.

### WinUI host

The Windows host uses a small compiled XAML shell. C# materializes each snapshot into real `Microsoft.UI.Xaml.Controls` instances on the dispatcher queue. The generated project is self-contained and unpackaged for the shortest POC build path.

## React semantics

The JavaScript renderer preserves:

- function and class components
- state and reducer hooks
- context
- memoization
- effects
- transitions at the JavaScript scheduling level
- keyed host identity
- error boundaries

The asynchronous process boundary does not preserve synchronous access to mounted native controls. In particular, this POC does not offer synchronous layout reads, native imperative refs, or synchronous native-module calls.

## Why snapshots first

A patch protocol can reduce serialization and host reconstruction, but it adds ordering, transaction, rollback, and recovery states. Snapshot correctness should be proven before measuring whether patches are necessary.

The next protocol can add:

- snapshot acknowledgements and backpressure
- a negotiated maximum frame size
- transaction checksums
- optional create, update, move, and remove patches
- automatic full-snapshot recovery after a sequence gap

## Security model

The controller communicates through inherited pipes, not a listening socket. The POC does not expose a localhost port. Native hosts resolve the controller from their own application bundle and never execute a path received over the protocol.

Production hardening still needs:

- signed nested helpers and Hardened Runtime entitlements on macOS
- MSIX signing or an explicit Windows distribution policy
- protocol frame and nesting limits
- controller crash throttling
- asset path confinement
- native-module capability declarations

## Version policy

`react-reconciler` is an experimental package. NatUI pins the React and reconciler pair exactly, wraps all host configuration in one source file, and exercises it through behavior tests. Upgrades should change the pair in one commit and run the full native matrix.
