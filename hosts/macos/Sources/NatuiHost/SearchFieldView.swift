import AppKit
import SwiftUI

/// A real NSSearchField (native look, magnifier, cancel button, Esc-to-clear)
/// rather than a styled TextField. Text changes ride the standard optimistic
/// userEdit path; Enter emits a `submit` event like TextField.
struct SearchFieldView: NSViewRepresentable {
    let node: Node

    func makeCoordinator() -> Coordinator {
        Coordinator(node: node)
    }

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.delegate = context.coordinator
        // The action would fire on Enter anyway, but submit is handled via
        // doCommandBy so the change/submit split matches TextField exactly.
        field.sendsWholeSearchString = false
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.node = node
        // Write only on inequality: rewriting an equal string still resets
        // the caret and selection (same rule as the protocol's update op).
        let value = node.str("value") ?? ""
        if field.stringValue != value {
            field.stringValue = value
        }
        let placeholder = node.str("placeholder") ?? ""
        if field.placeholderString != placeholder {
            field.placeholderString = placeholder
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var node: Node

        init(node: Node) {
            self.node = node
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField else { return }
            // Optimistic local write + seq (protocol seq/ack), the same code
            // path as the edit debug message; no-ops on equal values.
            node.userEdit(.string(field.stringValue))
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                Emitter.event(node.id, "submit", payload: ["value": node.str("value") ?? ""])
                return true
            }
            return false
        }
    }
}
