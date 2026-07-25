# Component and state patterns

## Select components by native intent

Use the current [component catalog](https://natui.dev/docs/components.md) as the
complete source of truth. Start with these groups:

| Intent | Components | Detailed reference |
| --- | --- | --- |
| Layout | `VStack`, `HStack`, `ZStack`, `Spacer`, `Divider`, `ScrollView`, `List` | [Layout](https://natui.dev/docs/components/layout.md) |
| Content | `Text`, `Label`, `Image`, `ProgressView`, `Link` | [Content](https://natui.dev/docs/components/content.md) |
| Inputs | `Button`, `TextField`, `TextEditor`, `SearchField`, `Toggle`, `Slider`, `Stepper`, `Picker`, `DatePicker`, `DisclosureGroup` | [Inputs](https://natui.dev/docs/components/inputs.md) |
| App shell | `SplitView`, `Sidebar`, `Detail`, `TabView`, `Tab`, `MenuBar`, `Toolbar` | [App shell](https://natui.dev/docs/components/app-shell-navigation.md) |
| Menus and data | `Menu`, `ContextMenu`, `Section`, `Table` | [Menus](https://natui.dev/docs/components/menus.md) and [data](https://natui.dev/docs/components/data.md) |
| Presentation | `Sheet`, `Alert`, `Popover`, `PopoverContent` | [Presentation](https://natui.dev/docs/components/presentation.md) |

Recheck the catalog instead of assuming this snapshot is exhaustive.

## Keep native state controlled

Store interactive values in React and pass NatUI's emitted value directly to
the state setter:

```tsx
import { useState } from 'react';
import { Text, TextField, Toggle, VStack } from 'natui/components';

export function AccountForm() {
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);

  return (
    <VStack spacing={12} padding={20} alignment="leading">
      <Text font="title" weight="semibold">Account</Text>
      <TextField
        value={name}
        placeholder="Name"
        onChange={setName}
        frame={{ width: 280 }}
      />
      <Toggle value={enabled} onChange={setEnabled}>
        Enabled
      </Toggle>
    </VStack>
  );
}
```

Do not use `event.target.value`, uncontrolled `defaultValue`, DOM refs, or CSS.
Read the [controlled state guide](https://natui.dev/docs/guides/controlled-state.md)
for the native edit acknowledgement model.

## Compose app shells deliberately

- Render `MenuBar` and `Toolbar` as window-level siblings of the main content.
- Keep at most one root-level `MenuBar` and one root-level `Toolbar` for a
  portable tree.
- Put `Sidebar` and `Detail` directly inside `SplitView`.
- Keep split-view visibility, tab selection, list selection, table selection,
  sorting, and search text in React state.
- Provide the `List` `value` prop, even when its value is `null`, to enable
  selection. Give selectable children stable `tag` values. Keep React `key`
  values stable across inserts, sorting, and filtering.
- Build menu, context-menu, toolbar, and table specifications from serializable
  objects. Handle the returned item identifiers in JavaScript.
- Give table rows stable `id` values. Sort and filter rows before passing them
  to `Table`, and echo the requested `SortDescriptor` through React state. The
  native host displays the supplied rows and reports user intent.
- Use `frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}` where a native
  region should consume available space. Use fixed or minimum sizes only where
  the interaction requires them.

Read the [app shell and data guide](https://natui.dev/docs/guides/app-shell-and-data.md)
before implementing navigation, window chrome, or sortable data.

## Control presentations

- Drive `Sheet`, `Alert`, and `Popover` from boolean React state.
- Close presentations from both action handlers and `onChange` so native
  dismissal stays synchronized.
- Gate expensive `Sheet` children when they do not need to retain local state.
  Sheet children remain part of the native tree while the sheet is closed.
- Handle an alert choice in `onSelect`, then let the following `onChange(false)`
  close the presentation.
- Keep `PopoverContent` inside its `Popover` and provide a real anchor child.
- Model alert and menu actions with stable identifiers and explicit roles.

Read the [overlays guide](https://natui.dev/docs/guides/overlays.md) before
combining multiple presentation types.

## Preserve native semantics

- Express layout with NatUI props, then allow SwiftUI and WinUI 3 to choose
  platform-native geometry and control appearance.
- Represent `DatePicker` values with the local ISO string format documented for
  its displayed components. Do not introduce a time zone conversion unless the
  application model requires one.
- Provide meaningful `accessibilityLabel`, `accessibilityHint`, and
  `accessibilityIdentifier` values where the visible label is insufficient or
  deterministic verification needs a stable target.
- Prefer the platform's native control for an intent over recreating that
  control from stacks and click handlers.
