import AppKit

/// One parsed ToolbarItemSpec (docs/protocol.md "Data-driven item trees").
struct ToolbarSpecItem {
    let type: String
    let id: String
    let label: String?
    let systemImage: String?
    let on: Bool
    let disabled: Bool
    let placeholder: String?
    let menuItems: [MenuItemSpec]

    static func parseItems(_ json: JSONValue?) -> [ToolbarSpecItem] {
        (json?.arrayValue ?? []).compactMap { entry in
            guard let obj = entry.objectValue, let type = obj["type"]?.stringValue else { return nil }
            let id = obj["id"]?.stringValue ?? ""
            if type != "spacer" && type != "flexibleSpace" && id.isEmpty { return nil }
            return ToolbarSpecItem(
                type: type,
                id: id,
                label: obj["label"]?.stringValue,
                systemImage: obj["systemImage"]?.stringValue,
                on: obj["on"]?.boolValue ?? false,
                disabled: obj["disabled"]?.boolValue ?? false,
                placeholder: obj["placeholder"]?.stringValue,
                menuItems: MenuItemSpec.parseList(obj["items"])
            )
        }
    }
}

/// Owns the window's REAL NSToolbar (unified style), data-driven from a
/// root-attached Toolbar node's `items` spec. When the item identifier
/// sequence is unchanged, props are patched into the existing NSToolbarItems
/// in place (keeps search-field text and focus); otherwise the toolbar is
/// rebuilt wholesale.
@MainActor
final class ToolbarController: NSObject, NSToolbarDelegate, NSSearchFieldDelegate {
    private weak var window: NSWindow?
    private var nodeId: Int?
    private var specs: [String: ToolbarSpecItem] = [:] // identifier -> spec
    private var order: [NSToolbarItem.Identifier] = []
    private var rebuildCounter = 0
    private var currentToolbar: NSToolbar?
    private var toolbarObservation: NSKeyValueObservation?

    func attach(_ window: NSWindow) {
        self.window = window
        window.toolbarStyle = .unified
        // SwiftUI (NavigationSplitView) may install its own NSToolbar over
        // ours during a render pass even with the sidebar toggle removed;
        // the data-driven toolbar always wins. Identity check prevents
        // recursion: our own re-assert lands here once and no-ops.
        toolbarObservation = window.observe(\.toolbar, options: [.new]) { [weak self] window, _ in
            MainActor.assumeIsolated {
                guard let self, let mine = self.currentToolbar, window.toolbar !== mine else {
                    return
                }
                window.toolbar = mine
            }
        }
        if !order.isEmpty {
            rebuild()
        }
    }

    func update(node: Node?) {
        guard let node else {
            nodeId = nil
            specs = [:]
            order = []
            currentToolbar = nil
            window?.toolbar = nil
            return
        }
        nodeId = node.id
        let items = ToolbarSpecItem.parseItems(node.props["items"])

        var newSpecs: [String: ToolbarSpecItem] = [:]
        var newOrder: [NSToolbarItem.Identifier] = []
        for (index, item) in items.enumerated() {
            let identifier: NSToolbarItem.Identifier
            switch item.type {
            case "flexibleSpace":
                identifier = .flexibleSpace
            case "spacer":
                identifier = NSToolbarItem.Identifier("natui.space.\(index)")
            default:
                identifier = NSToolbarItem.Identifier("natui.\(item.type).\(item.id)")
            }
            if identifier != .flexibleSpace {
                newSpecs[identifier.rawValue] = item
            }
            newOrder.append(identifier)
        }

        let sameLayout = newOrder == order
        specs = newSpecs
        order = newOrder
        if sameLayout, let toolbar = window?.toolbar {
            // In-place patch: enabled/label/image/toggle-state/menus change
            // without tearing the toolbar down (keeps search text + focus).
            for item in toolbar.items {
                if let spec = specs[item.itemIdentifier.rawValue] {
                    configure(item, with: spec)
                }
            }
        } else {
            rebuild()
        }
    }

    private func rebuild() {
        guard let window else { return }
        // A fresh identifier per rebuild so AppKit never restores a stale
        // cached configuration for a different item set.
        rebuildCounter += 1
        let toolbar = NSToolbar(identifier: "natui.toolbar.\(rebuildCounter)")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false
        currentToolbar = toolbar
        window.toolbar = toolbar
    }

    // MARK: NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        order
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        order
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        if itemIdentifier.rawValue.hasPrefix("natui.space.") {
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            let view = NSView(frame: NSRect(x: 0, y: 0, width: 16, height: 1))
            item.view = view
            return item
        }
        guard let spec = specs[itemIdentifier.rawValue] else { return nil }
        let item: NSToolbarItem
        switch spec.type {
        case "toggle":
            item = NSToolbarItem(itemIdentifier: itemIdentifier)
            let button = NSButton(title: "", target: self, action: #selector(toggleAction(_:)))
            button.setButtonType(.pushOnPushOff)
            button.bezelStyle = .texturedRounded
            item.view = button
        case "menu":
            let menuItem = NSMenuToolbarItem(itemIdentifier: itemIdentifier)
            menuItem.showsIndicator = true
            item = menuItem
        case "search":
            let searchItem = NSSearchToolbarItem(itemIdentifier: itemIdentifier)
            searchItem.searchField.delegate = self
            searchItem.searchField.target = self
            searchItem.searchField.action = #selector(searchAction(_:))
            // Keystrokes emit via controlTextDidChange; without this the
            // action ALSO fires per keystroke (debounced), duplicating
            // events. True restricts the action to Enter.
            searchItem.searchField.sendsWholeSearchString = true
            item = searchItem
        default: // button
            item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.isBordered = true
            item.target = self
            item.action = #selector(buttonAction(_:))
        }
        // Spec-driven enablement (not responder-chain validation).
        item.autovalidates = false
        configure(item, with: spec)
        return item
    }

    private func configure(_ item: NSToolbarItem, with spec: ToolbarSpecItem) {
        item.label = spec.label ?? ""
        item.paletteLabel = spec.label ?? spec.id
        item.toolTip = spec.label
        item.isEnabled = !spec.disabled
        let image = spec.systemImage.flatMap {
            NSImage(systemSymbolName: $0, accessibilityDescription: spec.label)
        }
        switch spec.type {
        case "toggle":
            if let button = item.view as? NSButton {
                if let image {
                    button.image = image
                } else {
                    button.title = spec.label ?? spec.id
                }
                // Prop-driven pressed state (protocol: never optimistic).
                button.state = spec.on ? .on : .off
                button.isEnabled = !spec.disabled
            }
        case "menu":
            if let menuToolbarItem = item as? NSMenuToolbarItem {
                if let image { menuToolbarItem.image = image }
                let menu = NSMenu()
                NSMenuBuilder.fill(
                    menu,
                    with: spec.menuItems,
                    target: self,
                    action: #selector(menuAction(_:))
                )
                menuToolbarItem.menu = menu
            }
        case "search":
            if let searchItem = item as? NSSearchToolbarItem {
                searchItem.searchField.placeholderString = spec.placeholder ?? ""
            }
        default:
            if let image { item.image = image }
        }
    }

    // MARK: actions

    private func specFor(_ item: NSToolbarItem) -> ToolbarSpecItem? {
        specs[item.itemIdentifier.rawValue]
    }

    @objc private func buttonAction(_ sender: NSToolbarItem) {
        guard let nodeId, let spec = specFor(sender) else { return }
        Emitter.event(nodeId, "action", payload: ["value": spec.id])
    }

    @objc private func toggleAction(_ sender: NSButton) {
        guard let nodeId,
              let item = toolbarItem(for: sender),
              let spec = specFor(item) else { return }
        // Prop-driven: snap the button back to the spec'd state immediately;
        // the app's echoed `on` (a new items prop) is what flips it.
        sender.state = spec.on ? .on : .off
        Emitter.event(nodeId, "action", payload: ["value": spec.id])
    }

    @objc private func menuAction(_ sender: NSMenuItem) {
        guard let nodeId, let id = sender.representedObject as? String else { return }
        Emitter.event(nodeId, "action", payload: ["value": id])
    }

    @objc private func searchAction(_ sender: NSSearchField) {
        emitSearch(sender.stringValue)
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSSearchField else { return }
        emitSearch(field.stringValue)
    }

    /// Uncontrolled on the wire (fire-and-forget); Enter folds into the same
    /// event via the search field's action.
    private func emitSearch(_ value: String) {
        guard let nodeId else { return }
        Emitter.event(nodeId, "search", payload: ["value": value])
    }

    private func toolbarItem(for view: NSView) -> NSToolbarItem? {
        window?.toolbar?.items.first { $0.view === view }
    }
}
