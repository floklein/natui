import SwiftUI

/// Content kinds: Label, Link, Section (standalone form).
/// Sections INSIDE a List are rendered by ListNodeView as real SwiftUI
/// Sections (modifier-free, so list sectioning survives); this standalone
/// path is the generic grouping used in plain stacks/forms.
struct ContentNodeView: View {
    let node: Node

    var body: some View {
        switch node.kind {
        case "Label":
            SwiftUI.Label {
                NodeLabel(node: node)
            } icon: {
                Image(systemName: node.str("systemImage") ?? "questionmark.circle")
            }
        case "Link":
            linkView
        case "Section":
            sectionView
        case "DisclosureGroup":
            // Always controlled: `value` is the expanded state; the chevron
            // click is an optimistic userEdit riding seq/ack.
            DisclosureGroup(node.str("label") ?? "", isExpanded: node.boolBinding) {
                VStack(alignment: .leading, spacing: 6) {
                    NodeChildren(node: node)
                }
                // The disclosure content area is proposed the full row width;
                // without this the content column floats centered.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var linkView: some View {
        if let url = URL(string: node.str("url") ?? ""), url.scheme != nil {
            SwiftUI.Link(destination: url) { NodeLabel(node: node) }
                // Informative press event, then the system opens the URL.
                .environment(\.openURL, OpenURLAction { _ in
                    Emitter.event(node.id, "press")
                    return .systemAction
                })
        } else {
            // Invalid URL: degrade to plain text rather than a dead control.
            Text(node.joinedText)
        }
    }

    private var sectionView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header = node.str("header") {
                Text(header)
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }
            NodeChildren(node: node)
            if let footer = node.str("footer") {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
