using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace NatuiHost;

/// <summary>
/// Presentation kinds: Sheet (in-tree scrim + card overlay), Alert
/// (ContentDialog), Popover (Flyout on the anchor). All three are controlled
/// by the boolean "value" (presented); hosts only ever set it to false.
/// </summary>
internal sealed partial class NodeMapper
{
    /// <summary>
    /// Ids whose dialog/flyout is being closed by a remote update (value ->
    /// false) or teardown, so the native Closed callback must not emit a
    /// duplicate change event.
    /// </summary>
    private readonly HashSet<int> _alertClosingRemote = [];
    private readonly HashSet<int> _popoverClosingRemote = [];

    // -- Sheet --------------------------------------------------------------------

    private FrameworkElement BuildSheet(NatuiNode node)
    {
        // Children mount into the card's content stack via _contentSurface;
        // the in-tree element is a collapsed placeholder. Unlike macOS
        // (separate NSWindow), this overlay lives in the visual tree, so it
        // IS captured by RenderTargetBitmap screenshots.
        var content = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            CrossAlignment = "leading",
            Spacing = 8,
        };
        _contentSurface[node.Id] = content;
        var card = new Border
        {
            Background = CardBackground(),
            CornerRadius = new CornerRadius(8),
            MaxWidth = 560,
            Padding = new Thickness(20),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Child = content,
        };
        var scrim = new Grid
        {
            Background = new SolidColorBrush(Color.FromArgb(0x66, 0x00, 0x00, 0x00)),
        };
        scrim.Children.Add(card);
        scrim.Tapped += (_, e) =>
        {
            // Only a click on the scrim itself dismisses, not one on (or
            // bubbled through) the card.
            if (!ReferenceEquals(e.OriginalSource, scrim)) return;
            if (_applyingRemote > 0) return;
            if (!(Json.Bool(node.Props, "value") ?? false)) return;
            node.UserEdit(JsonValue.Create(false));
        };
        node.Hosted = scrim;
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplySheetProps(NatuiNode node)
    {
        if (node.Hosted is not UIElement overlay) return;
        var presented = Json.Bool(node.Props, "value") ?? false;
        var attached = OverlayLayer.Children.Contains(overlay);
        if (presented && !attached) OverlayLayer.Children.Add(overlay);
        else if (!presented && attached) OverlayLayer.Children.Remove(overlay);
    }

    private static Brush CardBackground()
    {
        try
        {
            if (Application.Current.Resources["ApplicationPageBackgroundThemeBrush"] is Brush brush)
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

        var dialog = new ContentDialog
        {
            Title = node.Str("title") ?? "",
            Content = node.Str("message") ?? "",
            XamlRoot = xamlRoot,
        };
        // ContentDialog offers exactly primary/secondary/close: the cancel
        // role maps to the close button (Esc), the first two non-cancel
        // buttons to primary/secondary, extras are dropped with a warning.
        string? cancelId = null;
        string? primaryId = null;
        string? secondaryId = null;
        foreach (var entry in Json.Arr(node.Props, "buttons") ?? [])
        {
            if (entry is not JsonObject button) continue;
            var id = Json.Str(button, "id") ?? "";
            var label = Json.Str(button, "label") ?? "";
            if (Json.Str(button, "role") == "cancel")
            {
                if (cancelId is null)
                {
                    cancelId = id;
                    dialog.CloseButtonText = label;
                }
                else
                {
                    Ipc.Log($"Alert {node.Id}: extra cancel button '{id}' dropped");
                }
            }
            else if (primaryId is null)
            {
                primaryId = id;
                dialog.PrimaryButtonText = label;
            }
            else if (secondaryId is null)
            {
                secondaryId = id;
                dialog.SecondaryButtonText = label;
            }
            else
            {
                Ipc.Log($"Alert {node.Id}: more than two non-cancel buttons; '{id}' dropped");
            }
        }
        if (primaryId is not null) dialog.DefaultButton = ContentDialogButton.Primary;

        node.Hosted = dialog;
        ContentDialogResult result;
        try
        {
            result = await dialog.ShowAsync();
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

        var selectedId = result switch
        {
            ContentDialogResult.Primary => primaryId,
            ContentDialogResult.Secondary => secondaryId,
            // Esc / close button: the cancel-role id, which may be absent.
            _ => cancelId,
        };
        // Normative order: select FIRST, then the dismissal change.
        if (selectedId is not null)
        {
            Ipc.Event(node.Id, "select", new JsonObject { ["value"] = selectedId });
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
