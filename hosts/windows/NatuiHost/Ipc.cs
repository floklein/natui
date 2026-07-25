using System.Text;
using System.Text.Json.Nodes;

namespace NatuiHost;

/// <summary>
/// Thread-safe NDJSON writer for the protocol channel (stdout).
/// stdout carries protocol messages only; all diagnostics go to stderr.
/// </summary>
internal static class Ipc
{
    private static readonly object Gate = new();

    /// <summary>
    /// Optional in-process delivery path. Embedded mode keeps stdout as a
    /// debug channel and mirrors every outbound message into the JS engine.
    /// </summary>
    public static Action<string>? JsSink { get; set; }

    // UTF-8 without BOM: a BOM would corrupt the first NDJSON line on the JS
    // side. AutoFlush because .NET buffers redirected (pipe) stdout otherwise
    // and the JS renderer would never see the handshake. "\n" line endings
    // keep the framing identical to the macOS host.
    private static readonly StreamWriter Writer = new(
        Console.OpenStandardOutput(),
        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
    {
        AutoFlush = true,
        NewLine = "\n",
    };

    public static void Send(JsonObject message)
    {
        var line = message.ToJsonString();
        try
        {
            lock (Gate)
            {
                Writer.WriteLine(line);
            }
        }
        catch (Exception ex)
        {
            // Broken pipe: the JS process is gone. The stdin reader will see
            // EOF and exit a sidecar app; embedded delivery can continue.
            Log($"stdout write failed: {ex.Message}");
        }
        JsSink?.Invoke(line);
    }

    public static void Ready() => Send(new JsonObject
    {
        ["t"] = "ready",
        ["platform"] = "windows",
        ["protocol"] = 1,
        ["hostApi"] = 1,
    });

    public static void Event(int id, string name, JsonObject? payload = null, int? seq = null)
    {
        var message = new JsonObject
        {
            ["t"] = "event",
            ["id"] = id,
            ["name"] = name,
            ["payload"] = payload ?? new JsonObject(),
        };
        if (seq is { } s) message["seq"] = s;
        Send(message);
    }

    public static void WindowClosed() => Send(new JsonObject
    {
        ["t"] = "window",
        ["name"] = "close",
    });

    public static void Tree(JsonObject root) => Send(new JsonObject
    {
        ["t"] = "tree",
        ["root"] = root,
    });

    /// <summary>
    /// Reply to a screenshot request. Hosts must always reply (a silent
    /// failure would leave the JS-side promise pending forever); on failure
    /// <paramref name="error"/> says why and no file was written.
    /// </summary>
    public static void Shot(string path, string? error = null)
    {
        var message = new JsonObject
        {
            ["t"] = "shot",
            ["path"] = path,
        };
        if (error is not null) message["error"] = error;
        Send(message);
    }

    public static void Log(string message)
    {
        try
        {
            Console.Error.WriteLine($"[natui-host] {message}");
        }
        catch (Exception)
        {
            // stderr is gone too; nothing left to report to.
        }
    }
}
