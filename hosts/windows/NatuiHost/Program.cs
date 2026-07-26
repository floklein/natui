using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.XamlTypeInfo;
using Windows.Graphics;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace NatuiHost;

public static class Program
{
    [STAThread]
    public static void Main()
    {
        // Startup failures in a WinExe are invisible by default (no console,
        // exit code 0xC000027B); route them to stderr like all diagnostics.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Ipc.Log($"unhandled: {e.ExceptionObject}");
        // In a fully self-extracting single-file publish, AppContext points
        // at the distributed exe while the WinUI DLLs live beside the
        // extracted managed assembly. WASDK's generated initializer uses the
        // former path. Correct it before the first XAML activation.
        var assemblyDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location);
        if (assemblyDirectory is not null
            && File.Exists(Path.Combine(assemblyDirectory, "Microsoft.WindowsAppRuntime.dll")))
        {
            Environment.SetEnvironmentVariable(
                "MICROSOFT_WINDOWSAPPRUNTIME_BASE_DIRECTORY",
                assemblyDirectory + Path.DirectorySeparatorChar);
        }
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(p =>
        {
            try
            {
                // Awaits on the UI thread (screenshot encoding) must resume on
                // the UI thread; this context routes continuations via the
                // dispatcher.
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                _ = new App();
            }
            catch (Exception ex)
            {
                Ipc.Log($"start callback failed: {ex}");
                throw;
            }
        });
    }
}

public sealed class App : Application, IXamlMetadataProvider
{
    private EmbeddedJsHost? _embeddedHost;
    private Window? _window;
    private Router? _router;
    private bool _quitting;
    private bool _quitRequested;
    private bool _startupFailed;
    private bool _runtimeFailed;
    private bool _embeddedRuntime;
    private bool _sidecarRuntime;
    private bool _packagedApp;
    private string _defaultWindowTitle = "NatUI";
    private System.Threading.Timer? _quitWatchdog;

    private const uint ErrorDialogFlags = 0x00000010 | 0x00002000;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint windowHandle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int MessageBoxW(
        nint windowHandle,
        string text,
        string caption,
        uint type);

    // Code-only app: the XAML compiler normally generates this metadata
    // provider plumbing from App.xaml. Without it, parsing WinUI's own
    // resource dictionaries fails (XamlControlsResources throws "Cannot find
    // a resource with the given key" during activation, because the runtime
    // QIs the Application object for IXamlMetadataProvider to resolve types).
    private readonly XamlControlsXamlMetaDataProvider _xamlMetadata = new();

    public IXamlType GetXamlType(Type type) => _xamlMetadata.GetXamlType(type);

    public IXamlType GetXamlType(string fullName) => _xamlMetadata.GetXamlType(fullName);

    public XmlnsDefinition[] GetXmlnsDefinitions() => _xamlMetadata.GetXmlnsDefinitions();

    public App()
    {
        UnhandledException += (_, e) =>
        {
            Ipc.Log($"xaml unhandled: {e.Exception}");
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Application members (Resources, DispatcherShutdownMode) are not
        // usable in the constructor of a code-only app: the underlying COM
        // object finishes initializing only after Start's callback returns,
        // and touching them earlier throws E_UNEXPECTED. OnLaunched is the
        // first safe point.
        // Keep running after the window closes; JS orchestrates shutdown via
        // the quit message (mirrors the macOS host's
        // applicationShouldTerminateAfterLastWindowClosed = false).
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;

        // Root container (node id 0): a vertical stack in a ScrollViewer.
        // Stretch into the content row so greedy descendants receive the full
        // window proposal. Auto rows still keep ordinary content top-hung.
        // Leading cross-alignment mirrors the macOS host's RootView
        // (VStack(alignment: .leading, spacing: 0)).
        var rootStack = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            VerticalAlignment = VerticalAlignment.Stretch,
            CrossAlignment = "leading",
        };
        // Window chrome row (MenuBar above CommandBar) and the Sheet overlay
        // layer. The overlay spans both rows; a null background means it
        // never intercepts input while empty.
        var chromePanel = new StackPanel { Orientation = Orientation.Vertical };
        var overlayLayer = new Grid();
        var mapper = new NodeMapper(rootStack, chromePanel, overlayLayer, RequestQuit);
        var store = new NodeStore(mapper);

        // The shell Grid paints the theme background so screenshots are not
        // transparent (same concern as the macOS host). No ScrollViewer here:
        // the macOS RootView does not scroll (tall content clips, and
        // maxHeight:"infinity" fills must resolve against the window, which a
        // scroll viewport would report as unbounded). Apps opt into scrolling
        // with the ScrollView component.
        var shell = new Grid { Background = PageBackground() };
        shell.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(chromePanel, 0);
        shell.Children.Add(chromePanel);
        Grid.SetRow(rootStack, 1);
        shell.Children.Add(rootStack);
        Grid.SetRow(overlayLayer, 0);
        Grid.SetRowSpan(overlayLayer, 2);
        shell.Children.Add(overlayLayer);

        _window = new Window { Title = "NatUI" };
        // Code-only app (no App.xaml): without XamlControlsResources every
        // control template is missing and controls render blank or throw.
        // Requires the IXamlMetadataProvider implementation above, and a
        // resources.pri next to the exe (see AppxGeneratePriEnabled in the
        // csproj); missing either one throws right here.
        Resources.MergedDictionaries.Add(new XamlControlsResources());
        _window.Content = shell;
        _window.Closed += (_, _) =>
        {
            // Application.Exit also closes the window, so stay silent then.
            if (_quitting) return;
            if (_startupFailed)
            {
                Quit(1);
                return;
            }
            WindowClosed();
        };

        var isPackaged = AppBundle.IsEmbedded;
        var bundlePath = isPackaged ? null : ExplicitBundlePath();
        PackagedApp? packagedApp = null;
        if (isPackaged)
        {
            if (!AppBundle.TryLoad(out packagedApp, out var manifestError))
            {
                ShowStartupFailure(rootStack, manifestError ?? "Invalid packaged application.");
                return;
            }
            _packagedApp = true;
            _defaultWindowTitle = packagedApp!.Name;
            _window.Title = _defaultWindowTitle;
        }
        var hasEmbeddedApp = bundlePath is not null || packagedApp is not null;
        var hasProtocolInput = Console.IsInputRedirected;
        _embeddedRuntime = hasEmbeddedApp;
        _sidecarRuntime = !hasEmbeddedApp && hasProtocolInput;
        _router = new Router(this, _window, store, _defaultWindowTitle);

        if (!hasEmbeddedApp && !hasProtocolInput)
        {
            // Double-clicked, no protocol channel: show a hint instead of
            // sitting invisible or exiting silently.
            rootStack.Children.Add(new TextBlock
            {
                Text = "NatUI host: launch via the NatUI JS renderer.",
                Margin = new Thickness(20),
            });
            rootStack.RebuildLayout();
            _window.Activate();
            return;
        }

        if (hasProtocolInput)
        {
            StartStdinReader(
                _window.DispatcherQueue,
                terminateOnEof: !hasEmbeddedApp);
        }
        if (hasEmbeddedApp)
        {
            _embeddedHost = new EmbeddedJsHost(
                _window.DispatcherQueue,
                _router,
                EmbeddedRuntimeFailed);
            var started = packagedApp is not null
                ? _embeddedHost.StartSource(packagedApp.SourceName, packagedApp.Source)
                : _embeddedHost.Start(bundlePath!);
            if (!started)
            {
                ShowStartupFailure(
                    rootStack,
                    packagedApp is null
                        ? $"Cannot start embedded bundle at {bundlePath}."
                        : $"Cannot start {packagedApp.Name} {packagedApp.Version}.");
                return;
            }
        }
        // Only now can messages be processed; JS waits for this.
        Ipc.Ready();
    }

    internal void WindowClosed()
    {
        if (_embeddedRuntime)
        {
            RequestQuit();
            return;
        }

        if (_sidecarRuntime)
        {
            // Node sidecar mode's optional onClose callback may intentionally
            // keep the host alive. Emit the close event without imposing a
            // host timer.
            Ipc.WindowClosed();
            return;
        }

        // The bare double-click hint has no JavaScript process to acknowledge
        // a close event, so terminate as soon as its only window closes.
        Quit();
    }

    internal void RequestQuit()
    {
        if (_quitting || _quitRequested) return;
        _quitRequested = true;
        _quitWatchdog = new System.Threading.Timer(
            _ =>
            {
                Ipc.Log("graceful shutdown timed out; forcing process exit");
                Environment.Exit(Environment.ExitCode);
            },
            null,
            TimeSpan.FromSeconds(2),
            Timeout.InfiniteTimeSpan);
        Ipc.WindowClosed();
    }

    private void EmbeddedRuntimeFailed(string message)
    {
        if (_quitting || _runtimeFailed) return;
        _runtimeFailed = true;
        Environment.ExitCode = 1;
        Ipc.Log($"embedded runtime failed: {message}");

        // The failure callback is dispatched only after the throwing V8 call
        // returns. Stop the watchdog and runtime before entering a packaged
        // application's modal error dialog.
        _quitWatchdog?.Dispose();
        _quitWatchdog = null;
        var embeddedHost = _embeddedHost;
        _embeddedHost = null;
        embeddedHost?.Dispose();

        if (_packagedApp)
        {
            ShowPackagedRuntimeFailure(message);
        }
        Quit(1);
    }

    private void ShowPackagedRuntimeFailure(string message)
    {
        nint windowHandle = 0;
        try
        {
            if (_window is not null)
            {
                windowHandle = WinRT.Interop.WindowNative.GetWindowHandle(_window);
                if (!IsWindow(windowHandle)) windowHandle = 0;
            }
        }
        catch (Exception ex)
        {
            Ipc.Log($"cannot resolve runtime error dialog owner: {ex.Message}");
        }

        if (MessageBoxW(
            windowHandle,
            $"This application encountered an error.\n\n{message}",
            _defaultWindowTitle,
            ErrorDialogFlags) == 0)
        {
            Ipc.Log($"cannot show runtime error dialog: Win32 error {Marshal.GetLastWin32Error()}");
        }
    }

    internal void Quit(int exitCode = 0)
    {
        if (_quitting) return;
        _quitting = true;
        _quitWatchdog?.Dispose();
        _quitWatchdog = null;
        Environment.ExitCode = exitCode;
        var embeddedHost = _embeddedHost;
        _embeddedHost = null;
        // A bundle can send quit from inside a V8 callback. Dispose on the
        // next dispatcher turn so ClearScript is never torn down while one of
        // its own host calls is still on the stack.
        if (embeddedHost is not null && _window?.DispatcherQueue is { } dispatcher)
        {
            if (dispatcher.TryEnqueue(() =>
                {
                    embeddedHost.Dispose();
                    Exit();
                }))
            {
                return;
            }
            embeddedHost.Dispose();
        }
        Exit();
    }

    private void ShowStartupFailure(NatuiStack rootStack, string message)
    {
        _startupFailed = true;
        Environment.ExitCode = 1;
        Ipc.Log($"startup failed: {message}");
        rootStack.Children.Clear();
        rootStack.Children.Add(new TextBlock
        {
            Text = $"This application could not start.\n\n{message}",
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 640,
            Margin = new Thickness(24),
        });
        rootStack.RebuildLayout();
        _window!.Activate();
    }

    private static string? ExplicitBundlePath()
    {
        var args = Environment.GetCommandLineArgs();
        var index = Array.IndexOf(args, "--bundle");
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private void StartStdinReader(DispatcherQueue dispatcher, bool terminateOnEof)
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
            if (terminateOnEof)
            {
                // Sidecar mode: stdin is the parent-process lifeline.
                dispatcher.TryEnqueue(() => Quit());
            }
            else
            {
                Ipc.Log("stdin closed; embedded app keeps running without the debug channel");
            }
        })
        {
            IsBackground = true,
            Name = "natui.stdin",
        };
        thread.Start();
    }

    private static Brush PageBackground() =>
        Theme.Resource<Brush>("ApplicationPageBackgroundThemeBrush")
        ?? new SolidColorBrush(Microsoft.UI.Colors.White);
}

/// <summary>Dispatches inbound protocol messages. Runs on the UI thread.</summary>
internal sealed class Router(
    App app,
    Window window,
    NodeStore store,
    string defaultWindowTitle)
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
            case "requestClose":
                // Verification-only native close request. It exercises the
                // same mode-sensitive path as the window close button.
                app.WindowClosed();
                break;
            case "quit":
                Ipc.QuitAck();
                app.Quit();
                break;
            default:
                Ipc.Log($"unknown message type: {Json.Str(message, "t")}");
                break;
        }
    }

    private void ConfigureWindow(JsonObject props)
    {
        window.Title = Json.Str(props, "title") ?? defaultWindowTitle;
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
            // Presenter-enforced minimum (WM_GETMINMAXINFO under the hood),
            // same physical-pixel convention as ResizeClient.
            // Constrains the whole window frame rather than the client area;
            // close enough to the macOS host's contentMinSize for this alpha.
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
