import AppKit
import SwiftUI

/// Decoded MenuItemSpec (docs/protocol.md "Data-driven item trees"): the
/// shared recursive JSON shape behind MenuBar menus, Menu/ContextMenu items,
/// and menu-type toolbar items.
struct MenuItemSpec {
    let id: String
    let label: String
    let systemImage: String?
    let role: String?
    let shortcut: String?
    let disabled: Bool
    let checked: Bool?
    let isDivider: Bool
    let children: [MenuItemSpec]?

    static func parse(_ json: JSONValue) -> MenuItemSpec? {
        guard let obj = json.objectValue else { return nil }
        if obj["divider"]?.boolValue == true {
            return MenuItemSpec(
                id: "", label: "", systemImage: nil, role: nil, shortcut: nil,
                disabled: false, checked: nil, isDivider: true, children: nil
            )
        }
        guard let id = obj["id"]?.stringValue else { return nil }
        return MenuItemSpec(
            id: id,
            label: obj["label"]?.stringValue ?? id,
            systemImage: obj["systemImage"]?.stringValue,
            role: obj["role"]?.stringValue,
            shortcut: obj["shortcut"]?.stringValue,
            disabled: obj["disabled"]?.boolValue ?? false,
            checked: obj["checked"]?.boolValue,
            isDivider: false,
            children: obj["children"].map { parseList($0) }
        )
    }

    static func parseList(_ json: JSONValue?) -> [MenuItemSpec] {
        (json?.arrayValue ?? []).compactMap(parse)
    }
}

/// One top-level menu of a MenuBar node.
struct MenuSpec {
    let id: String
    let label: String
    let items: [MenuItemSpec]

    static func parseMenus(_ json: JSONValue?) -> [MenuSpec] {
        (json?.arrayValue ?? []).compactMap { entry in
            guard let obj = entry.objectValue, let id = obj["id"]?.stringValue else { return nil }
            return MenuSpec(
                id: id,
                label: obj["label"]?.stringValue ?? id,
                items: MenuItemSpec.parseList(obj["items"])
            )
        }
    }
}

// MARK: - Command roles
//
// Every role except "destructive" is a NATIVE command: it maps to a
// responder-chain selector sent with a nil target (which is exactly how
// Cmd+C/V/X work in an unbundled executable) and never emits `select`.

enum MenuCommandRole {
    static func selector(for role: String?) -> Selector? {
        switch role {
        case "cut": #selector(NSText.cut(_:))
        case "copy": #selector(NSText.copy(_:))
        case "paste": #selector(NSText.paste(_:))
        case "selectAll": #selector(NSText.selectAll(_:))
        // String selectors: undo/redo resolve through the responder chain /
        // NSUndoManager at runtime and have no compile-time symbol here.
        case "undo": Selector(("undo:"))
        case "redo": Selector(("redo:"))
        case "quit": #selector(NSApplication.terminate(_:))
        case "about": #selector(NSApplication.orderFrontStandardAboutPanel(_:))
        default: nil
        }
    }

    /// Standard key equivalents so role items look native without an explicit
    /// `shortcut` (returns lowercase key + modifiers, AppKit convention).
    static func defaultShortcut(for role: String?) -> (String, NSEvent.ModifierFlags)? {
        switch role {
        case "cut": ("x", .command)
        case "copy": ("c", .command)
        case "paste": ("v", .command)
        case "selectAll": ("a", .command)
        case "undo": ("z", .command)
        case "redo": ("z", [.command, .shift])
        case "quit": ("q", .command)
        default: nil
        }
    }
}

// MARK: - Shortcut parsing ('cmd+shift+s' -> key + modifiers)

enum ShortcutParser {
    static func appKit(_ shortcut: String?) -> (String, NSEvent.ModifierFlags)? {
        guard let (key, mods) = tokens(shortcut) else { return nil }
        var flags: NSEvent.ModifierFlags = []
        if mods.contains("cmd") || mods.contains("command") { flags.insert(.command) }
        if mods.contains("shift") { flags.insert(.shift) }
        if mods.contains("alt") || mods.contains("option") { flags.insert(.option) }
        if mods.contains("ctrl") || mods.contains("control") { flags.insert(.control) }
        return (key, flags)
    }

    static func swiftUI(_ shortcut: String?) -> KeyboardShortcut? {
        guard let (key, mods) = tokens(shortcut), let ch = key.first, key.count == 1 else {
            return nil
        }
        var modifiers: EventModifiers = []
        if mods.contains("cmd") || mods.contains("command") { modifiers.insert(.command) }
        if mods.contains("shift") { modifiers.insert(.shift) }
        if mods.contains("alt") || mods.contains("option") { modifiers.insert(.option) }
        if mods.contains("ctrl") || mods.contains("control") { modifiers.insert(.control) }
        return KeyboardShortcut(KeyEquivalent(ch), modifiers: modifiers)
    }

    private static func tokens(_ shortcut: String?) -> (key: String, mods: Set<String>)? {
        guard let shortcut, !shortcut.isEmpty else { return nil }
        var parts = shortcut.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.popLast(), !key.isEmpty else { return nil }
        return (key, Set(parts))
    }
}

// MARK: - SwiftUI menu-items builder (Menu, ContextMenu, toolbar menus)

/// Recursive builder over a parsed spec list. `onSelect` receives leaf item
/// ids; command-role items trigger their native selector instead.
struct MenuItemsView: View {
    let items: [MenuItemSpec]
    let onSelect: (String) -> Void

    var body: some View {
        ForEach(items.indices, id: \.self) { i in
            MenuItemEntryView(item: items[i], onSelect: onSelect)
        }
    }
}

private struct MenuItemEntryView: View {
    let item: MenuItemSpec
    let onSelect: (String) -> Void

    var body: some View {
        if item.isDivider {
            Divider()
        } else if let children = item.children {
            Menu(item.label) {
                MenuItemsView(items: children, onSelect: onSelect)
            }
            .disabled(item.disabled)
        } else if let selector = MenuCommandRole.selector(for: item.role) {
            Button(item.label) {
                NSApp.sendAction(selector, to: nil, from: nil)
            }
            .disabled(item.disabled)
        } else if let checked = item.checked {
            // Checked rows are prop-driven: the tap only reports the select;
            // the checkmark flips when the app re-renders with the new value.
            Toggle(isOn: Binding(get: { checked }, set: { _ in onSelect(item.id) })) {
                itemLabel
            }
            .disabled(item.disabled)
        } else {
            Button(role: item.role == "destructive" ? .destructive : nil) {
                onSelect(item.id)
            } label: {
                itemLabel
            }
            .disabled(item.disabled)
            .modifier(ShortcutMod(shortcut: ShortcutParser.swiftUI(item.shortcut)))
        }
    }

    @ViewBuilder
    private var itemLabel: some View {
        if let image = item.systemImage {
            SwiftUI.Label(item.label, systemImage: image)
        } else {
            Text(item.label)
        }
    }
}

private struct ShortcutMod: ViewModifier {
    let shortcut: KeyboardShortcut?

    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(shortcut)
        } else {
            content
        }
    }
}
