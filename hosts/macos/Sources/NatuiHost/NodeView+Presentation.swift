import SwiftUI

/// Presentation kinds: Sheet, Alert, Popover. Strategy: each node renders a
/// hidden zero-size anchor (Color.clear, NOT EmptyView: presentation
/// modifiers never fire on EmptyView) and hangs its presentation modifier
/// off it in place. `value` is the controlled presented state; a host-side
/// dismissal is an optimistic userEdit(false), so a refusing app re-presents
/// via the standard corrective update ("prevent dismissal" for free).
///
/// Screenshot limitation (documented): sheets, alerts, and popovers live in
/// separate NSWindows and do NOT appear in cacheDisplay screenshots;
/// presentation coverage is dump-based.
struct PresentationNodeView: View {
    let node: Node

    var body: some View {
        switch node.kind {
        case "Sheet":
            SheetNodeView(node: node)
        case "Alert":
            AlertNodeView(node: node)
        case "Popover":
            PopoverNodeView(node: node)
        case "PopoverContent":
            // Reached when a Popover presents this slot child via NodeView.
            VStack(alignment: .leading, spacing: 0) {
                NodeChildren(node: node)
            }
        default:
            EmptyView()
        }
    }
}

private struct HiddenAnchor: View {
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
    }
}

// MARK: - Sheet

private struct SheetNodeView: View {
    let node: Node

    var body: some View {
        HiddenAnchor()
            .sheet(isPresented: node.presentedBinding) {
                VStack(alignment: .leading, spacing: 0) {
                    NodeChildren(node: node)
                }
            }
    }
}

// MARK: - Alert

struct AlertButtonSpec {
    let id: String
    let label: String
    let role: String?

    static func parseButtons(_ json: JSONValue?) -> [AlertButtonSpec] {
        (json?.arrayValue ?? []).compactMap { entry in
            guard let obj = entry.objectValue, let id = obj["id"]?.stringValue else { return nil }
            return AlertButtonSpec(
                id: id,
                label: obj["label"]?.stringValue ?? id,
                role: obj["role"]?.stringValue
            )
        }
    }
}

private struct AlertNodeView: View {
    let node: Node

    private var buttons: [AlertButtonSpec] {
        AlertButtonSpec.parseButtons(node.props["buttons"])
    }

    /// Dismissal is deferred one runloop tick. Normative event order is
    /// select-then-change; the button action below emits both synchronously,
    /// and this deferral guarantees the order even if SwiftUI writes the
    /// binding before running the action (userEdit no-ops when the action
    /// already dismissed, so there is never a duplicate change).
    private var alertBinding: Binding<Bool> {
        Binding(
            get: { node.flag("value") },
            set: { presented in
                if !presented {
                    DispatchQueue.main.async {
                        node.userEdit(.bool(false))
                    }
                }
            }
        )
    }

    var body: some View {
        HiddenAnchor()
            .alert(node.str("title") ?? "", isPresented: alertBinding) {
                ForEach(buttons.indices, id: \.self) { i in
                    let button = buttons[i]
                    Button(button.label, role: roleFor(button.role)) {
                        // Normative order: select first, then the dismissal
                        // change (docs/protocol.md, Presentation kinds).
                        Emitter.event(node.id, "select", payload: ["value": button.id])
                        node.userEdit(.bool(false))
                    }
                }
            } message: {
                if let message = node.str("message") {
                    Text(message)
                }
            }
    }

    private func roleFor(_ role: String?) -> ButtonRole? {
        switch role {
        case "destructive": .destructive
        case "cancel": .cancel
        default: nil
        }
    }
}

// MARK: - Popover

private struct PopoverNodeView: View {
    let node: Node

    private var contentNode: Node? {
        node.children.first { $0.kind == "PopoverContent" }
    }

    private var anchorChildren: [Node] {
        node.children.filter { $0.kind != "PopoverContent" }
    }

    private var arrowEdge: Edge {
        switch node.str("arrowEdge") {
        case "top": .top
        case "leading": .leading
        case "trailing": .trailing
        default: .bottom
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(anchorChildren, id: \.id) { child in
                if child.kind == "#text" {
                    Text(child.text)
                } else {
                    NodeView(node: child)
                }
            }
        }
        .popover(isPresented: node.presentedBinding, arrowEdge: arrowEdge) {
            if let contentNode {
                NodeView(node: contentNode)
            }
        }
        .onAppear {
            let extras = node.children.filter { $0.kind == "PopoverContent" }
            if extras.count > 1 {
                Emitter.log("Popover \(node.id): ignoring \(extras.count - 1) extra PopoverContent children")
            }
        }
    }
}
