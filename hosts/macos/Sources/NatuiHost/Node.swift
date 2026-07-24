import AppKit
import Foundation
import Observation

/// One UI node. Per-node @Observable means SwiftUI re-evaluates only the
/// views that read the properties that actually changed; a keystroke in one
/// TextField never re-renders the rest of the tree.
@Observable @MainActor
final class Node: Identifiable {
    let id: Int
    let kind: String
    var props: [String: JSONValue]
    var text: String
    var children: [Node] = []
    /// Monotonic counter for optimistic local edits (protocol seq/ack).
    @ObservationIgnored var lastSentSeq = 0

    init(id: Int, kind: String, props: [String: JSONValue] = [:], text: String = "") {
        self.id = id
        self.kind = kind
        self.props = props
        self.text = text
    }

    /// A user edit of this node's value: optimistic local write, seq bump,
    /// change event carrying the seq (protocol seq/ack). The single code path
    /// for control bindings AND the `edit` debug message, so automated tests
    /// exercise exactly what real interaction does. No-ops when the value is
    /// unchanged (mirrors the bindings' equality guards).
    func userEdit(_ value: JSONValue) {
        guard props["value"] != value else { return }
        props["value"] = value
        lastSentSeq += 1
        Emitter.event(id, "change", payload: ["value": value.anyValue], seq: lastSentSeq)
    }
}

@Observable @MainActor
final class Store {
    static let shared = Store()

    var rootChildren: [Node] = []

    @ObservationIgnored var byId: [Int: Node] = [:]
    @ObservationIgnored var parentOf: [Int: Int] = [:] // childId -> parentId (0 = root)

    // -- op application -----------------------------------------------------

    func apply(ops: [OpMsg]) {
        for op in ops {
            switch op.op {
            case "create":
                guard let id = op.id, let kind = op.kind else { break }
                byId[id] = Node(id: id, kind: kind, props: op.props ?? [:])
            case "createText":
                guard let id = op.id else { break }
                byId[id] = Node(id: id, kind: "#text", text: op.text ?? "")
            case "append":
                guard let parent = op.parent, let child = op.child, let node = byId[child] else { break }
                detach(child)
                withChildren(of: parent) { $0.append(node) }
                parentOf[child] = parent
            case "insert":
                guard let parent = op.parent, let child = op.child, let before = op.before,
                      let node = byId[child] else { break }
                detach(child)
                withChildren(of: parent) { list in
                    if let idx = list.firstIndex(where: { $0.id == before }) {
                        list.insert(node, at: idx)
                    } else {
                        list.append(node)
                    }
                }
                parentOf[child] = parent
            case "remove":
                guard let child = op.child else { break }
                detach(child)
                destroy(child)
            case "update":
                guard let id = op.id, let node = byId[id], var props = op.props else { break }
                // Echo suppression: if the user edited since JS produced this
                // update, keep the local value (see docs/protocol.md).
                if let ack = op.ack, node.lastSentSeq > ack, let local = node.props["value"] {
                    props["value"] = local
                }
                // Never assign identical props: assigning through @Observable
                // invalidates readers even for equal values, and equal-string
                // TextField writes can still reset selection.
                if props != node.props {
                    node.props = props
                }
            case "text":
                guard let id = op.id, let node = byId[id], let text = op.text else { break }
                if node.text != text {
                    node.text = text
                }
            case "clear":
                let ids = rootChildren.map(\.id)
                rootChildren = []
                for id in ids {
                    parentOf[id] = nil
                    destroy(id)
                }
            default:
                Emitter.log("unknown op: \(op.op)")
            }
        }
        // Window chrome (MenuBar/Toolbar) diffs against the fresh root state
        // once per commit, after all ops applied (atomic like the UI pass).
        ChromeSync.shared.sync(rootChildren: rootChildren)
    }

    private func withChildren(of parentId: Int, _ body: (inout [Node]) -> Void) {
        if parentId == 0 {
            body(&rootChildren)
        } else if let parent = byId[parentId] {
            body(&parent.children)
        }
    }

    private func detach(_ childId: Int) {
        guard let parentId = parentOf[childId] else { return }
        withChildren(of: parentId) { list in
            list.removeAll { $0.id == childId }
        }
        parentOf[childId] = nil
    }

    private func destroy(_ id: Int) {
        guard let node = byId[id] else { return }
        for child in node.children {
            parentOf[child.id] = nil
            destroy(child.id)
        }
        byId[id] = nil
    }

    // -- debug dump -----------------------------------------------------------

    func dumpTree() -> [String: Any] {
        func dump(_ node: Node) -> [String: Any] {
            var out: [String: Any] = ["id": node.id, "kind": node.kind]
            if node.kind == "#text" {
                out["text"] = node.text
            } else {
                out["props"] = node.props.mapValues { $0.anyValue }
                out["children"] = node.children.map(dump)
            }
            return out
        }
        return [
            "id": 0,
            "kind": "#root",
            "children": rootChildren.map(dump),
        ]
    }
}
