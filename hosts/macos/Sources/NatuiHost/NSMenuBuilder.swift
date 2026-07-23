import AppKit

/// Builds real NSMenus from MenuItemSpec trees. Shared by the menu bar
/// (MenuBarController) and menu-type toolbar items (ToolbarController).
///
/// Emitting items carry their spec id in representedObject and route to the
/// given target/action; command-role items get responder-chain selectors
/// with a nil target (which is what makes Cmd+C/V work in this unbundled
/// executable) and never emit.
@MainActor
enum NSMenuBuilder {
    static func fill(
        _ menu: NSMenu,
        with items: [MenuItemSpec],
        target: AnyObject,
        action: Selector
    ) {
        // Manual enablement: `disabled` comes from the spec. Role items stay
        // enabled unconditionally (validating them against the responder
        // chain would gray out Copy whenever focus is not a text view, which
        // is native behavior but needs autoenables=true for the whole menu;
        // spec-driven enablement wins for this data-driven design).
        menu.autoenablesItems = false
        for spec in items {
            if spec.isDivider {
                menu.addItem(.separator())
                continue
            }
            let item = NSMenuItem(title: spec.label, action: nil, keyEquivalent: "")
            if let (key, mask) = ShortcutParser.appKit(spec.shortcut)
                ?? MenuCommandRole.defaultShortcut(for: spec.role) {
                item.keyEquivalent = key
                item.keyEquivalentModifierMask = mask
            }
            if let image = spec.systemImage {
                item.image = NSImage(systemSymbolName: image, accessibilityDescription: nil)
            }
            if let children = spec.children {
                let submenu = NSMenu(title: spec.label)
                fill(submenu, with: children, target: target, action: action)
                item.submenu = submenu
            } else if let selector = MenuCommandRole.selector(for: spec.role) {
                item.action = selector
                item.target = nil // responder chain
            } else {
                item.target = target
                item.action = action
                item.representedObject = spec.id
                if spec.role == "destructive", #available(macOS 14.0, *) {
                    // Best-effort native destructive tint.
                    item.attributedTitle = NSAttributedString(
                        string: spec.label,
                        attributes: [.foregroundColor: NSColor.systemRed]
                    )
                }
            }
            item.isEnabled = !spec.disabled
            if spec.checked == true {
                item.state = .on
            }
            menu.addItem(item)
        }
    }
}
