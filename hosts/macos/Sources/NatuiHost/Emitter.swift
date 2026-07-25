import Foundation

/// Thread-safe NDJSON writer for the protocol channel (stdout).
/// stdout is made unbuffered at process start (see main.swift); the lock
/// prevents interleaved writes. All diagnostics go to stderr, never here.
enum Emitter {
    private static let lock = NSLock()

    /// Embedded mode (JSHost): every outbound message is also delivered into
    /// the in-process JS context. Stdout stays active so external probes can
    /// still drive the debug channel (dump/emit/screenshot) over pipes.
    nonisolated(unsafe) static var jsSink: ((String) -> Void)?

    static func send(_ obj: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(obj),
              let payload = try? JSONSerialization.data(withJSONObject: obj)
        else {
            log("emitter: refusing to send invalid JSON object")
            return
        }
        if let sink = jsSink, let line = String(data: payload, encoding: .utf8) {
            sink(line)
        }
        var data = payload
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        // Throwing variant + ignored SIGPIPE (see main.swift): a write racing
        // JS shutdown must not abort the host with an uncatchable exception.
        try? FileHandle.standardOutput.write(contentsOf: data)
    }

    static func ready() {
        send(["t": "ready", "platform": "macos", "protocol": 1, "hostApi": 1])
    }

    static func event(_ id: Int, _ name: String, payload: [String: Any] = [:], seq: Int? = nil) {
        var msg: [String: Any] = ["t": "event", "id": id, "name": name, "payload": payload]
        if let seq { msg["seq"] = seq }
        send(msg)
    }

    static func windowClosed() {
        send(["t": "window", "name": "close"])
    }

    static func tree(_ root: [String: Any]) {
        send(["t": "tree", "root": root])
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("[natui-host] \(message)\n".utf8))
    }
}
