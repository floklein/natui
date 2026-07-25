import AppKit

/// Bridges root-attached MenuBar/Toolbar nodes to real window chrome. They
/// stay ordinary Store nodes (dump and emit address them by id); after every
/// commit this singleton scans the root children and pushes changed props
/// into the AppKit controllers.
///
/// Diffing matters: JSONValue is Equatable, and skipping unchanged props is
/// what keeps an OPEN NSMenu from being rebuilt (torn down) by an unrelated
/// commit elsewhere in the tree.
@MainActor
final class ChromeSync {
    static let shared = ChromeSync()

    private let menuBar = MenuBarController()
    private let toolbar = ToolbarController()
    private var lastMenuBar: (id: Int, props: [String: JSONValue])?
    private var lastToolbar: (id: Int, props: [String: JSONValue])?
    private var hasSyncedMenuBar = false

    /// Called by WindowManager once the window exists; toolbar specs that
    /// arrived earlier are applied now.
    func windowReady(_ window: NSWindow) {
        toolbar.attach(window)
    }

    /// Called at the end of every Store.apply.
    func sync(rootChildren: [Node]) {
        let menuNode = rootChildren.first { $0.kind == "MenuBar" }
        if !hasSyncedMenuBar || changed(menuNode, since: lastMenuBar) {
            hasSyncedMenuBar = true
            lastMenuBar = menuNode.map { ($0.id, $0.props) }
            menuBar.update(node: menuNode)
        }
        let toolbarNode = rootChildren.first { $0.kind == "Toolbar" }
        if changed(toolbarNode, since: lastToolbar) {
            lastToolbar = toolbarNode.map { ($0.id, $0.props) }
            toolbar.update(node: toolbarNode)
        }
    }

    private func changed(_ node: Node?, since last: (id: Int, props: [String: JSONValue])?) -> Bool {
        node?.id != last?.id || node?.props != last?.props
    }
}
