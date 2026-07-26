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
    private var defaultTitle = "NatUI"

    func setDefaultTitle(_ title: String) {
        defaultTitle = title
    }

    func configure(props: [String: JSONValue]) {
        let width = props["width"]?.cgFloatValue ?? 640
        let height = props["height"]?.cgFloatValue ?? 480
        let title = props["title"]?.stringValue ?? defaultTitle

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
        LifecycleCoordinator.shared.windowClosed()
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

// MARK: - Application lifecycle

/// One terminal shutdown path for window close, native Quit, protocol quit,
/// and parent-process loss. Normal close and Quit wait for React to unmount
/// and acknowledge with a `quit` message before JavaScriptCore is released.
@MainActor
final class LifecycleCoordinator {
    static let shared = LifecycleCoordinator()

    private static let quitGracePeriod: TimeInterval = 2

    private var embeddedRuntime = false
    private var awaitingJavaScript = false
    private var pendingApplicationTermination = false
    private var allowTermination = false
    private var completing = false
    private var reportedFailure = false
    private var quitWatchdog: DispatchWorkItem?

    func configure(embeddedRuntime: Bool) {
        self.embeddedRuntime = embeddedRuntime
    }

    func windowClosed() {
        if embeddedRuntime {
            requestGracefulQuit()
        } else {
            // Node mode's optional onClose callback may intentionally keep the
            // host alive. Preserve that API instead of imposing a host timer.
            Emitter.windowClosed()
        }
    }

    func applicationShouldTerminate() -> NSApplication.TerminateReply {
        if allowTermination { return .terminateNow }
        pendingApplicationTermination = true
        requestGracefulQuit()
        return .terminateLater
    }

    func requestGracefulQuit() {
        guard !completing, !awaitingJavaScript else { return }
        awaitingJavaScript = true
        Emitter.windowClosed()

        let watchdog = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.awaitingJavaScript, !self.completing else { return }
                Emitter.log("quit acknowledgement timed out; forcing application termination")
                self.finishQuit()
            }
        }
        quitWatchdog = watchdog
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.quitGracePeriod,
            execute: watchdog
        )
    }

    func completeQuit() {
        finishQuit()
    }

    /// An uncaught JavaScriptCore exception leaves the React runtime in an
    /// unknown state. Report it once, then use the same deferred teardown as
    /// normal quit so the context is never released from its own callback.
    func javascriptFailed(_ message: String) {
        // Latched before the alert's modal loop: a second exception raised
        // during the same main-queue drain must not re-enter this report.
        guard !completing, !reportedFailure else { return }
        reportedFailure = true
        Emitter.log("embedded runtime failed: \(message)")
        // JSHost dispatches this method after the throwing callback returns,
        // so it is safe to cancel timers before entering an alert's modal loop.
        JSHost.shared.stop()
        if Bundle.main.bundleURL.pathExtension == "app" {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "This application encountered an error."
            alert.informativeText = message
            alert.runModal()
        }
        finishQuit()
    }

    /// The sidecar's stdin reached EOF, so no JavaScript process remains to
    /// acknowledge cleanup. Terminate without entering the graceful wait.
    func forceQuit() {
        finishQuit()
    }

    private func finishQuit() {
        guard !completing else { return }
        completing = true
        allowTermination = true
        awaitingJavaScript = false
        quitWatchdog?.cancel()
        quitWatchdog = nil
        let shouldReply = pendingApplicationTermination
        pendingApplicationTermination = false

        // A bundle may send quit from inside __natui_send. Never release its
        // JSContext while JavaScriptCore still has that host call on stack.
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                JSHost.shared.stop()
                if shouldReply {
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else {
                    NSApp.terminate(nil)
                }
            }
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
        case "requestClose":
            // Verification-only native close request. It exercises the same
            // host -> React cleanup -> quit acknowledgement path as the
            // window close button and native Quit.
            LifecycleCoordinator.shared.windowClosed()
        case "quit":
            // A mirrored acknowledgement lets external LaunchServices probes
            // distinguish React cleanup from a later crash or forced exit.
            Emitter.send(["t": "quitAck"])
            LifecycleCoordinator.shared.completeQuit()
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
                MainActor.assumeIsolated {
                    LifecycleCoordinator.shared.forceQuit()
                }
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
            // Create the standard About/Quit menu even if React renders no
            // root nodes and Store.apply is never called.
            ChromeSync.shared.sync(rootChildren: [])

            // Mode is decided BEFORE the stdin reader starts, because it
            // changes what stdin EOF means (see startStdinReader).
            var packagedApp: PackagedApp?
            let packagedResult = AppBundleLoader.loadIfPackaged()
            let bundlePath: String?
            if let packagedResult {
                bundlePath = nil
                switch packagedResult {
                case .success(let app):
                    packagedApp = app
                case .failure(let error):
                    presentStartupFailure(error.localizedDescription)
                    return
                }
            } else {
                bundlePath = explicitBundlePath()
            }
            let hasEmbeddedApp = bundlePath != nil || packagedApp != nil
            LifecycleCoordinator.shared.configure(embeddedRuntime: hasEmbeddedApp)
            // Stdin stays active in both modes: in embedded mode it is the
            // debug channel (dump/emit/screenshot/edit) for external probes.
            startStdinReader(terminateOnEOF: !hasEmbeddedApp)
            if let packagedApp {
                // A packaged app's display name is its window-title fallback.
                // An explicit runEmbedded title still wins in configure.
                WindowManager.shared.setDefaultTitle(packagedApp.name)
                // Stage 2: evaluate the React bundle in-process (JSC). The
                // ready message is sent after the bundle registered its
                // receive hook, and reaches both the JS sink and stdout.
                if let error = JSHost.shared.start(
                    sourceName: packagedApp.sourceName,
                    source: packagedApp.source
                ) {
                    presentStartupFailure(
                        "\(packagedApp.name) \(packagedApp.version): \(error)"
                    )
                    return
                }
            } else if let bundlePath {
                if let error = JSHost.shared.start(bundlePath: bundlePath) {
                    presentStartupFailure(error)
                    return
                }
            }
            // Only now are we able to process messages; JS waits for this.
            Emitter.ready()
        }
    }

    private func explicitBundlePath() -> String? {
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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            LifecycleCoordinator.shared.applicationShouldTerminate()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            JSHost.shared.stop()
        }
    }

    private func presentStartupFailure(_ message: String) {
        Emitter.log("startup failed: \(message)")
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "This application could not start."
            alert.informativeText = message
            alert.runModal()
            exit(EXIT_FAILURE)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Must be set before run() so the process becomes a real, focusable GUI app.
app.setActivationPolicy(.regular)
app.run()
