import AppKit

/// Owns NSApp.mainMenu, rebuilt from a root-attached MenuBar node's `menus`
/// spec whenever ChromeSync sees the props change (never while unchanged, so
/// an open menu is not torn down by unrelated commits). The standard app
/// menu (About/Quit) is always prepended.
@MainActor
final class MenuBarController: NSObject {
    private var nodeId: Int?

    func update(node: Node?) {
        nodeId = node?.id
        let main = NSMenu()
        main.addItem(appMenuItem())
        if let node {
            for spec in MenuSpec.parseMenus(node.props["menus"]) {
                let item = NSMenuItem(title: spec.label, action: nil, keyEquivalent: "")
                let submenu = NSMenu(title: spec.label)
                NSMenuBuilder.fill(
                    submenu,
                    with: spec.items,
                    target: self,
                    action: #selector(didSelect(_:))
                )
                item.submenu = submenu
                main.addItem(item)
            }
        }
        NSApp.mainMenu = main
    }

    @objc private func didSelect(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let nodeId else { return }
        Emitter.event(nodeId, "select", payload: ["value": id])
    }

    private func appMenuItem() -> NSMenuItem {
        let name = ProcessInfo.processInfo.processName
        let appMenu = NSMenu(title: name)
        appMenu.addItem(
            withTitle: "About \(name)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem()
        item.submenu = appMenu
        return item
    }
}
