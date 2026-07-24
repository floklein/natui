import SwiftUI

// MARK: - Typed prop accessors (shared by NodeView and the extended kinds)

extension Node {
    func str(_ key: String) -> String? { props[key]?.stringValue }
    func num(_ key: String) -> CGFloat? { props[key]?.cgFloatValue }
    func dbl(_ key: String) -> Double? { props[key]?.doubleValue }
    func flag(_ key: String) -> Bool { props[key]?.boolValue ?? false }

    /// Concatenated `#text` children, the label of Text/Button/Toggle nodes.
    var joinedText: String {
        children.compactMap { $0.kind == "#text" ? $0.text : nil }.joined()
    }

    var nonTextChildren: [Node] {
        children.filter { $0.kind != "#text" }
    }
}

// MARK: - Binding factories
//
// Every controlled kind rides the same seq/ack path: the binding's setter is
// a user edit (optimistic local write + seq bump + change event), identical
// to the existing TextField/Toggle/Slider/Picker bindings in NodeView.

extension Node {
    var stringBinding: Binding<String> {
        Binding(
            get: { self.str("value") ?? "" },
            set: { self.userEdit(.string($0)) }
        )
    }

    var boolBinding: Binding<Bool> {
        Binding(
            get: { self.props["value"]?.boolValue ?? false },
            set: { self.userEdit(.bool($0)) }
        )
    }

    var doubleBinding: Binding<Double> {
        Binding(
            get: { self.dbl("value") ?? 0 },
            set: { self.userEdit(.number($0)) }
        )
    }

    /// Selection-style binding: string value or null (deselection).
    var optionalStringBinding: Binding<String?> {
        Binding(
            get: { self.str("value") },
            set: { self.userEdit($0.map(JSONValue.string) ?? .null) }
        )
    }

    /// Multi-selection binding; the wire form is a SORTED string array so
    /// repeated dumps are deterministic.
    var stringSetBinding: Binding<Set<String>> {
        Binding(
            get: {
                if let arr = self.props["value"]?.arrayValue {
                    return Set(arr.compactMap(\.stringValue))
                }
                if let single = self.str("value") { return [single] }
                return []
            },
            set: { self.userEdit(.array($0.sorted().map(JSONValue.string))) }
        )
    }

    /// Presentation binding (Sheet/Alert/Popover): `get` is the controlled
    /// presented state; `set` only ever reports DISMISSAL as an optimistic
    /// edit. Hosts never present on their own, so set(true) is a no-op.
    var presentedBinding: Binding<Bool> {
        Binding(
            get: { self.flag("value") },
            set: { if !$0 { self.userEdit(.bool(false)) } }
        )
    }
}

// MARK: - Shared child renderers

/// Container children: element children as NodeViews, bare `#text` children
/// as plain Text (part of the typed API; stacks must not drop them).
struct NodeChildren: View {
    let node: Node

    var body: some View {
        ForEach(node.children, id: \.id) { child in
            if child.kind == "#text" {
                Text(child.text)
            } else {
                NodeView(node: child)
            }
        }
    }
}

/// Label for Button/Toggle/Menu/Link: pure-text fast path; mixed labels like
/// <Button><Image/> Delete</Button> keep every child in order.
struct NodeLabel: View {
    let node: Node

    var body: some View {
        if node.nonTextChildren.isEmpty {
            Text(node.joinedText)
        } else {
            HStack(spacing: 4) { NodeChildren(node: node) }
        }
    }
}

// MARK: - Badges

extension Node {
    /// The `badge` common prop as Text (nil clears; .badge(nil) is a no-op).
    var badgeText: Text? {
        switch props["badge"] {
        case .some(.number(let n)):
            Text(String(Int(n)))
        case .some(.string(let s)) where !s.isEmpty:
            Text(s)
        default:
            nil
        }
    }
}
