import SwiftUI

/// In-window menu kinds: Menu (dropdown button) and ContextMenu (right-click
/// target). Both are driven by the shared MenuItemSpec JSON tree; select
/// events carry the item id on THIS node's id, so `emit` can exercise the
/// select path without opening native menus.
struct MenuNodeView: View {
    let node: Node

    private var items: [MenuItemSpec] {
        MenuItemSpec.parseList(node.props["items"])
    }

    private func select(_ id: String) {
        Emitter.event(node.id, "select", payload: ["value": id])
    }

    var body: some View {
        switch node.kind {
        case "Menu":
            Menu {
                MenuItemsView(items: items, onSelect: select)
            } label: {
                menuLabel
            }
        case "ContextMenu":
            // The wrapped children ARE the right-click target, rendered
            // inline. One vertical wrapper makes the whole region a single
            // target (typical usage wraps one container child).
            VStack(alignment: .leading, spacing: 0) {
                NodeChildren(node: node)
            }
            .contextMenu {
                MenuItemsView(items: items, onSelect: select)
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var menuLabel: some View {
        if let image = node.str("systemImage") {
            SwiftUI.Label {
                NodeLabel(node: node)
            } icon: {
                Image(systemName: image)
            }
        } else {
            NodeLabel(node: node)
        }
    }
}
