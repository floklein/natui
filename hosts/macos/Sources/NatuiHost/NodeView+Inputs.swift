import SwiftUI

/// New controlled input kinds: SearchField, DatePicker, Stepper, TextEditor.
/// All are one `value` prop over the standard binding factories (seq/ack).
struct InputNodeView: View {
    let node: Node

    var body: some View {
        switch node.kind {
        case "SearchField":
            SearchFieldView(node: node)
        case "DatePicker":
            datePickerView
        case "Stepper":
            stepperView
        case "TextEditor":
            TextEditor(text: node.stringBinding)
                .font(.body)
        default:
            EmptyView()
        }
    }

    // -- DatePicker -----------------------------------------------------------

    private var displayedComponents: DatePickerComponents {
        switch node.str("displayedComponents") {
        case "time": [.hourAndMinute]
        case "dateTime": [.date, .hourAndMinute]
        default: [.date]
        }
    }

    private var dateBinding: Binding<Date> {
        let formatter = NatuiDateFormat.formatter(for: node.str("displayedComponents"))
        return Binding(
            get: {
                formatter.date(from: node.str("value") ?? "")
                    // Missing/invalid value: a fixed reference date, so the
                    // control shows something deterministic (never "now").
                    ?? Date(timeIntervalSinceReferenceDate: 0)
            },
            // Canonical re-serialization: the SAME fixed formatter both ways,
            // so an unchanged round-trip is byte-identical and the host's
            // props-equality guard settles.
            set: { node.userEdit(.string(formatter.string(from: $0))) }
        )
    }

    private var datePickerView: some View {
        DatePicker("", selection: dateBinding, displayedComponents: displayedComponents)
            .labelsHidden()
    }

    // -- Stepper ----------------------------------------------------------------

    @ViewBuilder
    private var stepperView: some View {
        let step = node.dbl("step") ?? 1
        if let min = node.dbl("min"), let max = node.dbl("max"), min <= max {
            Stepper("", value: node.doubleBinding, in: min ... max, step: step)
                .labelsHidden()
        } else {
            Stepper("", value: node.doubleBinding, step: step)
                .labelsHidden()
        }
    }
}

/// Fixed-format, POSIX-locale formatters for the DatePicker wire contract:
/// local wall-clock ISO without a zone (docs/protocol.md). Cached because
/// DateFormatter construction is expensive and bindings re-derive per render.
enum NatuiDateFormat {
    private static let date = make("yyyy-MM-dd")
    private static let time = make("HH:mm")
    private static let dateTime = make("yyyy-MM-dd'T'HH:mm")

    static func formatter(for displayedComponents: String?) -> DateFormatter {
        switch displayedComponents {
        case "time": time
        case "dateTime": dateTime
        default: date
        }
    }

    private static func make(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        // Deliberately the CURRENT time zone: the contract is local wall
        // time; parse and print use the same zone so round-trips are stable.
        return f
    }
}
