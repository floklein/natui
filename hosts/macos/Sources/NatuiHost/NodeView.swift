import SwiftUI

// Typed prop accessors and binding factories live in NodeProps.swift.

// MARK: - Small mapping helpers

private func fontFor(_ name: String?) -> Font? {
    switch name {
    case "largeTitle": .largeTitle
    case "title": .title
    case "title2": .title2
    case "title3": .title3
    case "headline": .headline
    case "body": .body
    case "callout": .callout
    case "caption": .caption
    default: nil
    }
}

private func weightFor(_ name: String?) -> Font.Weight? {
    switch name {
    case "regular": .regular
    case "medium": .medium
    case "semibold": .semibold
    case "bold": .bold
    default: nil
    }
}

private func hAlignFor(_ name: String?) -> HorizontalAlignment {
    switch name {
    case "leading": .leading
    case "trailing": .trailing
    default: .center
    }
}

private func vAlignFor(_ name: String?) -> VerticalAlignment {
    switch name {
    case "top": .top
    case "bottom": .bottom
    default: .center
    }
}

extension Color {
    init?(hexString: String?) {
        guard var s = hexString?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        guard Scanner(string: s).scanHexInt64(&v) else { return nil }
        let r: Double, g: Double, b: Double, a: Double
        switch s.count {
        case 6:
            (r, g, b, a) = (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255, 1)
        case 8:
            (r, g, b, a) = (Double((v >> 24) & 0xFF) / 255, Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
        default:
            return nil
        }
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

// MARK: - Root

struct RootView: View {
    let store: Store

    var body: some View {
        Group {
            if store.rootChildren.isEmpty {
                ProgressView()
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(store.rootChildren, id: \.id) { NodeView(node: $0) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Recursive node renderer

struct NodeView: View {
    let node: Node

    var body: some View {
        if node.flag("hidden") {
            EmptyView()
        } else {
            content
                .modifier(CommonMods(node: node))
        }
    }

    /// Container children: element children as NodeViews, bare `#text`
    /// children as plain Text (they are part of the typed API and must not
    /// be dropped by stacks).
    @ViewBuilder
    private var childViews: some View {
        ForEach(node.children, id: \.id) { child in
            if child.kind == "#text" {
                Text(child.text)
            } else {
                NodeView(node: child)
            }
        }
    }

    /// Label for Button/Toggle: pure-text fast path; mixed labels like
    /// <Button><Image/> Delete</Button> keep every child in order.
    @ViewBuilder
    private var labelContent: some View {
        if node.nonTextChildren.isEmpty {
            Text(node.joinedText)
        } else {
            HStack(spacing: 4) { childViews }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch node.kind {
        case "VStack":
            VStack(alignment: hAlignFor(node.str("alignment")), spacing: node.num("spacing")) { childViews }
        case "HStack":
            HStack(alignment: vAlignFor(node.str("alignment")), spacing: node.num("spacing")) { childViews }
        case "ZStack":
            ZStack { childViews }
        case "Text", "#text":
            if node.kind == "Text" && !node.nonTextChildren.isEmpty {
                // Mixed content (<Text>Total: <Image/></Text>): keep every
                // child, in order, text rendered inline.
                HStack(spacing: 0) { childViews }
            } else {
                textView
            }
        case "Button":
            buttonView
        case "TextField":
            textFieldView
        case "Toggle":
            toggleView
        case "Slider":
            sliderView
        case "Picker":
            pickerView
        case "ScrollView":
            if node.str("axis") == "horizontal" {
                ScrollView(.horizontal) { HStack(spacing: 0) { childViews } }
            } else {
                ScrollView { VStack(alignment: .leading, spacing: 0) { childViews } }
            }
        case "List":
            ListNodeView(node: node)
        case "Image":
            Image(systemName: node.str("systemName") ?? "questionmark.circle")
                .font(.system(size: node.num("size") ?? 15))
        case "Spacer":
            Spacer(minLength: node.num("minLength"))
        case "Divider":
            Divider()
        case "ProgressView":
            if let value = node.dbl("value") {
                ProgressView(value: min(max(value, 0), 1))
            } else {
                ProgressView()
            }
        default:
            // Second-tier switch for the app-shell kinds (SwiftUI's
            // ViewBuilder has a hard branch limit per builder; the unknown-
            // kind fallback lives there too).
            ExtendedNodeView(node: node)
        }
    }

    // -- Text ----------------------------------------------------------------

    private var textView: some View {
        Text(node.kind == "#text" ? node.text : node.joinedText)
            .font(node.num("size").map { .system(size: $0) } ?? fontFor(node.str("font")))
            .fontWeight(weightFor(node.str("weight")))
            .italic(node.flag("italic"))
            .strikethrough(node.flag("strikethrough"))
            .monospaced(node.flag("monospaced"))
            .lineLimit(node.num("lineLimit").map { Int($0) })
    }

    // -- Button ----------------------------------------------------------------

    private var buttonRole: ButtonRole? {
        switch node.str("role") {
        case "destructive": .destructive
        case "cancel": .cancel
        default: nil
        }
    }

    @ViewBuilder
    private var buttonView: some View {
        let base = Button(role: buttonRole) {
            Emitter.event(node.id, "press")
        } label: {
            labelContent
        }
        switch node.str("variant") {
        case "bordered": base.buttonStyle(.bordered)
        case "prominent": base.buttonStyle(.borderedProminent)
        case "plain": base.buttonStyle(.plain)
        case "link": base.buttonStyle(.link)
        default: base
        }
    }

    // -- TextField ----------------------------------------------------------------

    private var textBinding: Binding<String> {
        Binding(
            get: { node.str("value") ?? "" },
            // Optimistic local write + seq so JS echoes can be
            // staleness-checked (protocol seq/ack); see Node.userEdit.
            set: { node.userEdit(.string($0)) }
        )
    }

    @ViewBuilder
    private var textFieldView: some View {
        let placeholder = node.str("placeholder") ?? ""
        Group {
            if node.flag("secure") {
                SecureField(placeholder, text: textBinding)
            } else {
                TextField(placeholder, text: textBinding)
            }
        }
        .textFieldStyle(.roundedBorder)
        .onSubmit {
            Emitter.event(node.id, "submit", payload: ["value": node.str("value") ?? ""])
        }
    }

    // -- Toggle / Slider / Picker ------------------------------------------------

    @ViewBuilder
    private var toggleView: some View {
        let base = Toggle(isOn: node.boolBinding) { labelContent }
        switch node.str("style") {
        case "switch": base.toggleStyle(.switch)
        case "checkbox": base.toggleStyle(.checkbox)
        default: base // automatic: the platform default (checkbox on macOS)
        }
    }

    private var sliderBinding: Binding<Double> {
        Binding(
            get: { node.dbl("value") ?? 0 },
            set: { node.userEdit(.number($0)) }
        )
    }

    @ViewBuilder
    private var sliderView: some View {
        let range = (node.dbl("min") ?? 0) ... max(node.dbl("max") ?? 1, (node.dbl("min") ?? 0) + 0.001)
        if let step = node.dbl("step"), step > 0 {
            Slider(value: sliderBinding, in: range, step: step)
        } else {
            Slider(value: sliderBinding, in: range)
        }
    }

    private var pickerBinding: Binding<String> {
        Binding(
            get: { node.str("value") ?? "" },
            set: { node.userEdit(.string($0)) }
        )
    }

    @ViewBuilder
    private var pickerView: some View {
        let options = node.props["options"]?.arrayValue ?? []
        let base = Picker(node.str("label") ?? "", selection: pickerBinding) {
            ForEach(options.indices, id: \.self) { i in
                let opt = options[i].objectValue
                Text(opt?["label"]?.stringValue ?? "")
                    .tag(opt?["value"]?.stringValue ?? "")
            }
        }
        switch node.str("style") {
        case "segmented": base.pickerStyle(.segmented)
        case "radioGroup": base.pickerStyle(.radioGroup)
        default: base.pickerStyle(.menu) // automatic/menu: previous behavior
        }
    }
}

// MARK: - Common modifiers

/// Canonical modifier order (documented in the protocol):
/// padding → background → cornerRadius (clip) → frame → opacity → disabled → help.
struct CommonMods: ViewModifier {
    let node: Node

    func body(content: Content) -> some View {
        content
            .padding(paddingInsets)
            .background(Color(hexString: node.str("background")) ?? .clear)
            // Structure must stay constant when cornerRadius appears or
            // disappears (an if/else here resets the whole subtree's SwiftUI
            // state: focus, scroll position). AnyShape keeps one clipShape
            // node; the no-radius case is a hugely outset rectangle, i.e. a
            // no-op clip that doesn't cut focus rings.
            .clipShape(clipShape)
            .modifier(FrameMods(frame: node.props["frame"]?.objectValue))
        // ForegroundStyle() resolves to the inherited style, so nodes without
        // a color prop pass their parent's color through.
        .foregroundStyle(
            Color(hexString: node.str("color")).map(AnyShapeStyle.init)
                ?? AnyShapeStyle(ForegroundStyle())
        )
        .opacity(node.dbl("opacity") ?? 1)
        .disabled(node.flag("disabled"))
        .help(node.str("help") ?? "")
        .modifier(A11yMods(node: node))
    }

    private var clipShape: AnyShape {
        if let radius = node.num("cornerRadius") {
            AnyShape(RoundedRectangle(cornerRadius: radius))
        } else {
            AnyShape(Rectangle().inset(by: -100_000))
        }
    }

    private var paddingInsets: EdgeInsets {
        if let all = node.num("padding") {
            return EdgeInsets(top: all, leading: all, bottom: all, trailing: all)
        }
        if let obj = node.props["padding"]?.objectValue {
            return EdgeInsets(
                top: obj["top"]?.cgFloatValue ?? 0,
                leading: obj["leading"]?.cgFloatValue ?? 0,
                bottom: obj["bottom"]?.cgFloatValue ?? 0,
                trailing: obj["trailing"]?.cgFloatValue ?? 0
            )
        }
        return EdgeInsets()
    }
}

/// Accessibility props (ported from the PR #1 design): label and hint are
/// only attached when present so controls keep their intrinsic AX labels;
/// the identifier is always applied (empty string = none, a no-op).
/// Toggling label/hint presence changes view structure (state reset), which
/// is acceptable: accessibility metadata is static in practice.
struct A11yMods: ViewModifier {
    let node: Node

    func body(content: Content) -> some View {
        labeled(content)
            .accessibilityIdentifier(node.str("accessibilityIdentifier") ?? "")
    }

    @ViewBuilder
    private func labeled(_ content: Content) -> some View {
        switch (node.str("accessibilityLabel"), node.str("accessibilityHint")) {
        case let (label?, hint?):
            content.accessibilityLabel(Text(label)).accessibilityHint(Text(hint))
        case let (label?, nil):
            content.accessibilityLabel(Text(label))
        case let (nil, hint?):
            content.accessibilityHint(Text(hint))
        case (nil, nil):
            content
        }
    }
}

struct FrameMods: ViewModifier {
    let frame: [String: JSONValue]?

    // All-nil frame modifiers are layout no-ops, so no conditional (and no
    // AnyView) is needed.
    func body(content: Content) -> some View {
        content
            .frame(width: dim("width"), height: dim("height"))
            .frame(
                minWidth: dim("minWidth"), maxWidth: dim("maxWidth"),
                minHeight: dim("minHeight"), maxHeight: dim("maxHeight")
            )
    }

    private func dim(_ key: String) -> CGFloat? {
        guard let value = frame?[key] else { return nil }
        if value.stringValue == "infinity" { return .infinity }
        return value.cgFloatValue
    }
}
