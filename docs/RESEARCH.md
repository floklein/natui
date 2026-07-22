# Research and alternatives

The POC architecture was selected after comparing runtime rendering, source generation, existing React Native targets, web-hosted JavaScript, and embedded engines.

## Decision summary

| Approach | React compatibility | Native SwiftUI and WinUI | Overnight feasibility | Main cost |
| --- | --- | --- | --- | --- |
| Custom reconciler plus Bun sidecar | High | Yes | High | Process bridge and binary size |
| TypeScript to Swift and C# compiler | Low at first | Yes | Medium for a restricted demo | Becomes a language compiler |
| React Native macOS and Windows | High | No exact match | Medium | AppKit and Composition, not SwiftUI and WinUI controls |
| JavaScriptCore plus WebView2 | High after polyfills | Yes | Medium | Different engines and bridges per platform |
| Embedded QuickJS-NG | Potentially high | Yes | Low for one night | Native integration and platform polyfills |
| WebView shell | High | No | High | Renders web UI, outside the project goal |

## Custom React renderer

React publishes `react-reconciler` specifically for custom renderers, although the package is experimental. A renderer lets NatUI preserve standard React components and hooks while defining its own host elements.

Sources:

- [React reconciler package](https://www.npmjs.com/package/react-reconciler)
- [React source for the reconciler](https://github.com/facebook/react/tree/main/packages/react-reconciler)

## Bun standalone controller

Bun can compile one TypeScript or JavaScript entry point with its dependencies and runtime into a standalone executable. It supports cross-compilation targets for macOS arm64, macOS x64, Windows x64, and Windows arm64.

This makes it possible to produce both controller helpers from the current Mac. It does not cross-compile the WinUI host.

Tradeoffs:

- A minimal standalone helper is roughly 60 MB.
- macOS distribution needs correct signing and JIT-related entitlements.
- Universal macOS distribution needs separate architecture helpers or a merge strategy.
- Windows metadata flags have limits during cross-compilation.

Source: [Bun standalone executables](https://bun.com/docs/bundler/executables)

## Static TypeScript compilation

A source compiler looks attractive because it could remove the JavaScript runtime. The difficulty is semantic, not syntactic. General TypeScript and React contain closures, dynamic imports, effects, promises, context, reducers, exception behavior, npm packages, and JavaScript object semantics. Translating JSX alone is not enough.

[Perry](https://github.com/PerryTS/perry) is the strongest existing reference. It uses Rust, SWC, and LLVM, and includes an early React compatibility layer. Its current desktop targets are AppKit and Win32 rather than SwiftUI and WinUI. A later NatUI investigation should test whether Perry's frontend can feed new native backends.

React Compiler is an optimizer and automatic memoization compiler. It does not translate React into SwiftUI or WinUI. Source: [React Compiler](https://react.dev/learn/react-compiler)

## React Native

React Native proves that a JavaScript renderer can drive native UI at scale, but its current desktop targets do not meet this experiment's exact platform requirement.

- React Native macOS is AppKit-based. Source: [React Native macOS](https://microsoft.github.io/react-native-macos/)
- React Native Windows' new architecture uses Windows App SDK Composition. Its documentation says XAML-backed components are not the production-ready default. Source: [React Native Windows architecture](https://microsoft.github.io/react-native-windows/docs/new-architecture/)
- Fabric is still a valuable long-term reference for immutable shadow trees, scheduling, and in-process host access. Source: [Fabric renderer](https://reactnative.dev/architecture/fabric-renderer)

## SwiftUI and WinUI

SwiftUI's value-tree model fits immutable snapshot projection well. The host uses native app lifecycle, main-actor state, and stable IDs.

Sources:

- [SwiftUI](https://developer.apple.com/documentation/swiftui/)
- [SwiftUI App](https://developer.apple.com/documentation/swiftui/app)
- [Managing model data](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app/)

WinUI 3 is Microsoft's recommended native UI framework for new Windows desktop applications. The current command-line template targets .NET 10 and Windows App SDK.

Sources:

- [Create a WinUI 3 app](https://learn.microsoft.com/en-us/windows/apps/winui/winui3/create-your-first-winui3-app)
- [Windows App SDK](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/)
- [WinUI platform overview](https://learn.microsoft.com/en-us/windows/apps/develop/platform/)

## Embedded production runtime

The process bridge should be replaced only after the component and protocol model is proven.

QuickJS-NG is the strongest compact engine candidate. It supports macOS and Windows, exposes a C API, supports execution interrupts and memory limits, and can load precompiled bytecode. NatUI would need to supply timers, microtasks, module loading, console output, performance timing, and bridge functions.

Sources:

- [QuickJS-NG developer guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)
- [QuickJS-NG supported platforms](https://quickjs-ng.github.io/quickjs/supported-platforms/)

Hermes is closely aligned with React Native but its releases are coupled to React Native versions. A standalone desktop embed would carry more integration risk for this project. Source: [Hermes](https://github.com/facebook/hermes)

## Other useful references

- [Microsoft.UI.Reactor architecture](https://microsoft.github.io/microsoft-ui-reactor/architecture-overview/) for declarative WinUI control reconciliation
- [Node single executable applications](https://nodejs.org/api/single-executable-applications.html), which currently require more injection and signing steps than Bun
- [WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/) as a rejected JavaScript host because it creates a platform-specific hybrid dependency
