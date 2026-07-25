---
name: natui
description: Build, extend, and verify React 19 desktop applications rendered through NatUI's SwiftUI and WinUI 3 hosts. Use when creating a NatUI app or component tree, choosing NatUI components and props, implementing controlled native state, configuring Node or embedded runtime entrypoints, debugging the native bridge, or validating real macOS and Windows UI.
---

# NatUI

Build React and TypeScript interfaces that become real SwiftUI or WinUI 3
controls. Treat the current checkout and current documentation as authoritative
because NatUI is in alpha.

## Ground the task

1. Identify the target operating system, runtime mode, and expected verification
   level.
2. Inspect the project's package scripts and the NatUI checkout before changing
   code. Keep the JavaScript package and native host on compatible protocol
   versions.
3. Read `https://natui.dev/llms.txt`, then fetch only the relevant documentation
   pages by appending `.md` to their routes. Use
   `https://natui.dev/llms-full.txt` only for work that spans most of the API.
4. Read [component-patterns.md](references/component-patterns.md) before choosing
   components or composing an app shell.
5. Read
   [runtime-and-validation.md](references/runtime-and-validation.md) before
   setting up, launching, embedding, debugging, or validating an application.

## Implement native React

- Use ordinary React state, effects, keys, and conditional rendering.
- Build the interface from NatUI components. Do not emit HTML, DOM elements,
  CSS, browser events, or React DOM APIs.
- Import `run` from `natui` for the Node development path. Prefer
  `@natui/core/components` for component modules that must remain free of Node.js
  built-ins, especially embedded bundles.
- Keep editable controls and presentations controlled with `value` and
  `onChange`. Update React state from the value passed by NatUI rather than
  reading a browser event object.
- Use stable tags and identifiers for selection, rows, menu items, toolbar
  actions, and accessibility.
- Pass serializable data to native props. Perform application sorting,
  filtering, and data mutation in JavaScript.
- Use stack, spacing, padding, alignment, and frame props for layout. Preserve
  equivalent behavior across platforms without forcing pixel-identical output.
- Check the current component documentation or
  `packages/natui/src/components.ts` before using a prop. Do not invent web-like
  aliases.

## Validate the result

1. Build the `natui` package before workspace typechecking when examples resolve
   generated package declarations.
2. Run the relevant contract tests and TypeScript checks.
3. Build the matching SwiftUI or WinUI 3 host from the same checkout.
4. Exercise a real native window before claiming visible behavior, interaction,
   focus, presentation, or accessibility success. Set `NATUI_HOST` explicitly
   when several host artifacts exist.
5. Use `dump`, `screenshot`, `emit`, and `edit` when deterministic native-tree or
   interaction evidence is needed.
6. Report the platform, runtime mode, commands, and evidence actually verified.
   Distinguish compilation, tree materialization, events, and visible pixels.

## Preserve alpha boundaries

- Do not claim that NatUI is available from a public package registry. The
  documented workflow currently uses a source checkout.
- Do not promise stable packaging or permanent component behavior.
- Do not treat a successful host build or JavaScript test as a real-window UI
  result.
- Recheck platform support and verification status before making compatibility
  claims.
