# Changelog

All notable changes to NatUI are documented in this file.

## 0.2.0, 2026-07-29

### Added

- Expo-style `natui.app.json` loading for the development entry point
- Platform-native macOS ICNS and Windows multi-image ICO validation
- A shared development and embedded packaging entry
- The `create-natui-app` project generator with TypeScript starter files and
  generated native icon assets
- A copyable `npx create-natui-app@latest` command in the documentation hero

### Fixed

- Packaged Windows applications now start. The Windows bundle loader still
  declared host API 1, so it rejected every bundle built for host API 2.

## 0.1.0, 2026-07-26

Initial alpha release.

### Included

- React 19 renderer with 37 typed native components
- SwiftUI host for macOS and WinUI 3 host for Windows
- Node development server with state-preserving React Fast Refresh
- Embedded JavaScriptCore and V8 runtime modes
- Native application packaging for macOS `.app` bundles and self-contained
  Windows executables
- Protocol validation, controlled-input sequence acknowledgements, and
  application bundle integrity checks
- Contract, documentation, host build, packaging, and real-window verification
  suites

### Release boundaries

- The npm package contains the JavaScript runtime and development tooling. The
  native hosts must currently be built from the repository.
- Code signing, notarization, installers, automatic updates, multi-window
  applications, and stable compatibility guarantees are not included.
