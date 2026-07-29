import SwiftUI

/// Second-tier kind switch. NodeView's builder delegates its `default:` here
/// so neither file (nor its type-check time) grows unwieldy; this is also
/// where the unknown-kind fallback now lives.
struct ExtendedNodeView: View {
    let node: Node

    var body: some View {
        switch node.kind {
        case "Label", "Link", "Section", "DisclosureGroup":
            ContentNodeView(node: node)
        case "SearchField", "DatePicker", "Stepper", "TextEditor":
            InputNodeView(node: node)
        case "Menu", "ContextMenu":
            MenuNodeView(node: node)
        case "SplitView", "Sidebar", "Detail", "TabView", "Tab":
            NavigationNodeView(node: node)
        case "Table":
            TableNodeView(node: node)
        case "Sheet", "Alert", "Popover", "PopoverContent":
            PresentationNodeView(node: node)
        case "MenuBar", "Toolbar":
            // Window chrome: ordinary Store nodes (dump/emit address them by
            // id) with no in-window rendering. ChromeSync drives the real
            // NSMenu / NSToolbar from root-attached instances.
            EmptyView()
        default:
            Text("⚠️ \(node.kind)").foregroundStyle(.red)
        }
    }
}
