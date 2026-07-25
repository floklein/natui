using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.ClearScript;
using Microsoft.ClearScript.V8;
using Microsoft.UI.Dispatching;

namespace NatuiHost;

/// <summary>
/// Runs a browser-targeted NatUI bundle in-process with V8. The bridge is the
/// same pair of plain-string functions used by the macOS JavaScriptCore host:
/// the host injects __natui_send and @natui/core/inproc registers __natui_recv.
/// All engine access stays on the WinUI dispatcher thread.
/// </summary>
internal sealed class EmbeddedJsHost(
    DispatcherQueue dispatcher,
    Router router,
    Action<string> runtimeFailed) : IDisposable
{
    private readonly Dictionary<int, DispatcherQueueTimer> _timers = [];
    private V8ScriptEngine? _engine;
    private int _nextTimerId = 1;
    private bool _disposed;
    private bool _runtimeFailureQueued;

    public bool Start(string bundlePath)
    {
        string source;
        try
        {
            source = File.ReadAllText(bundlePath);
        }
        catch (Exception ex)
        {
            Ipc.Log($"embedded: cannot read bundle at {bundlePath}: {ex.Message}");
            return false;
        }
        return StartSource(bundlePath, source);
    }

    public bool StartSource(string sourceName, string source)
    {
        try
        {
            var engine = new V8ScriptEngine();
            _engine = engine;
            engine.AddHostObject(
                "__natui_host",
                new EmbeddedHostBridge(
                    HandleMessage,
                    ScheduleTimer,
                    CancelTimer));
            engine.Execute(
                """
                (() => {
                  const callbacks = new Map();
                  globalThis.__natui_send = (line) => __natui_host.Send(String(line));
                  globalThis.console = Object.fromEntries(
                    ['log', 'info', 'warn', 'error', 'debug'].map((name) => [
                      name,
                      (...args) => __natui_host.Log(args.map(String).join(' ')),
                    ]),
                  );
                  globalThis.setTimeout = (callback, delay = 0, ...args) => {
                    if (typeof callback !== 'function') {
                      throw new TypeError('setTimeout callback must be a function');
                    }
                    const id = __natui_host.ScheduleTimer(Number(delay) || 0);
                    callbacks.set(id, () => callback(...args));
                    return id;
                  };
                  globalThis.clearTimeout = (id) => {
                    callbacks.delete(Number(id));
                    __natui_host.CancelTimer(Number(id));
                  };
                  globalThis.setInterval = undefined;
                  globalThis.clearInterval = undefined;
                  globalThis.queueMicrotask = (callback) => {
                    Promise.resolve().then(callback);
                  };
                  globalThis.__natui_run_timer = (id) => {
                    const callback = callbacks.get(id);
                    callbacks.delete(id);
                    if (callback) callback();
                  };
                })();
                """);
            engine.Execute(sourceName, source);

            if (engine.Evaluate("typeof globalThis.__natui_recv === 'function'") is not true)
            {
                Ipc.Log(
                    "embedded: bundle did not register __natui_recv; "
                    + "is it built with @natui/core/inproc?");
                Dispose();
                return false;
            }

            Ipc.JsSink = line =>
            {
                dispatcher.TryEnqueue(() => Invoke("__natui_recv", line));
            };
            return true;
        }
        catch (ScriptEngineException ex)
        {
            Ipc.Log($"embedded: JS exception: {ex.ErrorDetails}");
        }
        catch (Exception ex)
        {
            Ipc.Log($"embedded: engine startup failed: {ex}");
        }

        Dispose();
        return false;
    }

    private void HandleMessage(string line)
    {
        JsonObject? message;
        try
        {
            message = JsonNode.Parse(line) as JsonObject;
        }
        catch (JsonException)
        {
            message = null;
        }

        if (message is null)
        {
            Ipc.Log($"embedded: bad message from JS: {line[..Math.Min(line.Length, 200)]}");
            return;
        }
        router.Handle(message);
    }

    private int ScheduleTimer(double delay)
    {
        var id = _nextTimerId++;
        var timer = dispatcher.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(
            double.IsFinite(delay) && delay > 0 ? Math.Max(1, delay) : 1);
        timer.IsRepeating = false;
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            _timers.Remove(id);
            Invoke("__natui_run_timer", id);
        };
        _timers[id] = timer;
        timer.Start();
        return id;
    }

    private void CancelTimer(int id)
    {
        if (!_timers.Remove(id, out var timer)) return;
        timer.Stop();
    }

    private void Invoke(string function, object argument)
    {
        if (_disposed || _runtimeFailureQueued) return;
        try
        {
            _engine?.Invoke(function, argument);
        }
        catch (ScriptEngineException ex)
        {
            QueueRuntimeFailure(ex.ErrorDetails);
        }
        catch (Exception ex)
        {
            QueueRuntimeFailure(ex.ToString());
        }
    }

    private void QueueRuntimeFailure(string message)
    {
        if (_disposed || _runtimeFailureQueued) return;
        _runtimeFailureQueued = true;
        Ipc.Log($"embedded: JS exception: {message}");

        // Never release ClearScript while its Invoke call is still unwinding.
        // The application performs the terminal failure path on the next
        // dispatcher turn, after this callback has returned.
        if (!dispatcher.TryEnqueue(() =>
            {
                if (!_disposed) runtimeFailed(message);
            }))
        {
            Ipc.Log("embedded: cannot dispatch runtime failure shutdown");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Ipc.JsSink = null;
        foreach (var timer in _timers.Values) timer.Stop();
        _timers.Clear();
        _engine?.Dispose();
        _engine = null;
    }
}

/// <summary>
/// Public because ClearScript intentionally exposes only members whose CLR
/// declaring type is publicly visible. The constructor stays internal, so
/// scripts receive only this narrow callback surface.
/// </summary>
public sealed class EmbeddedHostBridge
{
    private readonly Action<int> _cancelTimer;
    private readonly Action<string> _handleMessage;
    private readonly Func<double, int> _scheduleTimer;

    internal EmbeddedHostBridge(
        Action<string> handleMessage,
        Func<double, int> scheduleTimer,
        Action<int> cancelTimer)
    {
        _handleMessage = handleMessage;
        _scheduleTimer = scheduleTimer;
        _cancelTimer = cancelTimer;
    }

    public void Send(string line) => _handleMessage(line);

    public void Log(string message) => Ipc.Log($"js: {message}");

    public int ScheduleTimer(double delay) => _scheduleTimer(delay);

    public void CancelTimer(double id) => _cancelTimer((int)id);
}
