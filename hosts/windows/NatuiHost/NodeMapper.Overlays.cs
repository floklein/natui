using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace NatuiHost;

/// <summary>
/// Presentation kinds: Sheet and Alert (ContentDialog popup layers), Popover
/// (Flyout on the anchor). All three are controlled by the boolean "value"
/// (presented); hosts only ever set it to false.
/// </summary>
internal sealed partial class NodeMapper
{
    /// <summary>
    /// WinUI permits one ContentDialog per window. The gate serializes sheets
    /// and alerts; a requested alert temporarily hides the active sheet, then
    /// restores it if its controlled value is still true. The state sets also
    /// distinguish remote closure from native user dismissal.
    /// </summary>
    private readonly SemaphoreSlim _contentDialogGate = new(1, 1);
    private readonly Dictionary<int, NatuiNode> _sheetNodes = [];
    private readonly Dictionary<int, NatuiNode> _alertNodes = [];
    private readonly HashSet<int> _pendingSheets = [];
    private readonly HashSet<int> _pendingAlerts = [];
    private readonly HashSet<int> _openSheets = [];
    private readonly HashSet<int> _openAlerts = [];
    private readonly HashSet<int> _sheetClosingRemote = [];
    private readonly HashSet<int> _sheetSuspendedForAlert = [];
    private readonly HashSet<int> _alertClosingRemote = [];
    private readonly HashSet<int> _popoverClosingRemote = [];
    private int _alertPresentationCount;

    /// <summary>
    /// Per sheet node, how many times presentation has been re-enqueued while
    /// the window still had no XamlRoot. Bounded so a window that never gets
    /// one cannot spin the dispatcher forever.
    /// </summary>
    private readonly Dictionary<int, int> _sheetXamlRootRetries = [];

    private const int MaxSheetXamlRootRetries = 20;

    // -- Sheet --------------------------------------------------------------------

    private FrameworkElement BuildSheet(NatuiNode node)
    {
        // Children mount directly into the popup dialog's content stack via
        // _contentSurface. The in-tree element remains only as a collapsed
        // placeholder, matching Alert and the macOS presentation model.
        var content = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            CrossAlignment = "leading",
            Spacing = 0,
        };
        _contentSurface[node.Id] = content;
        node.Hosted = new ContentDialog
        {
            Content = content,
        };
        _sheetNodes[node.Id] = node;
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplySheetProps(NatuiNode node)
    {
        if (node.Hosted is not ContentDialog dialog) return;
        var presented = Json.Bool(node.Props, "value") ?? false;
        if (presented)
        {
            RequestSheet(node, dialog);
        }
        else if (_openSheets.Contains(node.Id))
        {
            _sheetClosingRemote.Add(node.Id);
            dialog.Hide();
        }
    }

    private void RequestSheet(NatuiNode node, ContentDialog dialog)
    {
        if (_alertPresentationCount > 0
            || _openSheets.Contains(node.Id)
            || !_pendingSheets.Add(node.Id))
        {
            return;
        }
        _ = ShowSheetAsync(node, dialog);
    }

    private async Task ShowSheetAsync(NatuiNode node, ContentDialog dialog)
    {
        await _contentDialogGate.WaitAsync();
        _pendingSheets.Remove(node.Id);
        var resumeImmediately = true;
        try
        {
            if (!IsCurrentSheet(node, dialog)
                || !(Json.Bool(node.Props, "value") ?? false)
                || _alertPresentationCount > 0)
            {
                return;
            }
            if (RootStack.XamlRoot is not { } xamlRoot)
            {
                // The retry is the dispatcher hop below, never this call's
                // finally; resuming there would bypass the bound entirely.
                resumeImmediately = false;
                var attempts = _sheetXamlRootRetries.GetValueOrDefault(node.Id);
                _sheetXamlRootRetries[node.Id] = attempts + 1;
                if (attempts >= MaxSheetXamlRootRetries)
                {
                    if (attempts == MaxSheetXamlRootRetries)
                    {
                        Ipc.Log($"Sheet {node.Id}: no XamlRoot after {attempts} retries; giving up");
                    }
                    return;
                }
                RootStack.DispatcherQueue.TryEnqueue(
                    DispatcherQueuePriority.Low,
                    ResumePresentedSheets);
                return;
            }

            _sheetXamlRootRetries.Remove(node.Id);
            dialog.XamlRoot = xamlRoot;
            _openSheets.Add(node.Id);
            try
            {
                await dialog.ShowAsync();
            }
            catch (Exception ex)
            {
                Ipc.Log($"Sheet {node.Id}: ShowAsync failed: {ex.Message}");
                _sheetClosingRemote.Remove(node.Id);
                _sheetSuspendedForAlert.Remove(node.Id);
                if (IsCurrentSheet(node, dialog)
                    && (Json.Bool(node.Props, "value") ?? false))
                {
                    node.UserEdit(JsonValue.Create(false));
                }
                return;
            }
            finally
            {
                _openSheets.Remove(node.Id);
            }

            var closedRemotely = _sheetClosingRemote.Remove(node.Id);
            var suspended = _sheetSuspendedForAlert.Remove(node.Id);
            if (!closedRemotely
                && !suspended
                && IsCurrentSheet(node, dialog)
                && (Json.Bool(node.Props, "value") ?? false))
            {
                node.UserEdit(JsonValue.Create(false));
            }
        }
        finally
        {
            _contentDialogGate.Release();
            if (resumeImmediately && _alertPresentationCount == 0) ResumePresentedSheets();
        }
    }

    private bool IsCurrentSheet(NatuiNode node, ContentDialog dialog) =>
        _sheetNodes.TryGetValue(node.Id, out var current)
        && ReferenceEquals(current, node)
        && ReferenceEquals(node.Hosted, dialog);

    private void ResumePresentedSheets()
    {
        if (_alertPresentationCount > 0) return;
        foreach (var node in _sheetNodes.Values.ToList())
        {
            if ((Json.Bool(node.Props, "value") ?? false)
                && node.Hosted is ContentDialog dialog)
            {
                RequestSheet(node, dialog);
            }
        }
    }

    // -- Alert --------------------------------------------------------------------

    private FrameworkElement BuildAlert(NatuiNode node)
    {
        // Fully data-driven: children are ignored, the dialog is built from
        // props in ShowAlertAsync when value flips true.
        _alertNodes[node.Id] = node;
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplyAlertProps(NatuiNode node)
    {
        var presented = Json.Bool(node.Props, "value") ?? false;
        if (presented)
        {
            RequestAlert(node);
        }
        else if (node.Hosted is ContentDialog dialog && _openAlerts.Contains(node.Id))
        {
            _alertClosingRemote.Add(node.Id);
            dialog.Hide();
        }
    }

    private void RequestAlert(NatuiNode node)
    {
        if (!_alertNodes.TryGetValue(node.Id, out var current)
            || !ReferenceEquals(current, node)
            || _openAlerts.Contains(node.Id)
            || !_pendingAlerts.Add(node.Id))
        {
            return;
        }

        _alertPresentationCount++;
        SuspendOpenSheetsForAlert();
        _ = ShowAlertAsync(node);
    }

    private void SuspendOpenSheetsForAlert()
    {
        foreach (var id in _openSheets.ToList())
        {
            if (!_sheetNodes.TryGetValue(id, out var sheet)
                || sheet.Hosted is not ContentDialog dialog)
            {
                continue;
            }
            _sheetSuspendedForAlert.Add(id);
            dialog.Hide();
        }
    }

    private async Task ShowAlertAsync(NatuiNode node)
    {
        await _contentDialogGate.WaitAsync();
        _pendingAlerts.Remove(node.Id);
        var retryAfterRelease = false;
        var retryOnDispatcher = false;
        try
        {
            if (!IsCurrentAlert(node) || !(Json.Bool(node.Props, "value") ?? false))
            {
                _alertClosingRemote.Remove(node.Id);
                return;
            }
            if (RootStack.XamlRoot is not { } xamlRoot)
            {
                retryOnDispatcher = true;
                return;
            }

            var dialog = new ContentDialog { Title = node.Str("title") ?? "", XamlRoot = xamlRoot };
            var body = new StackPanel { Spacing = 12 };
            if (node.Str("message") is { } message)
            {
                body.Children.Add(new TextBlock
                {
                    Text = message,
                    TextWrapping = TextWrapping.Wrap,
                });
            }

            var specs = new List<(string Id, string Label, string? Role)>();
            string? cancelId = null;
            var nativeCancelIndex = -1;
            foreach (var entry in Json.Arr(node.Props, "buttons") ?? [])
            {
                if (entry is not JsonObject button) continue;
                var id = Json.Str(button, "id") ?? "";
                var role = Json.Str(button, "role");
                specs.Add((id, Json.Str(button, "label") ?? id, role));
                if (role == "cancel" && cancelId is null)
                {
                    cancelId = id;
                    nativeCancelIndex = specs.Count - 1;
                    dialog.CloseButtonText = Json.Str(button, "label") ?? id;
                }
            }

            // ContentDialog's native command area is limited to close plus two
            // actions. Keep the first cancel action there so Escape and system
            // back select it, then render every remaining action as a native
            // Button in the dialog content instead of dropping extras.
            var customSpecs = specs.Where((_, index) => index != nativeCancelIndex).ToList();
            var actions = new StackPanel
            {
                Orientation = customSpecs.Count <= 2
                    ? Orientation.Horizontal
                    : Orientation.Vertical,
                HorizontalAlignment = HorizontalAlignment.Right,
                Spacing = 8,
            };
            var buttonHandled = false;
            foreach (var spec in customSpecs)
            {
                var action = new Button
                {
                    Content = spec.Label,
                    HorizontalAlignment = customSpecs.Count <= 2
                        ? HorizontalAlignment.Right
                        : HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Center,
                };
                if (spec.Role == "destructive")
                {
                    action.Foreground = new SolidColorBrush(
                        Color.FromArgb(0xFF, 0xC4, 0x2B, 0x1C));
                }
                action.Click += (_, _) =>
                {
                    if (buttonHandled || !ReferenceEquals(node.Hosted, dialog)) return;
                    buttonHandled = true;
                    // Normative order: select FIRST, then the dismissal change.
                    Ipc.Event(node.Id, "select", new JsonObject { ["value"] = spec.Id });
                    node.UserEdit(JsonValue.Create(false));
                    dialog.Hide();
                };
                actions.Children.Add(action);
            }
            if (actions.Children.Count > 0) body.Children.Add(actions);
            dialog.Content = body;
            node.Hosted = dialog;
            _openAlerts.Add(node.Id);
            try
            {
                await dialog.ShowAsync();
            }
            catch (Exception ex)
            {
                Ipc.Log($"Alert {node.Id}: ShowAsync failed: {ex.Message}");
                _alertClosingRemote.Remove(node.Id);
                if (IsCurrentAlert(node) && (Json.Bool(node.Props, "value") ?? false))
                {
                    node.UserEdit(JsonValue.Create(false));
                }
                return;
            }
            finally
            {
                _openAlerts.Remove(node.Id);
                if (ReferenceEquals(node.Hosted, dialog)) node.Hosted = null;
            }

            // Remote close (value -> false, or teardown): no user action to report.
            if (_alertClosingRemote.Remove(node.Id))
            {
                retryAfterRelease =
                    IsCurrentAlert(node) && (Json.Bool(node.Props, "value") ?? false);
                return;
            }
            if (buttonHandled || !IsCurrentAlert(node)) return;

            // Close button, Escape, or system back selects the first cancel-role
            // action, matching the native alert convention.
            if (cancelId is not null)
            {
                Ipc.Event(node.Id, "select", new JsonObject { ["value"] = cancelId });
            }
            node.UserEdit(JsonValue.Create(false));
        }
        finally
        {
            _contentDialogGate.Release();
            _alertPresentationCount = Math.Max(0, _alertPresentationCount - 1);

            if (retryAfterRelease && IsCurrentAlert(node))
            {
                RequestAlert(node);
            }
            else if (retryOnDispatcher)
            {
                RootStack.DispatcherQueue.TryEnqueue(
                    DispatcherQueuePriority.Low,
                    () =>
                    {
                        if (IsCurrentAlert(node)
                            && (Json.Bool(node.Props, "value") ?? false))
                        {
                            RequestAlert(node);
                        }
                    });
            }

            if (!retryOnDispatcher && _alertPresentationCount == 0)
            {
                ResumePresentedSheets();
            }
        }
    }

    private bool IsCurrentAlert(NatuiNode node) =>
        _alertNodes.TryGetValue(node.Id, out var current)
        && ReferenceEquals(current, node);

    // -- Popover ------------------------------------------------------------------

    private FrameworkElement BuildPopover(NatuiNode node)
    {
        // Ordinary children render inline as the anchor (this stack); the
        // single PopoverContent child becomes the flyout's content (see
        // AttachToSlottedParent).
        var anchor = new NatuiStack { Orientation = Orientation.Vertical, CrossAlignment = "leading" };
        var flyout = new Flyout();
        flyout.Closed += (_, _) =>
        {
            if (_popoverClosingRemote.Remove(node.Id)) return;
            if (_applyingRemote > 0) return;
            if (!(Json.Bool(node.Props, "value") ?? false)) return;
            // Light-dismiss (click-outside / Esc): an optimistic user edit.
            node.UserEdit(JsonValue.Create(false));
        };
        node.Hosted = flyout;
        return anchor;
    }

    private void ApplyPopoverProps(NatuiNode node)
    {
        if (node.Hosted is not Flyout flyout) return;
        flyout.Placement = node.Str("arrowEdge") switch
        {
            "top" => FlyoutPlacementMode.Top,
            "leading" => FlyoutPlacementMode.Left,
            "trailing" => FlyoutPlacementMode.Right,
            _ => FlyoutPlacementMode.Bottom,
        };
        var presented = Json.Bool(node.Props, "value") ?? false;
        if (presented && !flyout.IsOpen)
        {
            if (node.Element is { } anchor)
            {
                try
                {
                    flyout.ShowAt(anchor);
                }
                catch (Exception ex)
                {
                    // ShowAt needs the anchor in the visual tree; a popover
                    // presented in its very first commit can beat the attach.
                    Ipc.Log($"Popover {node.Id}: ShowAt failed: {ex.Message}");
                }
            }
        }
        else if (!presented && flyout.IsOpen)
        {
            _popoverClosingRemote.Add(node.Id);
            flyout.Hide();
        }
    }

    private bool AttachPopoverContent(NatuiNode parent, NatuiNode child)
    {
        // Only the PopoverContent slot is special; ordinary children fall
        // through (return false) and attach into the anchor stack.
        if (child.Kind != "PopoverContent") return false;
        if (parent.Hosted is not Flyout flyout) return false;
        if (flyout.Content is not null)
        {
            Ipc.Log($"Popover {parent.Id}: extra PopoverContent {child.Id} ignored");
            return true;
        }
        flyout.Content = EnsureElement(child);
        return true;
    }

    private bool DetachPopoverContent(NatuiNode parent, NatuiNode child)
    {
        if (child.Kind != "PopoverContent") return false;
        if (parent.Hosted is Flyout flyout && ReferenceEquals(flyout.Content, child.Element))
        {
            flyout.Content = null;
        }
        return true;
    }
}
