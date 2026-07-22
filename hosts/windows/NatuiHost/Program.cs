using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace NatuiHost;

public static class Program
{
    [STAThread]
    public static void Main()
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(_ =>
        {
            // Awaits on the UI thread (screenshot encoding) must resume on the
            // UI thread; this context routes continuations via the dispatcher.
            var context = new DispatcherQueueSynchronizationContext(
                DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
    }
}

public sealed class App : Application
{
    private Window? _window;
    private Router? _router;
    private bool _quitting;

    public App()
    {
        // Code-only app (no App.xaml): without XamlControlsResources every
        // control template is missing and controls render blank or throw.
        Resources.MergedDictionaries.Add(new XamlControlsResources());
        // Keep running after the window closes; JS orchestrates shutdown via
        // the quit message (mirrors the macOS host's
        // applicationShouldTerminateAfterLastWindowClosed = false).
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Root container (node id 0): a vertical stack in a ScrollViewer.
        // Horizontally stretched so children see the window width, the way
        // SwiftUI proposes the full width down the tree; vertically top-hung.
        // Leading cross-alignment mirrors the macOS host's RootView
        // (VStack(alignment: .leading, spacing: 0)).
        var rootStack = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            VerticalAlignment = VerticalAlignment.Top,
            CrossAlignment = "leading",
        };
        var mapper = new NodeMapper(rootStack);
        var store = new NodeStore(mapper);

        // The shell Grid paints the theme background so screenshots are not
        // transparent (same concern as the macOS host). No ScrollViewer here:
        // the macOS RootView does not scroll (tall content clips, and
        // maxHeight:"infinity" fills must resolve against the window, which a
        // scroll viewport would report as unbounded). Apps opt into scrolling
        // with the ScrollView component.
        var shell = new Grid { Background = PageBackground() };
        shell.Children.Add(rootStack);

        _window = new Window { Title = "natui" };
        _window.Content = shell;
        _window.Closed += (_, _) =>
        {
            // JS decides what happens next (usually: unmount + quit message).
            // Application.Exit also closes the window, so stay silent then.
            if (!_quitting) Ipc.WindowClosed();
        };

        _router = new Router(this, _window, store);

        if (!Console.IsInputRedirected)
        {
            // Double-clicked, no protocol channel: show a hint instead of
            // sitting invisible or exiting silently.
            rootStack.Children.Add(new TextBlock
            {
                Text = "natui host: launch via the natui JS renderer.",
                Margin = new Thickness(20),
            });
            rootStack.RebuildLayout();
            _window.Activate();
            return;
        }

        StartStdinReader(_window.DispatcherQueue);
        // Only now can messages be processed; JS waits for this.
        Ipc.Ready();
    }

    internal void Quit()
    {
        _quitting = true;
        Exit();
    }

    private void StartStdinReader(DispatcherQueue dispatcher)
    {
        // Blocking NDJSON reader on a dedicated thread. One protocol message
        // becomes exactly one dispatcher hop, so a whole commit batch is
        // applied in a single UI pass. Never touch UI objects on this thread.
        var thread = new Thread(() =>
        {
            try
            {
                using var reader = new StreamReader(
                    Console.OpenStandardInput(), new UTF8Encoding(false));
                while (reader.ReadLine() is { } line)
                {
                    if (line.Length == 0) continue;
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
                        Ipc.Log($"bad message: {line[..Math.Min(line.Length, 200)]}");
                        continue;
                    }
                    dispatcher.TryEnqueue(() => _router!.Handle(message));
                }
            }
            catch (Exception ex)
            {
                Ipc.Log($"stdin reader: {ex.Message}");
            }
            // EOF: the JS process died or closed the pipe. Exit cleanly.
            dispatcher.TryEnqueue(Quit);
        })
        {
            IsBackground = true,
            Name = "natui.stdin",
        };
        thread.Start();
    }

    private static Brush PageBackground()
    {
        try
        {
            if (Current.Resources["ApplicationPageBackgroundThemeBrush"] is Brush brush)
            {
                return brush;
            }
        }
        catch (Exception)
        {
            // Resource lookup throws on a missing key; fall through.
        }
        return new SolidColorBrush(Microsoft.UI.Colors.White);
    }
}

/// <summary>Dispatches inbound protocol messages. Runs on the UI thread.</summary>
internal sealed class Router(App app, Window window, NodeStore store)
{
    public void Handle(JsonObject message)
    {
        switch (Json.Str(message, "t"))
        {
            case "window":
                ConfigureWindow(Json.Obj(message, "props") ?? []);
                break;
            case "commit":
                store.Apply(Json.Arr(message, "ops") ?? []);
                break;
            case "dump":
                Ipc.Tree(store.DumpTree());
                break;
            case "screenshot":
                _ = ScreenshotAsync(Json.Str(message, "path")
                    ?? Path.Combine(Path.GetTempPath(), "natui-shot.png"));
                break;
            case "emit":
                // Debug: synthesize a user event, exercising the full round trip.
                if (Json.Int(message, "id") is { } id && Json.Str(message, "name") is { } name)
                {
                    // Clone: a JsonNode still parented to the inbound message
                    // cannot be inserted into the outbound one.
                    var payload = Json.Obj(message, "payload")?.DeepClone().AsObject();
                    Ipc.Event(id, name, payload);
                }
                break;
            case "edit":
                // Debug: a real optimistic user edit, through the same code
                // path as the control handlers (local value write + seq bump
                // + change event); exercises seq/ack end to end.
                if (Json.Int(message, "id") is { } editId && message.ContainsKey("value"))
                {
                    store.UserEdit(editId, message["value"]);
                }
                break;
            case "quit":
                app.Quit();
                break;
            default:
                Ipc.Log($"unknown message type: {Json.Str(message, "t")}");
                break;
        }
    }

    private void ConfigureWindow(JsonObject props)
    {
        window.Title = Json.Str(props, "title") ?? "natui";
        // Activate first so the XamlRoot (and its DPI scale) exists.
        window.Activate();

        var width = Json.Num(props, "width") ?? 640;
        var height = Json.Num(props, "height") ?? 480;
        // Protocol sizes are logical points; AppWindow wants physical pixels.
        var scale = window.Content?.XamlRoot?.RasterizationScale ?? 1.0;
        window.AppWindow.ResizeClient(new SizeInt32(
            (int)Math.Round(width * scale),
            (int)Math.Round(height * scale)));
        if (Json.Num(props, "minWidth") is { } minWidth
            && Json.Num(props, "minHeight") is { } minHeight
            && window.AppWindow.Presenter is OverlappedPresenter presenter)
        {
            // WASDK 1.7 presenter-enforced minimum (WM_GETMINMAXINFO under
            // the hood), same physical-pixel convention as ResizeClient.
            // Constrains the whole window frame rather than the client area;
            // close enough to the macOS host's contentMinSize for this POC.
            presenter.PreferredMinimumWidth = (int)Math.Round(minWidth * scale);
            presenter.PreferredMinimumHeight = (int)Math.Round(minHeight * scale);
        }
        CenterWindow();
    }

    private void CenterWindow()
    {
        var appWindow = window.AppWindow;
        var work = DisplayArea.GetFromWindowId(appWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        var size = appWindow.Size;
        appWindow.Move(new PointInt32(
            work.X + Math.Max(0, (work.Width - size.Width) / 2),
            work.Y + Math.Max(0, (work.Height - size.Height) / 2)));
    }

    /// <summary>
    /// Debug: render our own window content to a PNG. Never reads the actual
    /// screen, so it needs no capture permission. Always replies with a shot
    /// message: the try/catch spans the whole flow, including the async
    /// continuations, so no failure path can leave the JS-side screenshot
    /// promise pending (on failure the reply carries an error and no file is
    /// written).
    /// </summary>
    private async Task ScreenshotAsync(string path)
    {
        try
        {
            var content = window.Content
                ?? throw new InvalidOperationException("no window content");
            var bitmap = new RenderTargetBitmap();
            await bitmap.RenderAsync(content);

            var buffer = await bitmap.GetPixelsAsync();
            var pixels = new byte[buffer.Length];
            using (var pixelReader = DataReader.FromBuffer(buffer))
            {
                pixelReader.ReadBytes(pixels);
            }

            using var stream = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
            encoder.SetPixelData(
                BitmapPixelFormat.Bgra8,
                BitmapAlphaMode.Premultiplied,
                (uint)bitmap.PixelWidth,
                (uint)bitmap.PixelHeight,
                96,
                96,
                pixels);
            await encoder.FlushAsync();

            var png = new byte[(uint)stream.Size];
            using (var pngReader = new DataReader(stream.GetInputStreamAt(0)))
            {
                await pngReader.LoadAsync((uint)stream.Size);
                pngReader.ReadBytes(png);
            }
            await File.WriteAllBytesAsync(path, png);
            Ipc.Shot(path);
        }
        catch (Exception ex)
        {
            Ipc.Log($"screenshot failed: {ex.Message}");
            Ipc.Shot(path, string.IsNullOrEmpty(ex.Message) ? ex.GetType().Name : ex.Message);
        }
    }
}
