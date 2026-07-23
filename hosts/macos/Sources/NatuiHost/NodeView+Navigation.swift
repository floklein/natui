import SwiftUI

/// Navigation kinds: SplitView (sidebar + detail), TabView/Tab, and the
/// slot containers. List (with selection/sections) also lives here because
/// it shares the row-tagging machinery.
struct NavigationNodeView: View {
    let node: Node

    var body: some View {
        switch node.kind {
        case "SplitView":
            SplitNodeView(node: node)
        case "TabView":
            TabNodeView(node: node)
        case "Sidebar", "Detail", "Tab":
            // Slot containers render their children as a plain leading
            // column filling the pane/page they were routed into.
            VStack(alignment: .leading, spacing: 0) {
                NodeChildren(node: node)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        default:
            EmptyView()
        }
    }
}

// MARK: - SplitView

/// NavigationSplitView with kind-routed slots: the FIRST Sidebar child fills
/// the sidebar column, the FIRST Detail child the detail column, regardless
/// of order. `value` optionally controls sidebar visibility ('all' /
/// 'detailOnly'); the automatic toolbar toggle does not exist here (the
/// window owns a data-driven NSToolbar), so apps drive `value` themselves.
///
/// Documented fallback if NavigationSplitView misbehaves inside the plain
/// NSWindow: replace the body with HSplitView { sidebar; detail } in this
/// same case (the slot routing and binding stay identical).
private struct SplitNodeView: View {
    let node: Node

    private var sidebarNode: Node? { node.children.first { $0.kind == "Sidebar" } }
    private var detailNode: Node? { node.children.first { $0.kind == "Detail" } }

    private var visibilityBinding: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { node.str("value") == "detailOnly" ? .detailOnly : .all },
            set: { visibility in
                node.userEdit(.string(visibility == .detailOnly ? "detailOnly" : "all"))
            }
        )
    }

    var body: some View {
        NavigationSplitView(columnVisibility: visibilityBinding) {
            Group {
                if let sidebarNode {
                    NodeView(node: sidebarNode)
                } else {
                    Color.clear
                }
            }
            .navigationSplitViewColumnWidth(
                min: node.num("minSidebarWidth"),
                ideal: node.num("sidebarWidth") ?? 220,
                max: node.num("maxSidebarWidth")
            )
            // The window owns a data-driven NSToolbar (ToolbarController);
            // suppress SwiftUI's automatic sidebar-toggle toolbar item so
            // NavigationSplitView does not install a competing toolbar.
            // Sidebar visibility is the controlled `value` prop instead.
            .toolbar(removing: .sidebarToggle)
        } detail: {
            if let detailNode {
                NodeView(node: detailNode)
            } else {
                Color.clear
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onAppear {
            let extras = node.nonTextChildren.filter { $0.kind != "Sidebar" && $0.kind != "Detail" }
            if !extras.isEmpty {
                Emitter.log("SplitView \(node.id): ignoring children of kinds \(extras.map(\.kind))")
            }
        }
    }
}

// MARK: - TabView

/// Controlled tab container: `value` is the selected Tab's `id`; a tab click
/// is an optimistic userEdit (change with seq), so a refusing app snaps back
/// via the standard corrective update.
private struct TabNodeView: View {
    let node: Node

    private var tabs: [Node] { node.children.filter { $0.kind == "Tab" } }

    private var selectionBinding: Binding<String> {
        Binding(
            get: { node.str("value") ?? tabs.first.flatMap { $0.str("id") } ?? "" },
            set: { node.userEdit(.string($0)) }
        )
    }

    var body: some View {
        TabView(selection: selectionBinding) {
            ForEach(tabs, id: \.id) { tab in
                NodeView(node: tab)
                    // Plain Text only: the classic macOS tab strip drops
                    // Label-based tab items (renders blank segments), and it
                    // has no badge affordance; systemImage/badge are honored
                    // on platforms whose tab bars support them (Windows).
                    .tabItem {
                        Text(tab.str("title") ?? "")
                    }
                    .tag(tab.str("id") ?? String(tab.id))
            }
        }
    }
}

// MARK: - List (selection, sections, sidebar style)

/// The List kind: plain container rows as before, plus controlled selection
/// (present iff props carry a `value` key), Section children rendered as
/// real SwiftUI Sections (modifier-free, so sectioning survives), and the
/// 'sidebar' list style for source lists.
struct ListNodeView: View {
    let node: Node

    var body: some View {
        Group {
            if node.props["value"] == nil {
                List { listContent }
            } else if node.str("selectionMode") == "multiple" {
                List(selection: node.stringSetBinding) { listContent }
            } else {
                List(selection: node.optionalStringBinding) { listContent }
            }
        }
        .modifier(ListStyleMod(sidebar: node.str("style") == "sidebar"))
    }

    @ViewBuilder
    private var listContent: some View {
        ForEach(node.children, id: \.id) { child in
            if child.kind == "Section" {
                Section {
                    ListRows(node: child)
                } header: {
                    if let header = child.str("header") { Text(header) }
                } footer: {
                    if let footer = child.str("footer") { Text(footer) }
                }
            } else {
                ListRow(child: child)
            }
        }
    }
}

private struct ListRows: View {
    let node: Node

    var body: some View {
        ForEach(node.children, id: \.id) { child in
            ListRow(child: child)
        }
    }
}

/// One list row: tagged for selection (protocol: rows identify themselves by
/// the `tag` common prop; untagged rows fall back to the node id string,
/// which no app value ever matches) and badged via the `badge` common prop.
private struct ListRow: View {
    let child: Node

    var body: some View {
        Group {
            if child.kind == "#text" {
                Text(child.text)
            } else {
                NodeView(node: child)
            }
        }
        .tag(child.str("tag") ?? String(child.id))
        .badge(child.badgeText)
    }
}

private struct ListStyleMod: ViewModifier {
    let sidebar: Bool

    func body(content: Content) -> some View {
        if sidebar {
            content.listStyle(.sidebar)
        } else {
            content.listStyle(.automatic)
        }
    }
}
