export interface MacOSTemplateOptions {
  name: string;
  identifier: string;
  version: string;
  minimumVersion: string;
  width: number;
  height: number;
  resizable: boolean;
}

function swiftStringLiteral(value: string): string {
  let result = '"';
  for (const character of value) {
    const scalar = character.codePointAt(0);
    if (scalar === undefined) continue;
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "\\\\";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (
      scalar < 0x20 ||
      scalar === 0x7f ||
      scalar === 0x2028 ||
      scalar === 0x2029
    ) {
      result += `\\u{${scalar.toString(16)}}`;
    } else if (scalar >= 0xd800 && scalar <= 0xdfff) {
      result += "\\u{fffd}";
    } else {
      result += character;
    }
  }
  return `${result}"`;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function macosInfoPlist(options: MacOSTemplateOptions): string {
  const name = xmlText(options.name);
  const identifier = xmlText(options.identifier);
  const version = xmlText(options.version);
  const minimumVersion = xmlText(options.minimumVersion);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>NatUIHost</string>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${minimumVersion}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}

export function macosHostSource(options: MacOSTemplateOptions): string {
  const name = swiftStringLiteral(options.name);
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 800;
  const height = Number.isFinite(options.height) && options.height > 0 ? options.height : 600;
  const resizable = options.resizable ? "true" : "false";

  return `import AppKit
import Foundation
import SwiftUI

private enum NatUIBuildConfiguration {
    static let name = ${name}
    static let width: CGFloat = ${width}
    static let height: CGFloat = ${height}
    static let resizable = ${resizable}
    static let protocolVersion = 1
}

private enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }
}

private struct WireNode: Codable, Equatable, Identifiable, Sendable {
    let children: [WireNode]
    let events: [String: String]
    let id: String
    let props: [String: JSONValue]
    let type: String
}

private struct HelloMessage: Decodable, Sendable {
    let capabilities: [String]
    let platform: String
    let protocolVersion: Int

    private enum CodingKeys: String, CodingKey {
        case capabilities
        case platform
        case protocolVersion = "protocol"
    }
}

private struct SnapshotMessage: Decodable, Sendable {
    let protocolVersion: Int
    let revision: Int
    let root: WireNode?

    private enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case revision
        case root
    }
}

private struct ControllerErrorMessage: Decodable, Sendable {
    let message: String
    let protocolVersion: Int
    let stack: String?

    private enum CodingKeys: String, CodingKey {
        case message
        case protocolVersion = "protocol"
        case stack
    }
}

private enum HostMessage: Sendable {
    case hello(HelloMessage)
    case snapshot(SnapshotMessage)
    case error(ControllerErrorMessage)

    private struct Header: Decodable {
        let type: String
    }

    static func decode(_ data: Data) throws -> HostMessage {
        let decoder = JSONDecoder()
        let header = try decoder.decode(Header.self, from: data)
        switch header.type {
        case "hello":
            return .hello(try decoder.decode(HelloMessage.self, from: data))
        case "snapshot":
            return .snapshot(try decoder.decode(SnapshotMessage.self, from: data))
        case "error":
            return .error(try decoder.decode(ControllerErrorMessage.self, from: data))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "Unknown host message type: \\(header.type)")
            )
        }
    }
}

private struct ControllerEvent: Encodable, Sendable {
    let handler: String
    let payload: JSONValue?
    let protocolVersion = NatUIBuildConfiguration.protocolVersion
    let type = "event"

    private enum CodingKeys: String, CodingKey {
        case handler
        case payload
        case protocolVersion = "protocol"
        case type
    }
}

private enum ControllerUpdate: Sendable {
    case message(HostMessage)
    case transportError(String)
    case terminated(Int32)
}

private final class ControllerBridge: @unchecked Sendable {
    private let process = Process()
    private let standardInput = Pipe()
    private let standardOutput = Pipe()
    private let standardError = Pipe()
    private let onUpdate: @Sendable (ControllerUpdate) -> Void
    private let lock = NSLock()
    private var outputBuffer = Data()
    private var started = false
    private var stopping = false

    init(onUpdate: @escaping @Sendable (ControllerUpdate) -> Void) {
        self.onUpdate = onUpdate
    }

    func start() throws {
        lock.lock()
        if started {
            lock.unlock()
            return
        }
        started = true
        stopping = false
        lock.unlock()

        guard let resources = Bundle.main.resourceURL else {
            throw CocoaError(.fileNoSuchFile, userInfo: [
                NSLocalizedDescriptionKey: "The app bundle has no Resources directory"
            ])
        }
        let executable = resources.appendingPathComponent("NatUIController", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [
                NSLocalizedDescriptionKey: "Missing executable Contents/Resources/NatUIController"
            ])
        }

        process.executableURL = executable
        process.currentDirectoryURL = resources
        process.standardInput = standardInput
        process.standardOutput = standardOutput
        process.standardError = standardError
        var environment = ProcessInfo.processInfo.environment
        environment["NATUI_PLATFORM"] = "macos"
        environment["NATUI_PROTOCOL_VERSION"] = String(NatUIBuildConfiguration.protocolVersion)
        process.environment = environment

        standardOutput.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consumeStandardOutput(handle.availableData)
        }
        standardError.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            FileHandle.standardError.write(data)
        }
        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.flushStandardOutput()
            self.lock.lock()
            let wasStopping = self.stopping
            self.started = false
            self.lock.unlock()
            if !wasStopping {
                self.onUpdate(.terminated(process.terminationStatus))
            }
        }

        do {
            try process.run()
        } catch {
            standardOutput.fileHandleForReading.readabilityHandler = nil
            standardError.fileHandleForReading.readabilityHandler = nil
            lock.lock()
            started = false
            lock.unlock()
            throw error
        }
    }

    func send(handler: String, payload: JSONValue?) {
        do {
            var data = try JSONEncoder().encode(
                ControllerEvent(handler: handler, payload: payload)
            )
            data.append(0x0A)
            lock.lock()
            let canWrite = started && !stopping && process.isRunning
            if canWrite {
                do {
                    try standardInput.fileHandleForWriting.write(contentsOf: data)
                    lock.unlock()
                } catch {
                    lock.unlock()
                    throw error
                }
            } else {
                lock.unlock()
                throw CocoaError(.fileWriteUnknown, userInfo: [
                    NSLocalizedDescriptionKey: "NatUIController is not running"
                ])
            }
        } catch {
            onUpdate(.transportError("Could not send native event: \\(error.localizedDescription)"))
        }
    }

    func stop() {
        lock.lock()
        guard started, !stopping else {
            lock.unlock()
            return
        }
        stopping = true
        lock.unlock()

        standardOutput.fileHandleForReading.readabilityHandler = nil
        standardError.fileHandleForReading.readabilityHandler = nil
        try? standardInput.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
    }

    deinit {
        stop()
    }

    private func consumeStandardOutput(_ data: Data) {
        if data.isEmpty {
            flushStandardOutput()
            return
        }

        var completeLines: [Data] = []
        lock.lock()
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            completeLines.append(Data(outputBuffer[..<newline]))
            outputBuffer.removeSubrange(...newline)
        }
        lock.unlock()

        completeLines.forEach(decodeLine)
    }

    private func flushStandardOutput() {
        let remainder: Data
        lock.lock()
        remainder = outputBuffer
        outputBuffer.removeAll(keepingCapacity: false)
        lock.unlock()
        if !remainder.isEmpty {
            decodeLine(remainder)
        }
    }

    private func decodeLine(_ data: Data) {
        let trimmed = data.drop(while: { byte in
            byte == 0x20 || byte == 0x09 || byte == 0x0D
        })
        guard !trimmed.isEmpty else { return }
        do {
            onUpdate(.message(try HostMessage.decode(Data(trimmed))))
        } catch {
            let line = String(data: data, encoding: .utf8) ?? "<non-UTF-8 data>"
            onUpdate(.transportError(
                "Invalid NatUIController output: \\(error.localizedDescription). Line: \\(line)"
            ))
        }
    }
}

@MainActor
private final class NatUIModel: ObservableObject {
    @Published private(set) var root: WireNode?
    @Published private(set) var hasSnapshot = false
    @Published private(set) var lastError: String?
    @Published private(set) var connected = false
    private(set) var revision = -1

    private var bridge: ControllerBridge?
    private var didStart = false

    func startIfNeeded() {
        guard !didStart else { return }
        didStart = true
        lastError = nil

        let bridge = ControllerBridge { [weak self] update in
            Task { @MainActor [weak self] in
                self?.receive(update)
            }
        }
        self.bridge = bridge
        do {
            try bridge.start()
        } catch {
            didStart = false
            self.bridge = nil
            lastError = "Could not launch NatUIController: \\(error.localizedDescription)"
        }
    }

    func stop() {
        bridge?.stop()
        bridge = nil
        didStart = false
        connected = false
    }

    func send(handler: String?, payload: JSONValue? = nil) {
        guard let handler else { return }
        bridge?.send(handler: handler, payload: payload)
    }

    private func receive(_ update: ControllerUpdate) {
        switch update {
        case .message(.hello(let hello)):
            guard hello.protocolVersion == NatUIBuildConfiguration.protocolVersion else {
                lastError = "Protocol mismatch: host is v\\(NatUIBuildConfiguration.protocolVersion), controller is v\\(hello.protocolVersion)"
                return
            }
            guard hello.platform == "macos" else {
                lastError = "NatUIController reported the wrong platform: \\(hello.platform)"
                return
            }
            connected = true
        case .message(.snapshot(let snapshot)):
            guard snapshot.protocolVersion == NatUIBuildConfiguration.protocolVersion else {
                lastError = "Ignored snapshot using protocol v\\(snapshot.protocolVersion)"
                return
            }
            guard snapshot.revision >= revision else { return }
            revision = snapshot.revision
            root = snapshot.root
            hasSnapshot = true
        case .message(.error(let controllerError)):
            let stack = controllerError.stack.map { "\\n\\($0)" } ?? ""
            lastError = "NatUIController: \\(controllerError.message)\\(stack)"
        case .transportError(let message):
            lastError = message
        case .terminated(let status):
            connected = false
            didStart = false
            lastError = "NatUIController exited with status \\(status)"
        }
    }
}

private extension WireNode {
    func string(_ key: String) -> String? {
        props[key]?.stringValue
    }

    func number(_ key: String) -> Double? {
        props[key]?.numberValue
    }

    func bool(_ key: String) -> Bool? {
        props[key]?.boolValue
    }
}

private struct HostWindowConfiguration: Equatable {
    let title: String
    let width: CGFloat
    let height: CGFloat
    let resizable: Bool

    static let fallback = HostWindowConfiguration(
        title: NatUIBuildConfiguration.name,
        width: NatUIBuildConfiguration.width,
        height: NatUIBuildConfiguration.height,
        resizable: NatUIBuildConfiguration.resizable
    )

    init(title: String, width: CGFloat, height: CGFloat, resizable: Bool) {
        self.title = title
        self.width = width
        self.height = height
        self.resizable = resizable
    }

    init(root: WireNode?) {
        guard let window = root?.firstNode(ofType: "window") else {
            self = .fallback
            return
        }
        title = window.string("title") ?? Self.fallback.title
        width = window.number("width").map { CGFloat($0) } ?? Self.fallback.width
        height = window.number("height").map { CGFloat($0) } ?? Self.fallback.height
        resizable = window.bool("resizable") ?? Self.fallback.resizable
    }
}

private extension WireNode {
    func firstNode(ofType targetType: String) -> WireNode? {
        if type == targetType { return self }
        for child in children {
            if let match = child.firstNode(ofType: targetType) { return match }
        }
        return nil
    }
}

@MainActor
private final class WindowProbeView: NSView {
    var configuration: HostWindowConfiguration {
        didSet {
            if oldValue != configuration { applyConfiguration() }
        }
    }

    init(configuration: HostWindowConfiguration) {
        self.configuration = configuration
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyConfiguration()
    }

    private func applyConfiguration() {
        guard let window else { return }
        window.title = configuration.title
        if configuration.width > 0, configuration.height > 0,
           window.contentView?.bounds.size != NSSize(
               width: configuration.width,
               height: configuration.height
           ) {
            window.setContentSize(NSSize(
                width: configuration.width,
                height: configuration.height
            ))
            window.center()
        }
        if configuration.resizable {
            window.styleMask.insert(.resizable)
        } else {
            window.styleMask.remove(.resizable)
        }
    }
}

private struct WindowConfigurator: NSViewRepresentable {
    let configuration: HostWindowConfiguration

    func makeNSView(context: Context) -> WindowProbeView {
        WindowProbeView(configuration: configuration)
    }

    func updateNSView(_ view: WindowProbeView, context: Context) {
        view.configuration = configuration
    }
}

private enum NatUIPadding {
    case uniform(CGFloat)
    case edges(EdgeInsets)
}

private func natUIPadding(from value: JSONValue?) -> NatUIPadding? {
    if let number = value?.numberValue {
        return .uniform(CGFloat(number))
    }
    guard let object = value?.objectValue else { return nil }
    return .edges(EdgeInsets(
        top: CGFloat(object["top"]?.numberValue ?? 0),
        leading: CGFloat(object["leading"]?.numberValue ?? 0),
        bottom: CGFloat(object["bottom"]?.numberValue ?? 0),
        trailing: CGFloat(object["trailing"]?.numberValue ?? 0)
    ))
}

private func natUIColor(_ name: String) -> Color {
    switch name.lowercased() {
    case "accent": return .accentColor
    case "primary": return .primary
    case "secondary": return .secondary
    case "red": return .red
    case "orange": return .orange
    case "yellow": return .yellow
    case "green": return .green
    case "mint": return .mint
    case "teal": return .teal
    case "cyan": return .cyan
    case "blue": return .blue
    case "indigo": return .indigo
    case "purple": return .purple
    case "pink": return .pink
    case "brown": return .brown
    case "gray", "grey": return .gray
    case "black": return .black
    case "white": return .white
    default:
        if let color = colorFromHex(name) { return color }
        return Color(name)
    }
}

private func colorFromHex(_ source: String) -> Color? {
    guard source.hasPrefix("#") else { return nil }
    var hex = String(source.dropFirst())
    if hex.count == 3 || hex.count == 4 {
        hex = hex.map { "\\($0)\\($0)" }.joined()
    }
    guard hex.count == 6 || hex.count == 8,
          let raw = UInt64(hex, radix: 16) else { return nil }
    let hasAlpha = hex.count == 8
    let red = Double((raw >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
    let green = Double((raw >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
    let blue = Double((raw >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
    let alpha = hasAlpha ? Double(raw & 0xFF) / 255 : 1
    return Color(red: red, green: green, blue: blue, opacity: alpha)
}

private func natUIFontWeight(_ value: String?) -> Font.Weight {
    switch value {
    case "ultralight": return .ultraLight
    case "thin": return .thin
    case "light": return .light
    case "medium": return .medium
    case "semibold": return .semibold
    case "bold": return .bold
    case "heavy": return .heavy
    case "black": return .black
    default: return .regular
    }
}

private func horizontalAlignment(_ value: String?) -> HorizontalAlignment {
    switch value {
    case "leading": return .leading
    case "trailing": return .trailing
    default: return .center
    }
}

private func verticalAlignment(_ value: String?) -> VerticalAlignment {
    switch value {
    case "top": return .top
    case "bottom": return .bottom
    case "firstTextBaseline": return .firstTextBaseline
    case "lastTextBaseline": return .lastTextBaseline
    default: return .center
    }
}

private func stackAlignment(_ value: String?) -> Alignment {
    switch value {
    case "topLeading": return .topLeading
    case "top": return .top
    case "topTrailing": return .topTrailing
    case "leading": return .leading
    case "trailing": return .trailing
    case "bottomLeading": return .bottomLeading
    case "bottom": return .bottom
    case "bottomTrailing": return .bottomTrailing
    default: return .center
    }
}

private func textAlignment(_ value: String?) -> TextAlignment {
    switch value {
    case "center": return .center
    case "trailing": return .trailing
    default: return .leading
    }
}

private struct WireChildren: View {
    let children: [WireNode]

    var body: some View {
        ForEach(children) { child in
            WireNodeView(node: child)
        }
    }
}

private struct ControlledTextField: View {
    @EnvironmentObject private var model: NatUIModel
    let node: WireNode
    @State private var draft: String

    init(node: WireNode) {
        self.node = node
        _draft = State(initialValue: node.string("value") ?? "")
    }

    private var externalValue: String { node.string("value") ?? "" }

    private var binding: Binding<String> {
        Binding(
            get: { draft },
            set: { value in
                draft = value
                model.send(handler: node.events["change"], payload: .string(value))
            }
        )
    }

    var body: some View {
        Group {
            if node.bool("secure") == true {
                SecureField(node.string("placeholder") ?? "", text: binding)
            } else {
                TextField(node.string("placeholder") ?? "", text: binding)
            }
        }
        .onSubmit {
            model.send(handler: node.events["submit"])
        }
        .onChange(of: externalValue) { _, value in
            if draft != value { draft = value }
        }
    }
}

private struct ControlledToggle: View {
    @EnvironmentObject private var model: NatUIModel
    let node: WireNode
    @State private var draft: Bool

    init(node: WireNode) {
        self.node = node
        _draft = State(initialValue: node.bool("value") ?? false)
    }

    private var externalValue: Bool { node.bool("value") ?? false }

    var body: some View {
        Toggle(
            node.string("label") ?? "",
            isOn: Binding(
                get: { draft },
                set: { value in
                    draft = value
                    model.send(handler: node.events["change"], payload: .bool(value))
                }
            )
        )
        .onChange(of: externalValue) { _, value in
            if draft != value { draft = value }
        }
    }
}

private struct ControlledSlider: View {
    @EnvironmentObject private var model: NatUIModel
    let node: WireNode
    @State private var draft: Double

    init(node: WireNode) {
        self.node = node
        _draft = State(initialValue: node.number("value") ?? 0)
    }

    private var lowerBound: Double { node.number("minimum") ?? 0 }
    private var upperBound: Double {
        max(lowerBound + Double.ulpOfOne, node.number("maximum") ?? 1)
    }
    private var externalValue: Double {
        min(max(node.number("value") ?? lowerBound, lowerBound), upperBound)
    }
    private var binding: Binding<Double> {
        Binding(
            get: { min(max(draft, lowerBound), upperBound) },
            set: { value in
                draft = value
                model.send(handler: node.events["change"], payload: .number(value))
            }
        )
    }

    @ViewBuilder
    var body: some View {
        if let step = node.number("step"), step > 0 {
            Slider(value: binding, in: lowerBound...upperBound, step: step)
                .onChange(of: externalValue) { _, value in
                    if draft != value { draft = value }
                }
        } else {
            Slider(value: binding, in: lowerBound...upperBound)
                .onChange(of: externalValue) { _, value in
                    if draft != value { draft = value }
                }
        }
    }
}

private struct WireImage: View {
    let node: WireNode

    private var contentMode: ContentMode {
        node.string("fit") == "fill" ? .fill : .fit
    }

    @ViewBuilder
    var body: some View {
        Group {
            if let systemName = node.string("systemName") {
                Image(systemName: systemName)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if let source = node.string("source"),
                      let url = URL(string: source),
                      url.scheme == "http" || url.scheme == "https" {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty:
                        ProgressView()
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: contentMode)
                    case .failure:
                        Image(systemName: "photo")
                            .resizable()
                            .aspectRatio(contentMode: contentMode)
                    @unknown default:
                        EmptyView()
                    }
                }
            } else if let source = node.string("source"),
                      let image = localImage(source) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Image(systemName: "photo")
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            }
        }
        .accessibilityLabel(node.string("alt") ?? node.string("accessibilityLabel") ?? "Image")
    }

    private func localImage(_ source: String) -> NSImage? {
        if let url = URL(string: source), url.isFileURL,
           let image = NSImage(contentsOf: url) {
            return image
        }
        if source.hasPrefix("/"), let image = NSImage(contentsOfFile: source) {
            return image
        }
        if let resource = Bundle.main.resourceURL?.appendingPathComponent(source),
           let image = NSImage(contentsOf: resource) {
            return image
        }
        return NSImage(named: NSImage.Name(source))
    }
}

private struct WireScrollView: View {
    let node: WireNode

    private var showsIndicators: Bool { node.bool("showsIndicators") ?? true }

    @ViewBuilder
    var body: some View {
        switch node.string("axis") {
        case "horizontal":
            ScrollView(.horizontal, showsIndicators: showsIndicators) {
                HStack(spacing: 0) { WireChildren(children: node.children) }
            }
        case "both":
            ScrollView([.horizontal, .vertical], showsIndicators: showsIndicators) {
                VStack(alignment: .leading, spacing: 0) { WireChildren(children: node.children) }
            }
        default:
            ScrollView(.vertical, showsIndicators: showsIndicators) {
                VStack(alignment: .leading, spacing: 0) { WireChildren(children: node.children) }
            }
        }
    }
}

private struct WireProgressView: View {
    let node: WireNode

    @ViewBuilder
    var body: some View {
        if let value = node.number("value") {
            if let label = node.string("label") {
                ProgressView(value: value) { Text(label) }
            } else {
                ProgressView(value: value)
            }
        } else if let label = node.string("label") {
            ProgressView { Text(label) }
        } else {
            ProgressView()
        }
    }
}

private struct WireNodeView: View {
    @EnvironmentObject private var model: NatUIModel
    let node: WireNode

    var body: some View {
        if node.type == "window" {
            WireChildren(children: node.children)
        } else {
            applyCommonModifiers(to: primitiveView)
        }
    }

    @ViewBuilder
    private var primitiveView: some View {
        switch node.type {
        case "vstack":
            VStack(
                alignment: horizontalAlignment(node.string("alignment")),
                spacing: node.number("spacing").map { CGFloat($0) }
            ) {
                WireChildren(children: node.children)
            }
        case "hstack":
            HStack(
                alignment: verticalAlignment(node.string("alignment")),
                spacing: node.number("spacing").map { CGFloat($0) }
            ) {
                WireChildren(children: node.children)
            }
        case "zstack":
            ZStack(alignment: stackAlignment(node.string("alignment"))) {
                WireChildren(children: node.children)
            }
        case "text":
            configuredText()
        case "rawText":
            Text(node.string("content") ?? "")
        case "button":
            configuredButton()
        case "textfield":
            ControlledTextField(node: node)
        case "toggle":
            ControlledToggle(node: node)
        case "slider":
            ControlledSlider(node: node)
        case "image":
            WireImage(node: node)
        case "scrollview":
            WireScrollView(node: node)
        case "progress":
            WireProgressView(node: node)
        case "spacer":
            Spacer()
        case "divider":
            Divider()
        default:
            VStack(alignment: .leading, spacing: 4) {
                Text("Unsupported NatUI node: \\(node.type)")
                    .foregroundStyle(.red)
                WireChildren(children: node.children)
            }
        }
    }

    private func configuredText() -> AnyView {
        var result = AnyView(
            Text(node.string("content") ?? "")
                .multilineTextAlignment(textAlignment(node.string("textAlign")))
        )
        if let size = node.number("fontSize") {
            result = AnyView(result.font(.system(
                size: CGFloat(size),
                weight: natUIFontWeight(node.string("fontWeight"))
            )))
        } else if node.string("fontWeight") != nil {
            result = AnyView(result.fontWeight(natUIFontWeight(node.string("fontWeight"))))
        }
        if let lineLimit = node.number("lineLimit") {
            result = AnyView(result.lineLimit(max(0, Int(lineLimit))))
        }
        if node.bool("selectable") == true {
            result = AnyView(result.textSelection(.enabled))
        }
        return result
    }

    private func configuredButton() -> AnyView {
        let role: ButtonRole? = switch node.string("role") {
        case "cancel": .cancel
        case "destructive": .destructive
        default: nil
        }
        let button = Button(role: role) {
            model.send(handler: node.events["press"])
        } label: {
            if let title = node.string("title") {
                Text(title)
            } else {
                WireChildren(children: node.children)
            }
        }
        if node.string("background") != nil {
            return AnyView(button.buttonStyle(.plain))
        }
        return AnyView(button)
    }

    private func applyCommonModifiers<Content: View>(to content: Content) -> AnyView {
        var result = AnyView(content)

        let width = node.number("width").map { CGFloat($0) }
        let height = node.number("height").map { CGFloat($0) }
        if width != nil || height != nil {
            result = AnyView(result.frame(width: width, height: height))
        }

        let minWidth = node.number("minWidth").map { CGFloat($0) }
        let maxWidth = node.number("maxWidth").map { CGFloat($0) }
        let minHeight = node.number("minHeight").map { CGFloat($0) }
        let maxHeight = node.number("maxHeight").map { CGFloat($0) }
        if minWidth != nil || maxWidth != nil || minHeight != nil || maxHeight != nil {
            result = AnyView(result.frame(
                minWidth: minWidth,
                maxWidth: maxWidth,
                minHeight: minHeight,
                maxHeight: maxHeight
            ))
        }

        if let padding = natUIPadding(from: node.props["padding"]) {
            switch padding {
            case .uniform(let value):
                result = AnyView(result.padding(value))
            case .edges(let value):
                result = AnyView(result.padding(value))
            }
        }
        if let background = node.string("background") {
            result = AnyView(result.background(natUIColor(background)))
        }
        if let cornerRadius = node.number("cornerRadius") {
            result = AnyView(result.clipShape(
                RoundedRectangle(cornerRadius: CGFloat(cornerRadius), style: .continuous)
            ))
        }
        if let foreground = node.string("foreground") {
            result = AnyView(result.foregroundStyle(natUIColor(foreground)))
        }
        if let opacity = node.number("opacity") {
            result = AnyView(result.opacity(opacity))
        }
        if node.bool("disabled") == true {
            result = AnyView(result.disabled(true))
        }
        if node.bool("hidden") == true {
            result = AnyView(result.hidden())
        }
        if let identifier = node.string("id") {
            result = AnyView(result.id(identifier))
        }
        if let accessibilityIdentifier = node.string("testID") ?? node.string("id") {
            result = AnyView(result.accessibilityIdentifier(accessibilityIdentifier))
        }
        if let label = node.string("accessibilityLabel") {
            result = AnyView(result.accessibilityLabel(Text(label)))
        }
        if let hint = node.string("accessibilityHint") {
            result = AnyView(result.accessibilityHint(Text(hint)))
        }
        return result
    }
}

private struct NatUIRootView: View {
    @EnvironmentObject private var model: NatUIModel

    private var windowConfiguration: HostWindowConfiguration {
        HostWindowConfiguration(root: model.root)
    }

    var body: some View {
        ZStack {
            if let root = model.root {
                WireNodeView(node: root)
            } else if model.hasSnapshot {
                Color.clear
            } else if let error = model.lastError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.orange)
                    Text(error)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                }
                .padding(24)
            } else {
                ProgressView("Starting NatUIController…")
                    .padding(24)
            }
        }
        .background(WindowConfigurator(configuration: windowConfiguration))
        .onAppear { model.startIfNeeded() }
        .onDisappear { model.stop() }
    }
}

@main
private struct NatUIHostApp: App {
    @StateObject private var model = NatUIModel()

    var body: some Scene {
        WindowGroup {
            NatUIRootView()
                .environmentObject(model)
        }
        .defaultSize(
            width: NatUIBuildConfiguration.width,
            height: NatUIBuildConfiguration.height
        )
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}
`;
}
