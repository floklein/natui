export interface WindowsTemplateOptions {
  architecture: "x64" | "arm64";
  height: number;
  identifier: string;
  minimumVersion: string;
  name: string;
  namespace: string;
  resizable: boolean;
  version: string;
  width: number;
}

function source(value: string): string {
  return `${value.replace(/^\n/, "").replace(/\s+$/, "")}\n`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function csharpString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return Math.round(value);
}

function manifestVersion(version: string): string {
  const numeric = version.split("-", 1)[0]?.split(".") ?? [];
  const parts = [0, 1, 2, 3].map((index) => {
    const parsed = Number.parseInt(numeric[index] ?? "0", 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : 0;
  });
  return parts.join(".");
}

function projectFile(options: WindowsTemplateOptions): string {
  const architecture = options.architecture === "arm64" ? "ARM64" : "x64";
  const runtimeIdentifier = `win-${options.architecture}`;
  return source(String.raw`
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <TargetPlatformMinVersion>${xml(options.minimumVersion)}</TargetPlatformMinVersion>
    <SupportedOSPlatformVersion>${xml(options.minimumVersion)}</SupportedOSPlatformVersion>
    <RootNamespace>${xml(options.namespace)}</RootNamespace>
    <AssemblyName>NatUIHost</AssemblyName>
    <ApplicationManifest>app.manifest</ApplicationManifest>
    <Version>${xml(options.version)}</Version>
    <AssemblyVersion>${manifestVersion(options.version)}</AssemblyVersion>
    <FileVersion>${manifestVersion(options.version)}</FileVersion>
    <Platforms>x64;ARM64</Platforms>
    <PlatformTarget>${architecture}</PlatformTarget>
    <RuntimeIdentifier>${runtimeIdentifier}</RuntimeIdentifier>
    <UseWinUI>true</UseWinUI>
    <WinUISDKReferences>false</WinUISDKReferences>
    <WindowsPackageType>None</WindowsPackageType>
    <WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained>
    <SelfContained>true</SelfContained>
    <PublishSingleFile>false</PublishSingleFile>
    <PublishTrimmed>false</PublishTrimmed>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>

  <ItemGroup>
    <Manifest Include="$(ApplicationManifest)" />
    <Content Include="NatUIController.exe">
      <Link>NatUIController.exe</Link>
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
      <CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory>
    </Content>
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Windows.SDK.BuildTools" Version="10.0.26100.8249" />
    <PackageReference Include="Microsoft.WindowsAppSDK" Version="2.2.0" />
  </ItemGroup>
</Project>`);
}

function appXaml(options: WindowsTemplateOptions): string {
  return source(String.raw`
<?xml version="1.0" encoding="utf-8"?>
<Application
    x:Class="${xml(options.namespace)}.App"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Application.Resources>
        <ResourceDictionary>
            <ResourceDictionary.MergedDictionaries>
                <XamlControlsResources xmlns="using:Microsoft.UI.Xaml.Controls" />
            </ResourceDictionary.MergedDictionaries>
        </ResourceDictionary>
    </Application.Resources>
</Application>`);
}

function appCode(options: WindowsTemplateOptions): string {
  return source(String.raw`
using Microsoft.UI.Xaml;

namespace ${options.namespace};

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}`);
}

function mainWindowXaml(options: WindowsTemplateOptions): string {
  return source(String.raw`
<?xml version="1.0" encoding="utf-8"?>
<Window
    x:Class="${xml(options.namespace)}.MainWindow"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="${xml(options.name)}">
    <Grid x:Name="LayoutRoot">
        <ContentControl x:Name="RootHost" />
        <InfoBar
            x:Name="StatusBar"
            Margin="12"
            HorizontalAlignment="Stretch"
            VerticalAlignment="Bottom"
            IsClosable="True"
            IsOpen="True"
            Message="Starting native controller..."
            Severity="Informational" />
    </Grid>
</Window>`);
}

function mainWindowCode(options: WindowsTemplateOptions): string {
  const width = positiveInteger(options.width, "width");
  const height = positiveInteger(options.height, "height");
  return source(String.raw`
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Graphics;

namespace ${options.namespace};

public sealed partial class MainWindow : Window
{
    private ControllerSession? _controller;
    private NatUIRenderer? _renderer;
    private long _revision = -1;

    public MainWindow()
    {
        InitializeComponent();
        ConfigureWindow("${csharpString(options.name)}", ${width}, ${height}, ${options.resizable ? "true" : "false"});
        RootHost.Loaded += OnRootHostLoaded;
        Closed += OnClosed;
    }

    private void OnRootHostLoaded(object sender, RoutedEventArgs args)
    {
        RootHost.Loaded -= OnRootHostLoaded;
        _renderer = new NatUIRenderer(this, SendEvent);
        _controller = new ControllerSession(RootHost.DispatcherQueue);
        _controller.Hello += OnHello;
        _controller.Snapshot += OnSnapshot;
        _controller.Failed += ShowError;

        try
        {
            _controller.Start();
        }
        catch (Exception exception)
        {
            ShowError(exception.Message);
        }
    }

    private void OnHello(HelloMessage hello)
    {
        StatusBar.IsOpen = false;
    }

    private void OnSnapshot(SnapshotMessage snapshot)
    {
        if (snapshot.Revision <= _revision || _renderer is null)
        {
            return;
        }

        try
        {
            RootHost.Content = _renderer.BuildRoot(snapshot.Root);
            _revision = snapshot.Revision;
            StatusBar.IsOpen = false;
        }
        catch (Exception exception)
        {
            ShowError($"Could not render revision {snapshot.Revision}: {exception.Message}");
        }
    }

    private void SendEvent(string handler, object? payload)
    {
        _controller?.SendEvent(handler, payload);
    }

    internal void ConfigureWindow(string? title, int? width, int? height, bool? resizable)
    {
        if (title is not null)
        {
            Title = title;
        }

        if (width is not null || height is not null)
        {
            var size = AppWindow.Size;
            AppWindow.Resize(new SizeInt32(
                Math.Max(1, width ?? size.Width),
                Math.Max(1, height ?? size.Height)));
        }

        if (resizable is not null && AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsResizable = resizable.Value;
            presenter.IsMaximizable = resizable.Value;
        }
    }

    private void ShowError(string message)
    {
        StatusBar.Title = "NatUI controller error";
        StatusBar.Message = message;
        StatusBar.Severity = InfoBarSeverity.Error;
        StatusBar.IsOpen = true;
    }

    private async void OnClosed(object sender, WindowEventArgs args)
    {
        if (_controller is not null)
        {
            await _controller.DisposeAsync();
        }
    }
}`);
}

function protocolCode(options: WindowsTemplateOptions): string {
  return source(String.raw`
using System.Text.Json;

namespace ${options.namespace};

internal sealed class WireNode
{
    public List<WireNode> Children { get; init; } = [];
    public Dictionary<string, string> Events { get; init; } = [];
    public string Id { get; init; } = string.Empty;
    public Dictionary<string, JsonElement> Props { get; init; } = [];
    public string Type { get; init; } = string.Empty;
}

internal sealed class HelloMessage
{
    public string[] Capabilities { get; init; } = [];
    public string Platform { get; init; } = string.Empty;
    public int Protocol { get; init; }
    public string Type { get; init; } = string.Empty;
}

internal sealed class SnapshotMessage
{
    public int Protocol { get; init; }
    public long Revision { get; init; }
    public WireNode? Root { get; init; }
    public string Type { get; init; } = string.Empty;
}

internal sealed class ControllerErrorMessage
{
    public string Message { get; init; } = "Unknown controller error";
    public int Protocol { get; init; }
    public string? Stack { get; init; }
    public string Type { get; init; } = string.Empty;
}`);
}

function controllerSessionCode(options: WindowsTemplateOptions): string {
  return source(String.raw`
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Dispatching;

namespace ${options.namespace};

internal sealed class ControllerSession : IAsyncDisposable
{
    private const int ProtocolVersion = 1;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly CancellationTokenSource _cancellation = new();
    private readonly DispatcherQueue _dispatcherQueue;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly StringBuilder _standardError = new();
    private Process? _process;
    private StreamWriter? _input;
    private Task? _outputTask;
    private Task? _errorTask;
    private Task? _monitorTask;
    private bool _stopping;

    internal ControllerSession(DispatcherQueue dispatcherQueue)
    {
        _dispatcherQueue = dispatcherQueue;
    }

    internal event Action<string>? Failed;
    internal event Action<HelloMessage>? Hello;
    internal event Action<SnapshotMessage>? Snapshot;

    internal void Start()
    {
        if (_process is not null)
        {
            throw new InvalidOperationException("The NatUI controller has already started.");
        }

        var executablePath = FindControllerPath();
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = Path.GetDirectoryName(executablePath) ?? AppContext.BaseDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true,
        };

        var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("Windows could not start NatUIController.exe.");
        }

        _process = process;
        _input = process.StandardInput;
        _input.AutoFlush = true;
        _outputTask = ReadOutputAsync(process.StandardOutput, _cancellation.Token);
        _errorTask = ReadErrorAsync(process.StandardError, _cancellation.Token);
        _monitorTask = MonitorExitAsync(process);
    }

    internal void SendEvent(string handler, object? payload)
    {
        _ = SendEventAsync(handler, payload);
    }

    private async Task SendEventAsync(string handler, object? payload)
    {
        if (_stopping || _input is null)
        {
            return;
        }

        var message = new Dictionary<string, object?>
        {
            ["handler"] = handler,
            ["protocol"] = ProtocolVersion,
            ["type"] = "event",
        };
        if (payload is not null)
        {
            message["payload"] = payload;
        }

        var line = JsonSerializer.Serialize(message);
        try
        {
            await _writeLock.WaitAsync(_cancellation.Token);
            try
            {
                await _input.WriteLineAsync(line);
                await _input.FlushAsync(_cancellation.Token);
            }
            finally
            {
                _writeLock.Release();
            }
        }
        catch (OperationCanceledException) when (_stopping)
        {
        }
        catch (Exception exception)
        {
            ReportFailure($"Could not send an event to the controller: {exception.Message}");
        }
    }

    private async Task ReadOutputAsync(StreamReader output, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await output.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    return;
                }
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                try
                {
                    DispatchMessage(line);
                }
                catch (Exception exception)
                {
                    ReportFailure($"Invalid controller message: {exception.Message}");
                }
            }
        }
        catch (OperationCanceledException) when (_stopping)
        {
        }
        catch (Exception exception)
        {
            ReportFailure($"Could not read controller output: {exception.Message}");
        }
    }

    private void DispatchMessage(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("The NDJSON value must be an object.");
        }

        var protocol = root.TryGetProperty("protocol", out var protocolValue)
            && protocolValue.TryGetInt32(out var parsedProtocol)
            ? parsedProtocol
            : 0;
        if (protocol != ProtocolVersion)
        {
            throw new JsonException($"Unsupported protocol version {protocol}.");
        }

        var type = root.TryGetProperty("type", out var typeValue)
            ? typeValue.GetString()
            : null;
        switch (type)
        {
            case "hello":
            {
                var hello = Deserialize<HelloMessage>(line);
                if (!string.Equals(hello.Platform, "windows", StringComparison.Ordinal))
                {
                    throw new JsonException($"Controller platform must be windows, received {hello.Platform}.");
                }
                Enqueue(() => Hello?.Invoke(hello));
                break;
            }
            case "snapshot":
            {
                var snapshot = Deserialize<SnapshotMessage>(line);
                Enqueue(() => Snapshot?.Invoke(snapshot));
                break;
            }
            case "error":
            {
                var error = Deserialize<ControllerErrorMessage>(line);
                var details = string.IsNullOrWhiteSpace(error.Stack)
                    ? error.Message
                    : $"{error.Message}{Environment.NewLine}{error.Stack}";
                ReportFailure(details);
                break;
            }
            default:
                throw new JsonException($"Unknown controller message type {type ?? "<missing>"}.");
        }
    }

    private static T Deserialize<T>(string line) where T : class
    {
        return JsonSerializer.Deserialize<T>(line, JsonOptions)
            ?? throw new JsonException($"Could not deserialize {typeof(T).Name}.");
    }

    private async Task ReadErrorAsync(StreamReader error, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await error.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    return;
                }
                if (_standardError.Length < 16_384)
                {
                    _standardError.AppendLine(line);
                }
            }
        }
        catch (OperationCanceledException) when (_stopping)
        {
        }
    }

    private async Task MonitorExitAsync(Process process)
    {
        try
        {
            await process.WaitForExitAsync(_cancellation.Token);
            if (_outputTask is not null)
            {
                await _outputTask;
            }
            if (_errorTask is not null)
            {
                await _errorTask;
            }

            if (!_stopping)
            {
                var details = _standardError.ToString().Trim();
                var message = $"NatUIController.exe exited with code {process.ExitCode}.";
                ReportFailure(details.Length == 0 ? message : $"{message}{Environment.NewLine}{details}");
            }
        }
        catch (OperationCanceledException) when (_stopping)
        {
        }
        catch (Exception exception)
        {
            if (!_stopping)
            {
                ReportFailure($"Could not monitor the controller: {exception.Message}");
            }
        }
    }

    private void Enqueue(Action action)
    {
        if (!_dispatcherQueue.TryEnqueue(() =>
            {
                if (!_stopping)
                {
                    action();
                }
            }))
        {
            throw new InvalidOperationException("The WinUI dispatcher queue is no longer available.");
        }
    }

    private void ReportFailure(string message)
    {
        try
        {
            Enqueue(() => Failed?.Invoke(message));
        }
        catch when (_stopping)
        {
        }
    }

    private static string FindControllerPath()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "NatUIController.exe"),
            Path.Combine(AppContext.BaseDirectory, "controller", "NatUIController.exe"),
            Path.Combine(Environment.CurrentDirectory, "NatUIController.exe"),
            Path.Combine(Environment.CurrentDirectory, "controller", "NatUIController.exe"),
        };
        var path = candidates.FirstOrDefault(File.Exists);
        return path ?? throw new FileNotFoundException(
            "NatUIController.exe was not found beside the host executable or in its controller directory.");
    }

    public async ValueTask DisposeAsync()
    {
        if (_stopping)
        {
            return;
        }

        _stopping = true;
        _cancellation.Cancel();
        try
        {
            _input?.Close();
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
            }
            if (_monitorTask is not null)
            {
                await _monitorTask;
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (InvalidOperationException)
        {
        }
        finally
        {
            _input?.Dispose();
            _process?.Dispose();
            _writeLock.Dispose();
            _cancellation.Dispose();
        }
    }
}`);
}

function rendererCode(options: WindowsTemplateOptions): string {
  return source(String.raw`
using System.Globalization;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.System;
using Windows.UI;
using Windows.UI.Text;

namespace ${options.namespace};

internal sealed class NatUIRenderer
{
    private readonly Action<string, object?> _dispatch;
    private readonly MainWindow _window;
    private readonly HashSet<string> _activeNodeIds = [];
    private readonly Dictionary<string, NodeState> _nodes = [];

    private sealed class NodeState
    {
        internal NodeState(string type)
        {
            Type = type;
            Host = new ContentControl
            {
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                VerticalContentAlignment = VerticalAlignment.Stretch,
            };
        }

        internal Border? Decorator { get; set; }
        internal Dictionary<string, string> Events { get; set; } = [];
        internal bool EventsWired { get; set; }
        internal ContentControl Host { get; }
        internal FrameworkElement? Native { get; set; }
        internal string NativeKind { get; set; } = string.Empty;
        internal string Type { get; set; }
        internal bool Updating { get; set; }
    }

    internal NatUIRenderer(MainWindow window, Action<string, object?> dispatch)
    {
        _window = window;
        _dispatch = dispatch;
    }

    internal FrameworkElement BuildRoot(WireNode? root)
    {
        _activeNodeIds.Clear();
        var result = root is null ? new Grid() : Build(root);
        foreach (var staleId in _nodes.Keys.Where(id => !_activeNodeIds.Contains(id)).ToArray())
        {
            var stale = _nodes[staleId];
            stale.Host.Content = null;
            DetachChildren(stale.Native);
            _nodes.Remove(staleId);
        }
        return result;
    }

    private FrameworkElement Build(WireNode node)
    {
        var state = State(node);
        Prepare(state, node);
        var element = node.Type switch
        {
            "window" => BuildWindow(node, state),
            "vstack" => BuildVStack(node, state),
            "hstack" => BuildHStack(node, state),
            "zstack" => BuildZStack(node, state),
            "text" => BuildText(node, state),
            "rawText" => BuildText(node, state),
            "button" => BuildButton(node, state),
            "textfield" => BuildTextField(node, state),
            "toggle" => BuildToggle(node, state),
            "slider" => BuildSlider(node, state),
            "image" => BuildImage(node, state),
            "scrollview" => BuildScrollView(node, state),
            "progress" => BuildProgress(node, state),
            "spacer" => BuildSpacer(state),
            "divider" => BuildDivider(state),
            _ => BuildUnsupported(node, state),
        };
        state.Native = element;
        var decorated = Decorate(element, node, state, node.Type != "window");
        state.Host.Content = decorated;
        state.Host.Tag = node.Id;
        return state.Host;
    }

    private NodeState State(WireNode node)
    {
        _activeNodeIds.Add(node.Id);
        if (!_nodes.TryGetValue(node.Id, out var state))
        {
            state = new NodeState(node.Type);
            _nodes.Add(node.Id, state);
        }
        if (state.Type != node.Type)
        {
            state.Host.Content = null;
            if (state.Decorator is not null)
            {
                state.Decorator.Child = null;
            }
            DetachChildren(state.Native);
            state.Native = null;
            state.NativeKind = string.Empty;
            state.EventsWired = false;
            state.Type = node.Type;
        }
        return state;
    }

    private static void Prepare(NodeState state, WireNode node)
    {
        state.Events = node.Events;
        state.Host.HorizontalAlignment = HorizontalAlignment.Stretch;
        state.Host.VerticalAlignment = VerticalAlignment.Stretch;
    }

    private static void DetachChildren(FrameworkElement? element)
    {
        switch (element)
        {
            case Panel panel:
                panel.Children.Clear();
                break;
            case Border border:
                border.Child = null;
                break;
            case ScrollViewer scrollViewer:
                scrollViewer.Content = null;
                break;
            case ContentControl contentControl:
                contentControl.Content = null;
                break;
        }
    }

    private static T Native<T>(NodeState state, string kind, Func<T> create) where T : FrameworkElement
    {
        if (state.NativeKind != kind || state.Native is not T existing)
        {
            state.Host.Content = null;
            if (state.Decorator is not null)
            {
                state.Decorator.Child = null;
            }
            DetachChildren(state.Native);
            var replacement = create();
            state.Native = replacement;
            state.NativeKind = kind;
            state.EventsWired = false;
            return replacement;
        }
        return existing;
    }

    private void Emit(NodeState state, string eventName, object? payload)
    {
        if (!state.Updating && state.Events.TryGetValue(eventName, out var handler))
        {
            _dispatch(handler, payload);
        }
    }

    private FrameworkElement BuildWindow(WireNode node, NodeState state)
    {
        _window.ConfigureWindow(
            Text(node, "title"),
            Integer(node, "width"),
            Integer(node, "height"),
            Boolean(node, "resizable"));
        var panel = Native(state, "window", static () => new Grid());
        UpdateGrid(panel, node.Children, Orientation.Vertical, 0);
        return panel;
    }

    private FrameworkElement BuildVStack(WireNode node, NodeState state)
    {
        var panel = Native(state, "vstack", static () => new Grid());
        panel.RowSpacing = Number(node, "spacing") ?? 8;
        panel.RowDefinitions.Clear();
        panel.ColumnDefinitions.Clear();
        var alignment = Text(node, "alignment") ?? "center";
        var desired = new List<FrameworkElement>(node.Children.Count);
        for (var index = 0; index < node.Children.Count; index++)
        {
            var childNode = node.Children[index];
            panel.RowDefinitions.Add(new RowDefinition
            {
                Height = childNode.Type == "spacer" && Number(childNode, "height") is null
                    ? new GridLength(1, GridUnitType.Star)
                    : GridLength.Auto,
            });
            var child = Build(childNode);
            child.HorizontalAlignment = alignment switch
            {
                "leading" => HorizontalAlignment.Left,
                "trailing" => HorizontalAlignment.Right,
                _ => HorizontalAlignment.Center,
            };
            Grid.SetRow(child, index);
            Grid.SetColumn(child, 0);
            desired.Add(child);
        }
        ReconcileChildren(panel, desired);
        return panel;
    }

    private FrameworkElement BuildHStack(WireNode node, NodeState state)
    {
        var panel = Native(state, "hstack", static () => new Grid());
        panel.ColumnSpacing = Number(node, "spacing") ?? 8;
        panel.RowDefinitions.Clear();
        panel.ColumnDefinitions.Clear();
        var alignment = Text(node, "alignment") ?? "center";
        var desired = new List<FrameworkElement>(node.Children.Count);
        for (var index = 0; index < node.Children.Count; index++)
        {
            var childNode = node.Children[index];
            panel.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = childNode.Type == "spacer" && Number(childNode, "width") is null
                    ? new GridLength(1, GridUnitType.Star)
                    : GridLength.Auto,
            });
            var child = Build(childNode);
            child.VerticalAlignment = alignment switch
            {
                "top" or "firstTextBaseline" => VerticalAlignment.Top,
                "bottom" or "lastTextBaseline" => VerticalAlignment.Bottom,
                _ => VerticalAlignment.Center,
            };
            Grid.SetColumn(child, index);
            Grid.SetRow(child, 0);
            desired.Add(child);
        }
        ReconcileChildren(panel, desired);
        return panel;
    }

    private FrameworkElement BuildZStack(WireNode node, NodeState state)
    {
        var panel = Native(state, "zstack", static () => new Grid());
        panel.RowDefinitions.Clear();
        panel.ColumnDefinitions.Clear();
        var alignment = Text(node, "alignment") ?? "center";
        var desired = new List<FrameworkElement>(node.Children.Count);
        foreach (var childNode in node.Children)
        {
            var child = Build(childNode);
            ApplyZAlignment(child, alignment);
            Grid.SetRow(child, 0);
            Grid.SetColumn(child, 0);
            desired.Add(child);
        }
        ReconcileChildren(panel, desired);
        return panel;
    }

    private static void ApplyZAlignment(FrameworkElement child, string alignment)
    {
        child.HorizontalAlignment = alignment switch
        {
            "topLeading" or "leading" or "bottomLeading" => HorizontalAlignment.Left,
            "topTrailing" or "trailing" or "bottomTrailing" => HorizontalAlignment.Right,
            _ => HorizontalAlignment.Center,
        };
        child.VerticalAlignment = alignment switch
        {
            "topLeading" or "top" or "topTrailing" => VerticalAlignment.Top,
            "bottomLeading" or "bottom" or "bottomTrailing" => VerticalAlignment.Bottom,
            _ => VerticalAlignment.Center,
        };
    }

    private static FrameworkElement BuildText(WireNode node, NodeState state)
    {
        var text = Native(state, "text", static () => new TextBlock());
        text.Text = Text(node, "content") ?? string.Empty;
        text.TextWrapping = TextWrapping.Wrap;
        text.FontSize = Number(node, "fontSize") ?? 14;
        text.FontWeight = FontWeight(Text(node, "fontWeight") ?? "regular");
        text.MaxLines = Math.Max(0, Integer(node, "lineLimit") ?? 0);
        text.TextTrimming = text.MaxLines > 0 ? TextTrimming.CharacterEllipsis : TextTrimming.None;
        text.IsTextSelectionEnabled = Boolean(node, "selectable") == true;
        text.TextAlignment = Text(node, "textAlign") switch
        {
            "center" => TextAlignment.Center,
            "trailing" => TextAlignment.Right,
            _ => TextAlignment.Left,
        };
        return text;
    }

    private FrameworkElement BuildButton(WireNode node, NodeState state)
    {
        var button = Native(state, "button", static () => new Button());
        button.Content = Text(node, "title") ?? string.Empty;
        if (!state.EventsWired)
        {
            button.Click += (_, _) => Emit(state, "press", null);
            state.EventsWired = true;
        }
        if (Text(node, "role") == "destructive")
        {
            button.Foreground = Brush("red");
        }
        else
        {
            button.ClearValue(Control.ForegroundProperty);
        }
        return button;
    }

    private FrameworkElement BuildTextField(WireNode node, NodeState state)
    {
        var placeholder = Text(node, "placeholder") ?? string.Empty;
        var value = Text(node, "value") ?? string.Empty;
        if (Boolean(node, "secure") == true)
        {
            var password = Native(state, "textfield:secure", static () => new PasswordBox());
            state.Updating = true;
            try
            {
                if (password.Password != value)
                {
                    password.Password = value;
                }
                password.PlaceholderText = placeholder;
            }
            finally
            {
                state.Updating = false;
            }
            if (!state.EventsWired)
            {
                password.PasswordChanged += (_, _) => Emit(state, "change", password.Password);
                password.KeyDown += (_, args) =>
                {
                    if (args.Key == VirtualKey.Enter)
                    {
                        Emit(state, "submit", null);
                    }
                };
                state.EventsWired = true;
            }
            return password;
        }

        var text = Native(state, "textfield:plain", static () => new TextBox { AcceptsReturn = false });
        state.Updating = true;
        try
        {
            if (text.Text != value)
            {
                var selectionStart = text.SelectionStart;
                text.Text = value;
                text.SelectionStart = Math.Min(selectionStart, text.Text.Length);
            }
            text.PlaceholderText = placeholder;
        }
        finally
        {
            state.Updating = false;
        }
        if (!state.EventsWired)
        {
            text.TextChanged += (_, _) => Emit(state, "change", text.Text);
            text.KeyDown += (_, args) =>
            {
                if (args.Key == VirtualKey.Enter)
                {
                    Emit(state, "submit", null);
                }
            };
            state.EventsWired = true;
        }
        return text;
    }

    private FrameworkElement BuildToggle(WireNode node, NodeState state)
    {
        var toggle = Native(state, "toggle", static () => new ToggleSwitch());
        state.Updating = true;
        try
        {
            toggle.Header = Text(node, "label") ?? string.Empty;
            toggle.IsOn = Boolean(node, "value") == true;
        }
        finally
        {
            state.Updating = false;
        }
        if (!state.EventsWired)
        {
            toggle.Toggled += (_, _) => Emit(state, "change", toggle.IsOn);
            state.EventsWired = true;
        }
        return toggle;
    }

    private FrameworkElement BuildSlider(WireNode node, NodeState state)
    {
        var minimum = Number(node, "minimum") ?? 0;
        var maximum = Number(node, "maximum") ?? 1;
        if (maximum <= minimum)
        {
            maximum = minimum + 1;
        }
        var slider = Native(state, "slider", static () => new Slider());
        state.Updating = true;
        try
        {
            slider.Minimum = minimum;
            slider.Maximum = maximum;
            slider.Value = Math.Clamp(Number(node, "value") ?? minimum, minimum, maximum);
            if (Number(node, "step") is { } step && step > 0)
            {
                slider.StepFrequency = step;
                slider.SmallChange = step;
                slider.SnapsTo = SliderSnapsTo.StepValues;
            }
            else
            {
                var continuousStep = (maximum - minimum) / 100;
                slider.StepFrequency = continuousStep;
                slider.SmallChange = continuousStep;
                slider.SnapsTo = SliderSnapsTo.StepValues;
            }
        }
        finally
        {
            state.Updating = false;
        }
        if (!state.EventsWired)
        {
            slider.ValueChanged += (_, _) => Emit(state, "change", slider.Value);
            state.EventsWired = true;
        }
        return slider;
    }

    private static FrameworkElement BuildImage(WireNode node, NodeState state)
    {
        if (Text(node, "source") is { Length: > 0 } source)
        {
            var image = Native(state, $"image:{source}", () => new Image
            {
                Source = new BitmapImage(ImageUri(source)),
            });
            image.Stretch = Text(node, "fit") == "fill" ? Stretch.UniformToFill : Stretch.Uniform;
            if (Text(node, "alt") is { } alt)
            {
                AutomationProperties.SetName(image, alt);
            }
            else
            {
                AutomationProperties.SetName(image, string.Empty);
            }
            return image;
        }

        var icon = Native(state, "image:system", static () => new FontIcon
        {
            FontFamily = new FontFamily("Segoe Fluent Icons"),
        });
        icon.Glyph = Glyph(Text(node, "systemName"));
        if (Text(node, "alt") is { } iconAlt)
        {
            AutomationProperties.SetName(icon, iconAlt);
        }
        else
        {
            AutomationProperties.SetName(icon, string.Empty);
        }
        return icon;
    }

    private FrameworkElement BuildScrollView(WireNode node, NodeState state)
    {
        var axis = Text(node, "axis") ?? "vertical";
        var indicators = Boolean(node, "showsIndicators") != false;
        var viewer = Native(state, "scrollview", static () => new ScrollViewer());
        viewer.HorizontalScrollMode = axis is "horizontal" or "both" ? ScrollMode.Enabled : ScrollMode.Disabled;
        viewer.VerticalScrollMode = axis is "vertical" or "both" ? ScrollMode.Enabled : ScrollMode.Disabled;
        viewer.HorizontalScrollBarVisibility = indicators && (axis is "horizontal" or "both")
            ? ScrollBarVisibility.Auto
            : ScrollBarVisibility.Hidden;
        viewer.VerticalScrollBarVisibility = indicators && (axis is "vertical" or "both")
            ? ScrollBarVisibility.Auto
            : ScrollBarVisibility.Hidden;
        var content = viewer.Content as Grid ?? new Grid();
        UpdateGrid(
            content,
            node.Children,
            axis == "horizontal" ? Orientation.Horizontal : Orientation.Vertical,
            0);
        if (!ReferenceEquals(viewer.Content, content))
        {
            viewer.Content = content;
        }
        return viewer;
    }

    private static FrameworkElement BuildProgress(WireNode node, NodeState state)
    {
        var hasLabel = Text(node, "label") is { Length: > 0 };
        var panel = Native(state, hasLabel ? "progress:labeled" : "progress", () => hasLabel
            ? new StackPanel { Orientation = Orientation.Vertical, Spacing = 4 }
            : new ProgressBar());
        var progress = panel as ProgressBar ?? new ProgressBar();
        if (panel is StackPanel stack)
        {
            TextBlock label;
            if (stack.Children.Count == 2
                && stack.Children[0] is TextBlock existingLabel
                && stack.Children[1] is ProgressBar existingProgress)
            {
                label = existingLabel;
                progress = existingProgress;
            }
            else
            {
                stack.Children.Clear();
                label = new TextBlock();
                progress = new ProgressBar();
                stack.Children.Add(label);
                stack.Children.Add(progress);
            }
            label.Text = Text(node, "label") ?? string.Empty;
        }
        progress.Minimum = 0;
        progress.Maximum = 1;
        if (Number(node, "value") is { } value)
        {
            progress.IsIndeterminate = false;
            progress.Value = Math.Clamp(value, 0, 1);
        }
        else
        {
            progress.IsIndeterminate = true;
        }

        return panel;
    }

    private static FrameworkElement BuildSpacer(NodeState state)
    {
        return Native(state, "spacer", static () => new Grid
        {
            MinHeight = 1,
            MinWidth = 1,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
        });
    }

    private static FrameworkElement BuildDivider(NodeState state)
    {
        return Native(state, "divider", static () => new Border
        {
            Height = 1,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Background = Brush("secondary"),
            Opacity = 0.45,
        });
    }

    private static FrameworkElement BuildUnsupported(WireNode node, NodeState state)
    {
        var text = Native(state, "unsupported", static () => new TextBlock { Foreground = Brush("red") });
        text.Text = $"Unsupported NatUI element: {node.Type}";
        return text;
    }

    private void UpdateGrid(
        Grid panel,
        IReadOnlyList<WireNode> children,
        Orientation orientation,
        double spacing)
    {
        panel.RowDefinitions.Clear();
        panel.ColumnDefinitions.Clear();
        panel.RowSpacing = orientation == Orientation.Vertical ? spacing : 0;
        panel.ColumnSpacing = orientation == Orientation.Horizontal ? spacing : 0;
        var desired = new List<FrameworkElement>(children.Count);
        for (var index = 0; index < children.Count; index++)
        {
            var childNode = children[index];
            var expands = childNode.Type == "spacer"
                && Number(childNode, orientation == Orientation.Vertical ? "height" : "width") is null;
            var child = Build(childNode);
            if (orientation == Orientation.Vertical)
            {
                panel.RowDefinitions.Add(new RowDefinition
                {
                    Height = expands ? new GridLength(1, GridUnitType.Star) : GridLength.Auto,
                });
                Grid.SetRow(child, index);
                Grid.SetColumn(child, 0);
            }
            else
            {
                panel.ColumnDefinitions.Add(new ColumnDefinition
                {
                    Width = expands ? new GridLength(1, GridUnitType.Star) : GridLength.Auto,
                });
                Grid.SetColumn(child, index);
                Grid.SetRow(child, 0);
            }
            desired.Add(child);
        }
        ReconcileChildren(panel, desired);
    }

    private static void ReconcileChildren(Panel panel, IReadOnlyList<FrameworkElement> desired)
    {
        for (var index = 0; index < desired.Count; index++)
        {
            var child = desired[index];
            if (index < panel.Children.Count && ReferenceEquals(panel.Children[index], child))
            {
                continue;
            }

            var existingIndex = panel.Children.IndexOf(child);
            if (existingIndex >= 0)
            {
                panel.Children.RemoveAt(existingIndex);
            }
            panel.Children.Insert(index, child);
        }
        while (panel.Children.Count > desired.Count)
        {
            panel.Children.RemoveAt(panel.Children.Count - 1);
        }
    }

    private static FrameworkElement Decorate(
        FrameworkElement element,
        WireNode node,
        NodeState state,
        bool applySize)
    {
        FrameworkElement result = element;
        var padding = Padding(node);
        var background = Text(node, "background");
        var cornerRadius = Number(node, "cornerRadius");
        if (padding is not null || background is not null || cornerRadius is not null)
        {
            state.Decorator ??= new Border();
            state.Decorator.Child = element;
            state.Decorator.Padding = padding ?? new Thickness(0);
            state.Decorator.Background = background is null ? null : Brush(background);
            state.Decorator.CornerRadius = new CornerRadius(Math.Max(0, cornerRadius ?? 0));
            result = state.Decorator;
        }
        else if (state.Decorator is not null)
        {
            state.Decorator.Child = null;
            state.Decorator.Padding = new Thickness(0);
            state.Decorator.Background = null;
            state.Decorator.CornerRadius = new CornerRadius(0);
        }

        if (applySize)
        {
            ApplySize(result, node);
        }
        if (Number(node, "opacity") is { } opacity)
        {
            result.Opacity = Math.Clamp(opacity, 0, 1);
        }
        else
        {
            result.Opacity = 1;
        }
        if (Boolean(node, "hidden") == true)
        {
            result.Visibility = Visibility.Collapsed;
        }
        else
        {
            result.Visibility = Visibility.Visible;
        }
        if (Boolean(node, "disabled") == true)
        {
            element.IsHitTestVisible = false;
            if (element is Control control)
            {
                control.IsEnabled = false;
            }
        }
        else
        {
            element.IsHitTestVisible = true;
            if (element is Control control)
            {
                control.IsEnabled = true;
            }
        }
        if (Text(node, "foreground") is { } foreground)
        {
            ApplyForeground(element, Brush(foreground));
        }
        else if (node.Type != "button" || Text(node, "role") != "destructive")
        {
            ClearForeground(element);
        }

        var automationId = Text(node, "testID") ?? Text(node, "id") ?? node.Id;
        AutomationProperties.SetAutomationId(result, automationId);
        AutomationProperties.SetAutomationId(state.Host, automationId);
        if (Text(node, "accessibilityLabel") is { } label)
        {
            AutomationProperties.SetName(result, label);
            AutomationProperties.SetName(state.Host, label);
        }
        else
        {
            AutomationProperties.SetName(result, string.Empty);
            AutomationProperties.SetName(state.Host, string.Empty);
        }
        if (Text(node, "accessibilityHint") is { } hint)
        {
            AutomationProperties.SetHelpText(result, hint);
            AutomationProperties.SetHelpText(state.Host, hint);
        }
        else
        {
            AutomationProperties.SetHelpText(result, string.Empty);
            AutomationProperties.SetHelpText(state.Host, string.Empty);
        }
        result.Tag = node.Id;
        return result;
    }

    private static void ApplySize(FrameworkElement element, WireNode node)
    {
        element.Width = Number(node, "width") is { } width ? Math.Max(0, width) : double.NaN;
        element.Height = Number(node, "height") is { } height ? Math.Max(0, height) : double.NaN;
        element.MinWidth = Number(node, "minWidth") is { } minWidth ? Math.Max(0, minWidth) : 0;
        element.MinHeight = Number(node, "minHeight") is { } minHeight ? Math.Max(0, minHeight) : 0;
        element.MaxWidth = Number(node, "maxWidth") is { } maxWidth
            ? Math.Max(0, maxWidth)
            : double.PositiveInfinity;
        element.MaxHeight = Number(node, "maxHeight") is { } maxHeight
            ? Math.Max(0, maxHeight)
            : double.PositiveInfinity;
    }

    private static void ApplyForeground(FrameworkElement element, Brush brush)
    {
        switch (element)
        {
            case Control control:
                control.Foreground = brush;
                break;
            case TextBlock text:
                text.Foreground = brush;
                break;
            case FontIcon icon:
                icon.Foreground = brush;
                break;
        }
    }

    private static void ClearForeground(FrameworkElement element)
    {
        switch (element)
        {
            case Control control:
                control.ClearValue(Control.ForegroundProperty);
                break;
            case TextBlock text:
                text.ClearValue(TextBlock.ForegroundProperty);
                break;
            case FontIcon icon:
                icon.ClearValue(FontIcon.ForegroundProperty);
                break;
        }
    }

    private static Thickness? Padding(WireNode node)
    {
        if (!node.Props.TryGetValue("padding", out var value))
        {
            return null;
        }
        if (TryDouble(value, out var all))
        {
            return new Thickness(Math.Max(0, all));
        }
        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return new Thickness(
            ObjectNumber(value, "leading") ?? 0,
            ObjectNumber(value, "top") ?? 0,
            ObjectNumber(value, "trailing") ?? 0,
            ObjectNumber(value, "bottom") ?? 0);
    }

    private static double? ObjectNumber(JsonElement value, string property)
    {
        return value.TryGetProperty(property, out var child) && TryDouble(child, out var number)
            ? Math.Max(0, number)
            : null;
    }

    private static string? Event(WireNode node, string name)
    {
        return node.Events.TryGetValue(name, out var handler) ? handler : null;
    }

    private static string? Text(WireNode node, string name)
    {
        if (!node.Props.TryGetValue(name, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }
        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    private static double? Number(WireNode node, string name)
    {
        return node.Props.TryGetValue(name, out var value) && TryDouble(value, out var number)
            ? number
            : null;
    }

    private static int? Integer(WireNode node, string name)
    {
        return Number(node, name) is { } number && double.IsFinite(number)
            ? (int)Math.Round(number)
            : null;
    }

    private static bool? Boolean(WireNode node, string name)
    {
        if (!node.Props.TryGetValue(name, out var value))
        {
            return null;
        }
        if (value.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return value.GetBoolean();
        }
        return value.ValueKind == JsonValueKind.String && bool.TryParse(value.GetString(), out var parsed)
            ? parsed
            : null;
    }

    private static bool TryDouble(JsonElement value, out double number)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out number))
        {
            return double.IsFinite(number);
        }
        if (value.ValueKind == JsonValueKind.String
            && double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
        {
            return double.IsFinite(number);
        }
        number = 0;
        return false;
    }

    private static Windows.UI.Text.FontWeight FontWeight(string weight)
    {
        return weight switch
        {
            "ultralight" => FontWeights.ExtraLight,
            "thin" => FontWeights.Thin,
            "light" => FontWeights.Light,
            "medium" => FontWeights.Medium,
            "semibold" => FontWeights.SemiBold,
            "bold" => FontWeights.Bold,
            "heavy" => FontWeights.ExtraBold,
            "black" => FontWeights.Black,
            _ => FontWeights.Normal,
        };
    }

    private static Uri ImageUri(string source)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var absolute))
        {
            return absolute;
        }
        var relative = source.Replace('\\', '/').TrimStart('/');
        return new Uri($"ms-appx:///{relative}");
    }

    private static string Glyph(string? systemName)
    {
        return systemName?.ToLowerInvariant() switch
        {
            "plus" or "add" => "\uE710",
            "minus" or "remove" => "\uE738",
            "checkmark" or "check" => "\uE8FB",
            "xmark" or "close" => "\uE711",
            "heart" => "\uE734",
            "star" => "\uE735",
            "gear" or "settings" => "\uE713",
            "magnifyingglass" or "search" => "\uE721",
            "house" or "home" => "\uE80F",
            "person" => "\uE77B",
            "trash" => "\uE74D",
            "pencil" => "\uE70F",
            "folder" => "\uE8B7",
            "document" => "\uE7C3",
            _ => "\uE946",
        };
    }

    private static Brush Brush(string name)
    {
        var normalized = name.Trim().ToLowerInvariant();
        var resource = normalized switch
        {
            "accent" => "AccentFillColorDefaultBrush",
            "primary" => "TextFillColorPrimaryBrush",
            "secondary" => "TextFillColorSecondaryBrush",
            _ => null,
        };
        if (resource is not null
            && Application.Current.Resources.TryGetValue(resource, out var resourceValue)
            && resourceValue is Brush resourceBrush)
        {
            return resourceBrush;
        }
        if (HexColor(normalized) is { } hexColor)
        {
            return new SolidColorBrush(hexColor);
        }

        var color = normalized switch
        {
            "red" => Colors.Red,
            "orange" => Colors.Orange,
            "yellow" => Colors.Yellow,
            "green" => Colors.Green,
            "mint" => ColorHelper.FromArgb(255, 0, 199, 190),
            "teal" => ColorHelper.FromArgb(255, 0, 128, 128),
            "cyan" => Colors.Cyan,
            "blue" => Colors.Blue,
            "indigo" => ColorHelper.FromArgb(255, 75, 0, 130),
            "purple" => Colors.Purple,
            "pink" => Colors.HotPink,
            "brown" => Colors.Brown,
            "gray" or "grey" => Colors.Gray,
            "black" => Colors.Black,
            "white" => Colors.White,
            "transparent" => Colors.Transparent,
            _ => Colors.Black,
        };
        return new SolidColorBrush(color);
    }

    private static Color? HexColor(string value)
    {
        if (!value.StartsWith('#'))
        {
            return null;
        }
        var hex = value[1..];
        if (hex.Length == 3)
        {
            hex = $"FF{hex[0]}{hex[0]}{hex[1]}{hex[1]}{hex[2]}{hex[2]}";
        }
        else if (hex.Length == 4)
        {
            hex = $"{hex[0]}{hex[0]}{hex[1]}{hex[1]}{hex[2]}{hex[2]}{hex[3]}{hex[3]}";
        }
        else if (hex.Length == 6)
        {
            hex = $"FF{hex}";
        }
        if (hex.Length != 8 || !uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var argb))
        {
            return null;
        }
        return ColorHelper.FromArgb(
            (byte)(argb >> 24),
            (byte)(argb >> 16),
            (byte)(argb >> 8),
            (byte)argb);
    }
}`);
}

function appManifest(options: WindowsTemplateOptions): string {
  return source(String.raw`
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity
      name="${xml(options.identifier)}"
      version="${manifestVersion(options.version)}"
      processorArchitecture="*"
      type="win32" />
  <description>${xml(options.name)}</description>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>`);
}

function publishProfile(options: WindowsTemplateOptions): string {
  const runtimeIdentifier = `win-${options.architecture}`;
  const platform = options.architecture === "arm64" ? "ARM64" : "x64";
  return source(String.raw`
<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <Configuration>Release</Configuration>
    <Platform>${platform}</Platform>
    <RuntimeIdentifier>${runtimeIdentifier}</RuntimeIdentifier>
    <SelfContained>true</SelfContained>
    <WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained>
    <PublishSingleFile>false</PublishSingleFile>
    <PublishTrimmed>false</PublishTrimmed>
  </PropertyGroup>
</Project>`);
}

export function windowsProjectFiles(options: WindowsTemplateOptions): Record<string, string> {
  return {
    "NatUIHost.csproj": projectFile(options),
    "App.xaml": appXaml(options),
    "App.xaml.cs": appCode(options),
    "MainWindow.xaml": mainWindowXaml(options),
    "MainWindow.xaml.cs": mainWindowCode(options),
    "NatUIProtocol.cs": protocolCode(options),
    "ControllerSession.cs": controllerSessionCode(options),
    "NatUIRenderer.cs": rendererCode(options),
    "app.manifest": appManifest(options),
    [`Properties/PublishProfiles/win-${options.architecture}.pubxml`]: publishProfile(options),
  };
}
