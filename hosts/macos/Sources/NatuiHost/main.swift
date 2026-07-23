import AppKit
import SwiftUI

// Pipes are fully buffered by default: without this, protocol messages sit in
// the stdout buffer and the JS side never sees them. Must run before any write.
setvbuf(stdout, nil, _IONBF, 0)
// Writes to a closed pipe (JS died first) must surface as errors, not SIGPIPE.
signal(SIGPIPE, SIG_IGN)

// MARK: - Window management

@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    static let shared = WindowManager()

    private(set) var window: NSWindow?

    func configure(props: [String: JSONValue]) {
        let width = props["width"]?.cgFloatValue ?? 640
        let height = props["height"]?.cgFloatValue ?? 480
        let title = props["title"]?.stringValue ?? "natui"

        let window = self.window ?? makeWindow()
        window.title = title
        window.setContentSize(NSSize(width: width, height: height))
        if let minW = props["minWidth"]?.cgFloatValue, let minH = props["minHeight"]?.cgFloatValue {
            window.contentMinSize = NSSize(width: minW, height: minH)
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        // Toolbar specs that arrived before the window apply now.
        ChromeSync.shared.windowReady(window)
        // Required for unbundled executables, otherwise keystrokes keep going
        // to the terminal that spawned us.
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWindow() -> NSWindow {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.contentView = NSHostingView(rootView: RootView(store: Store.shared))
        self.window = win
        return win
    }

    func windowWillClose(_ notification: Notification) {
        // JS decides what happens next (usually: unmount + quit message).
        Emitter.windowClosed()
    }

    /// Debug: render our own window to a PNG. Needs no screen-recording
    /// permission because it never reads the actual screen. Captures the
    /// frame view (title bar + window background), not just the content: /// otherwise dark-mode text sits on a transparent background.
    func screenshot(to path: String) {
        // Always reply, even on failure, a silent failure would leave the
        // JS-side requestScreenshot() promise pending forever.
        func fail(_ reason: String) {
            Emitter.log("screenshot: \(reason)")
            Emitter.send(["t": "shot", "path": path, "error": reason])
        }
        guard let contentView = window?.contentView else {
            return fail("no window content view")
        }
        var view: NSView = contentView
        while let superview = view.superview { view = superview }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return fail("could not create bitmap rep")
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            return fail("PNG encoding failed")
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            Emitter.send(["t": "shot", "path": path])
        } catch {
            fail("write failed: \(error)")
        }
    }
}

// MARK: - Message routing

@MainActor
enum Router {
    static func handle(_ msg: InMessage) {
        switch msg.t {
        case "window":
            WindowManager.shared.configure(props: msg.props ?? [:])
        case "commit":
            Store.shared.apply(ops: msg.ops ?? [])
        case "dump":
            Emitter.tree(Store.shared.dumpTree())
        case "screenshot":
            WindowManager.shared.screenshot(to: msg.path ?? "/tmp/natui-shot.png")
        case "emit":
            // Debug: synthesize a user event, exercising the full round trip.
            if let id = msg.id, let name = msg.name {
                let payload = (msg.payload ?? [:]).mapValues { $0.anyValue }
                Emitter.event(id, name, payload: payload)
            }
        case "edit":
            // Debug: a real optimistic user edit, through the same path as
            // the control bindings (local write + seq + change event).
            if let id = msg.id, let value = msg.value {
                if let node = Store.shared.byId[id] {
                    node.userEdit(value)
                } else {
                    Emitter.log("edit: unknown node \(id)")
                }
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            Emitter.log("unknown message type: \(msg.t)")
        }
    }
}

// MARK: - Stdin reader

/// Blocking NDJSON reader on a dedicated thread. One protocol message becomes
/// exactly one MainActor hop, so SwiftUI renders once per React commit.
///
/// `terminateOnEOF` differs by mode: in sidecar mode stdin is the lifeline to
/// the JS process, so EOF means the app must not outlive it as an orphan. In
/// embedded (--bundle) mode the app is self-contained and stdin is only the
/// optional debug channel; a closed stdin must not terminate the application.
func startStdinReader(terminateOnEOF: Bool) {
    let thread = Thread {
        let decoder = JSONDecoder()
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8),
                  let msg = try? decoder.decode(InMessage.self, from: data)
            else {
                Emitter.log("bad message: \(line.prefix(200))")
                continue
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    Router.handle(msg)
                }
            }
        }
        if terminateOnEOF {
            // EOF: the JS process died or closed the pipe. Exit cleanly.
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        } else {
            Emitter.log("stdin closed; embedded app keeps running without the debug channel")
        }
    }
    thread.name = "natui.stdin"
    thread.qualityOfService = .userInitiated
    thread.start()
}

// MARK: - App bootstrap

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            // Mode is decided BEFORE the stdin reader starts, because it
            // changes what stdin EOF means (see startStdinReader).
            let bundlePath = embeddedBundlePath()
            // Stdin stays active in both modes: in embedded mode it is the
            // debug channel (dump/emit/screenshot/edit) for external probes.
            startStdinReader(terminateOnEOF: bundlePath == nil)
            if let bundlePath {
                // Stage 2: evaluate the React bundle in-process (JSC). The
                // ready message is sent after the bundle registered its
                // receive hook, and reaches both the JS sink and stdout.
                JSHost.shared.start(bundlePath: bundlePath)
            }
            // Only now are we able to process messages; JS waits for this.
            Emitter.ready()
        }
    }

    private func embeddedBundlePath() -> String? {
        let args = CommandLine.arguments
        guard let flagIndex = args.firstIndex(of: "--bundle"), args.indices.contains(flagIndex + 1) else {
            return nil
        }
        return args[flagIndex + 1]
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // The JS side orchestrates shutdown via the quit message.
        false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Must be set before run() so the process becomes a real, focusable GUI app.
app.setActivationPolicy(.regular)
app.run()
