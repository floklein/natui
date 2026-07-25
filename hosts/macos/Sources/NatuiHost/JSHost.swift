import AppKit
import Foundation
import JavaScriptCore

/// Stage 2: run the React app bundle inside JavaScriptCore in this process.
/// No Node, no stdio for the app itself; the bundle talks to us through two
/// globals: we inject `__natui_send` (JS -> host), the bundle registers
/// `__natui_recv` (host -> JS). All JS runs on the main thread, so JSC's
/// promise-job queue drains whenever a native call returns, which is exactly
/// what `queueMicrotask = cb => Promise.resolve().then(cb)` relies on.
///
/// React's scheduler needs only setTimeout here: with no setImmediate and no
/// MessageChannel it falls back to setTimeout, which we back with
/// DispatchQueue.main.
@MainActor
final class JSHost {
    static let shared = JSHost()

    private var context: JSContext?
    private var recv: JSValue?
    private var nextTimerId = 1
    private var timers: [Int: DispatchWorkItem] = [:]

    /// Returns nil on success, or a user-facing startup error.
    func start(bundlePath: String) -> String? {
        guard let source = try? String(contentsOfFile: bundlePath, encoding: .utf8) else {
            let message = "Cannot read the application bundle at \(bundlePath)."
            Emitter.log("embedded: \(message)")
            return message
        }
        return start(sourceName: bundlePath, source: source)
    }

    /// Starts a source string already validated by the packaged-app loader.
    func start(sourceName: String, source: String) -> String? {
        guard let ctx = JSContext() else {
            let message = "JavaScriptCore could not create an application context."
            Emitter.log("embedded: \(message)")
            return message
        }

        var startupException: String?
        ctx.exceptionHandler = { _, exception in
            let message = exception?.toString() ?? "unknown JavaScript exception"
            if startupException == nil { startupException = message }
            Emitter.log("embedded: JS exception: \(message)")
        }

        context = ctx
        installConsole(ctx)
        installTimers(ctx)
        ctx.evaluateScript("globalThis.queueMicrotask = (cb) => { Promise.resolve().then(cb); };")
        if let startupException {
            stop()
            return "The embedded JavaScript runtime could not initialize: \(startupException)"
        }

        let send: @convention(block) (String) -> Void = { line in
            MainActor.assumeIsolated {
                guard let data = line.data(using: .utf8),
                      let msg = try? JSONDecoder().decode(InMessage.self, from: data)
                else {
                    Emitter.log("embedded: bad message from JS: \(line.prefix(200))")
                    return
                }
                Router.handle(msg)
            }
        }
        ctx.setObject(send, forKeyedSubscript: "__natui_send" as NSString)

        ctx.evaluateScript(source, withSourceURL: URL(fileURLWithPath: sourceName))
        if let startupException {
            stop()
            return "The application JavaScript failed during startup: \(startupException)"
        }

        let hasReceiver =
            ctx.evaluateScript("typeof globalThis.__natui_recv === 'function'")?.toBool() == true
        if !hasReceiver {
            let message =
                "The application did not start the NatUI embedded runtime. "
                + "Build its entry with @natui/core/inproc."
            Emitter.log("embedded: \(message)")
            stop()
            return message
        }
        recv = ctx.objectForKeyedSubscript("__natui_recv")

        // Startup completed. Any later exception escaped a timer, event, or
        // React callback and leaves the embedded application unusable.
        ctx.exceptionHandler = { _, exception in
            let message = exception?.toString() ?? "unknown JavaScript exception"
            Emitter.log("embedded: JS exception: \(message)")
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    LifecycleCoordinator.shared.javascriptFailed(message)
                }
            }
        }

        // From here on, everything the Emitter sends is also delivered into
        // the JS context (events, ready, window close).
        Emitter.jsSink = { line in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    _ = JSHost.shared.recv?.call(withArguments: [line])
                }
            }
        }
        return nil
    }

    /// Tear down only outside a JavaScriptCore callback. LifecycleCoordinator
    /// schedules this on the next main-queue turn after the JS `quit` message.
    func stop() {
        Emitter.jsSink = nil
        for timer in timers.values { timer.cancel() }
        timers.removeAll()
        recv = nil
        context = nil
    }

    private func installConsole(_ ctx: JSContext) {
        let log: @convention(block) (JSValue) -> Void = { value in
            Emitter.log("js: \(value.toString() ?? "")")
        }
        ctx.setObject(log, forKeyedSubscript: "__natui_log" as NSString)
        ctx.evaluateScript(
            "globalThis.console = { log: __natui_log, info: __natui_log, warn: __natui_log, error: __natui_log, debug: __natui_log };"
        )
    }

    private func installTimers(_ ctx: JSContext) {
        let setTimeout: @convention(block) (JSValue, JSValue) -> Int = { fn, delay in
            MainActor.assumeIsolated {
                JSHost.shared.scheduleTimer(fn: fn, ms: delay.isNumber ? delay.toDouble() : 0)
            }
        }
        let clearTimeout: @convention(block) (JSValue) -> Void = { id in
            MainActor.assumeIsolated {
                JSHost.shared.cancelTimer(id: Int(id.isNumber ? id.toDouble() : -1))
            }
        }
        ctx.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)
        ctx.setObject(clearTimeout, forKeyedSubscript: "clearTimeout" as NSString)
        ctx.evaluateScript("globalThis.setInterval = undefined; globalThis.clearInterval = undefined;")
    }

    private func scheduleTimer(fn: JSValue, ms: Double) -> Int {
        let id = nextTimerId
        nextTimerId += 1
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.timers[id] = nil
                fn.call(withArguments: [])
            }
        }
        timers[id] = work
        let delay = ms.isFinite && ms > 0 ? ms / 1000 : 0
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        return id
    }

    private func cancelTimer(id: Int) {
        timers[id]?.cancel()
        timers[id] = nil
    }
}
