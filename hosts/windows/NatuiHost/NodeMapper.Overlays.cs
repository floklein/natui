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
    /// Ids whose dialog/flyout is being closed by a remote update (value ->
    /// false) or teardown, so the native close callback must not emit a
    /// duplicate change event.
    /// </summary>
    private readonly HashSet<int> _openSheets = [];
    private readonly HashSet<int> _sheetClosingRemote = [];
    private readonly HashSet<int> _alertClosingRemote = [];
    private readonly HashSet<int> _popoverClosingRemote = [];

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
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplySheetProps(NatuiNode node)
    {
        if (node.Hosted is not ContentDialog dialog) return;
        var presented = Json.Bool(node.Props, "value") ?? false;
        if (presented)
        {
            if (!_openSheets.Contains(node.Id)) _ = ShowSheetAsync(node, dialog);
        }
        else if (_openSheets.Contains(node.Id))
        {
            _sheetClosingRemote.Add(node.Id);
            dialog.Hide();
        }
    }

    private async Task ShowSheetAsync(NatuiNode node, ContentDialog dialog)
    {
        if (!(Json.Bool(node.Props, "value") ?? false) || _openSheets.Contains(node.Id)) return;
        if (RootStack.XamlRoot is not { } xamlRoot)
        {
            RootStack.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
            {
                if ((Json.Bool(node.Props, "value") ?? false)
                    && node.Hosted is ContentDialog current
                    && !_openSheets.Contains(node.Id))
                {
                    _ = ShowSheetAsync(node, current);
                }
            });
            return;
        }

        dialog.XamlRoot = xamlRoot;
        _openSheets.Add(node.Id);
        try
        {
            await dialog.ShowAsync();
        }
        catch (Exception ex)
        {
            Ipc.Log($"Sheet {node.Id}: ShowAsync failed: {ex.Message}");
            _openSheets.Remove(node.Id);
            _sheetClosingRemote.Remove(node.Id);
            return;
        }
        _openSheets.Remove(node.Id);
        if (_sheetClosingRemote.Remove(node.Id)) return;
        if (ReferenceEquals(node.Hosted, dialog)
            && (Json.Bool(node.Props, "value") ?? false))
        {
            node.UserEdit(JsonValue.Create(false));
        }
    }

    // -- Alert --------------------------------------------------------------------

    private FrameworkElement BuildAlert(NatuiNode node) =>
        // Fully data-driven: children are ignored, the dialog is built from
        // props in ShowAlertAsync when value flips true.
        new Border { Visibility = Visibility.Collapsed };

    private void ApplyAlertProps(NatuiNode node)
    {
        var presented = Json.Bool(node.Props, "value") ?? false;
        if (presented)
        {
            if (node.Hosted is null) _ = ShowAlertAsync(node);
        }
        else if (node.Hosted is ContentDialog dialog)
        {
            _alertClosingRemote.Add(node.Id);
            dialog.Hide();
        }
    }

    private async Task ShowAlertAsync(NatuiNode node)
    {
        if (RootStack.XamlRoot is not { } xamlRoot)
        {
            // The very first commit can arrive before the window content is
            // loaded; retry on a later dispatcher pass, only while still
            // presented (low priority so a degenerate loop cannot starve UI).
            RootStack.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
            {
                if ((Json.Bool(node.Props, "value") ?? false) && node.Hosted is null)
                {
                    _ = ShowAlertAsync(node);
                }
            });
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
            Orientation = customSpecs.Count <= 2 ? Orientation.Horizontal : Orientation.Vertical,
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
        try
        {
            await dialog.ShowAsync();
        }
        catch (Exception ex)
        {
            Ipc.Log($"Alert {node.Id}: ShowAsync failed: {ex.Message}");
            node.Hosted = null;
            _alertClosingRemote.Remove(node.Id);
            return;
        }
        node.Hosted = null;
        // Remote close (value -> false, or teardown): no user action to report.
        if (_alertClosingRemote.Remove(node.Id)) return;
        if (buttonHandled) return;
        // Close button, Escape, or system back selects the first cancel-role
        // action, matching the native alert convention.
        if (cancelId is not null)
        {
            Ipc.Event(node.Id, "select", new JsonObject { ["value"] = cancelId });
        }
        node.UserEdit(JsonValue.Create(false));
    }

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
