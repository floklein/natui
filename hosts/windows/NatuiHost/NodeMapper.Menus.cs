using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Windows.UI;

namespace NatuiHost;

/// <summary>
/// Menu kinds: MenuBar (chrome row), Toolbar (CommandBar chrome row), Menu
/// (DropDownButton + MenuFlyout), ContextMenu (ContextFlyout on the child
/// stack), plus the shared MenuItemSpec-tree builder they all use.
/// </summary>
internal sealed partial class NodeMapper
{
    /// <summary>
    /// Menu/ContextMenu nodes whose spec changed while their flyout was open:
    /// rebuilt on Closed instead, so the open menu is never torn down under
    /// the pointer.
    /// </summary>
    private readonly HashSet<int> _menuRebuildPending = [];

    /// <summary>
    /// Visual identity sequence from the last Toolbar update. When it is
    /// unchanged, patch controls in place so host-local search text and focus
    /// survive ordinary prop echoes.
    /// </summary>
    private readonly Dictionary<int, List<string>> _toolbarLayouts = [];

    // -- MenuBar ------------------------------------------------------------------

    private FrameworkElement BuildMenuBar(NatuiNode node)
    {
        // Hosted chrome: a real WinUI MenuBar in the window's chrome row,
        // always above the Toolbar. The in-tree element is a collapsed
        // placeholder so attach/detach index math is untouched (the shell
        // stays visible-but-empty; ApplyCommonProps controls the shell).
        var bar = new MenuBar();
        node.Hosted = bar;
        ChromePanel.Children.Insert(0, bar);
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplyMenuBarProps(NatuiNode node)
    {
        if (node.Hosted is not MenuBar bar) return;
        // Wholesale rebuild; NodeStore already skips structurally equal props,
        // which is what keeps an open menu alive across unrelated commits.
        bar.Items.Clear();
        foreach (var entry in Json.Arr(node.Props, "menus") ?? [])
        {
            if (entry is not JsonObject menu) continue;
            var barItem = new MenuBarItem { Title = Json.Str(menu, "label") ?? "" };
            FillMenuItems(barItem.Items, node, Json.Arr(menu, "items"), "select");
            bar.Items.Add(barItem);
        }
    }

    // -- Toolbar ------------------------------------------------------------------

    private FrameworkElement BuildToolbar(NatuiNode node)
    {
        var bar = new CommandBar
        {
            DefaultLabelPosition = CommandBarDefaultLabelPosition.Right,
            IsOpen = false,
        };
        node.Hosted = bar;
        ChromePanel.Children.Add(bar);
        return new Border { Visibility = Visibility.Collapsed };
    }

    private void ApplyToolbarProps(NatuiNode node)
    {
        if (node.Hosted is not CommandBar bar) return;
        var items = Json.Arr(node.Props, "items") ?? [];
        var layout = ToolbarLayout(items);
        if (_toolbarLayouts.TryGetValue(node.Id, out var previous)
            && previous.SequenceEqual(layout))
        {
            PatchToolbarItems(bar, node, items);
            return;
        }

        // Preserve uncontrolled search fields across structural changes when
        // their ids survive. Reusing the same AutoSuggestBox keeps its text,
        // and focus is explicitly restored after reparenting.
        var (searches, focusedSearch) = TakeToolbarSearches(bar);
        bar.PrimaryCommands.Clear();
        var left = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 4,
            VerticalAlignment = VerticalAlignment.Center,
        };
        bar.Content = left;
        var afterFlexibleSpace = false;
        var visualIndex = 0;
        foreach (var entry in items)
        {
            if (entry is not JsonObject item) continue;
            var type = Json.Str(item, "type");
            if (type == "flexibleSpace")
            {
                afterFlexibleSpace = true;
                continue;
            }
            var key = ToolbarVisualKey(item, afterFlexibleSpace, visualIndex++);
            switch (type)
            {
                case "spacer":
                    if (afterFlexibleSpace) bar.PrimaryCommands.Add(new AppBarSeparator());
                    else left.Children.Add(new AppBarSeparator());
                    break;
                case "search":
                {
                    var id = Json.Str(item, "id") ?? "";
                    var search = searches.Remove(id, out var existing)
                        ? existing
                        : BuildToolbarSearch(node, item);
                    search.Tag = key;
                    search.DataContext = id;
                    ApplyToolbarSearch(search, item);
                    if (afterFlexibleSpace)
                    {
                        bar.PrimaryCommands.Add(new AppBarElementContainer
                        {
                            Content = search,
                            IsCompact = false,
                            Tag = key,
                        });
                    }
                    else
                    {
                        left.Children.Add(search);
                    }
                    break;
                }
                case "button":
                {
                    var button = BuildToolbarButton(node, item);
                    button.Tag = key;
                    if (afterFlexibleSpace) bar.PrimaryCommands.Add(button);
                    else left.Children.Add(button);
                    break;
                }
                case "toggle":
                {
                    var toggle = BuildToolbarToggle(node, item);
                    toggle.Tag = key;
                    if (afterFlexibleSpace) bar.PrimaryCommands.Add(toggle);
                    else left.Children.Add(toggle);
                    break;
                }
                case "menu":
                {
                    var menu = BuildToolbarMenu(node, item);
                    menu.Tag = key;
                    if (afterFlexibleSpace) bar.PrimaryCommands.Add(menu);
                    else left.Children.Add(menu);
                    break;
                }
            }
        }
        _toolbarLayouts[node.Id] = layout;
        // A value left in the dictionary was not reinserted.
        if (focusedSearch is not null && !searches.Values.Contains(focusedSearch))
            focusedSearch.Focus(FocusState.Programmatic);
    }

    private static List<string> ToolbarLayout(JsonArray items)
    {
        var result = new List<string>();
        var right = false;
        var visualIndex = 0;
        foreach (var entry in items)
        {
            if (entry is not JsonObject item) continue;
            if (Json.Str(item, "type") == "flexibleSpace")
            {
                right = true;
                continue;
            }
            result.Add(ToolbarVisualKey(item, right, visualIndex++));
        }
        return result;
    }

    private static string ToolbarVisualKey(JsonObject item, bool right, int index) =>
        $"{(right ? "right" : "left")}:{Json.Str(item, "type")}:{Json.Str(item, "id") ?? index.ToString()}";

    private void PatchToolbarItems(
        CommandBar bar, NatuiNode node, JsonArray items)
    {
        if (bar.Content is not StackPanel left) return;
        var leftIndex = 0;
        var rightIndex = 0;
        var afterFlexibleSpace = false;
        foreach (var entry in items)
        {
            if (entry is not JsonObject item) continue;
            var type = Json.Str(item, "type");
            if (type == "flexibleSpace")
            {
                afterFlexibleSpace = true;
                continue;
            }
            FrameworkElement? element;
            if (afterFlexibleSpace)
            {
                if (rightIndex >= bar.PrimaryCommands.Count) return;
                element = bar.PrimaryCommands[rightIndex++] as FrameworkElement;
                if (element is AppBarElementContainer container)
                {
                    element = container.Content as FrameworkElement;
                }
            }
            else
            {
                if (leftIndex >= left.Children.Count) return;
                element = left.Children[leftIndex++] as FrameworkElement;
            }
            switch (type)
            {
                case "button" when element is AppBarButton button:
                    ApplyToolbarButton(button, item);
                    break;
                case "toggle" when element is AppBarToggleButton toggle:
                    ApplyToolbarToggle(toggle, item);
                    break;
                case "menu" when element is AppBarButton menu:
                    ApplyToolbarMenu(menu, node, item);
                    break;
                case "search" when element is AutoSuggestBox search:
                    ApplyToolbarSearch(search, item);
                    break;
            }
        }
    }

    private static (Dictionary<string, AutoSuggestBox> Searches, AutoSuggestBox? Focused)
        TakeToolbarSearches(CommandBar bar)
    {
        var searches = new Dictionary<string, AutoSuggestBox>(StringComparer.Ordinal);
        AutoSuggestBox? focused = null;
        if (bar.Content is StackPanel left)
        {
            foreach (var box in left.Children.OfType<AutoSuggestBox>().ToList())
            {
                if (box.DataContext is string id) searches[id] = box;
                if (box.FocusState != FocusState.Unfocused) focused = box;
                left.Children.Remove(box);
            }
        }
        foreach (var container in bar.PrimaryCommands.OfType<AppBarElementContainer>().ToList())
        {
            if (container.Content is not AutoSuggestBox box) continue;
            if (box.DataContext is string id) searches[id] = box;
            if (box.FocusState != FocusState.Unfocused) focused = box;
            container.Content = null;
        }
        return (searches, focused);
    }

    private static AppBarButton BuildToolbarButton(NatuiNode owner, JsonObject item)
    {
        var button = new AppBarButton();
        ApplyToolbarButton(button, item);
        var id = Json.Str(item, "id") ?? "";
        button.Click += (_, _) =>
            Ipc.Event(owner.Id, "action", new JsonObject { ["value"] = id });
        return button;
    }

    private static void ApplyToolbarButton(AppBarButton button, JsonObject item)
    {
        button.Label = Json.Str(item, "label") ?? "";
        button.IsEnabled = !(Json.Bool(item, "disabled") ?? false);
        button.Icon = Json.Str(item, "systemImage") is { } icon
            ? new FontIcon { FontFamily = IconFontFamily(), Glyph = GlyphFor(icon) }
            : null;
    }

    private static AppBarToggleButton BuildToolbarToggle(NatuiNode owner, JsonObject item)
    {
        var toggle = new AppBarToggleButton();
        ApplyToolbarToggle(toggle, item);
        var id = Json.Str(item, "id") ?? "";
        toggle.Click += (_, _) =>
        {
            // The pressed state is prop-driven ('on' in the spec), never
            // optimistic: reassert the spec state, then let the app's action
            // handler echo the new 'on'. DataContext carries the latest
            // patched prop so an in-place update never reasserts stale state.
            toggle.IsChecked = toggle.DataContext as bool? ?? false;
            Ipc.Event(owner.Id, "action", new JsonObject { ["value"] = id });
        };
        return toggle;
    }

    private static void ApplyToolbarToggle(AppBarToggleButton toggle, JsonObject item)
    {
        var on = Json.Bool(item, "on") ?? false;
        toggle.Label = Json.Str(item, "label") ?? "";
        toggle.IsChecked = on;
        toggle.IsEnabled = !(Json.Bool(item, "disabled") ?? false);
        toggle.DataContext = on;
        toggle.Icon = Json.Str(item, "systemImage") is { } icon
            ? new FontIcon { FontFamily = IconFontFamily(), Glyph = GlyphFor(icon) }
            : null;
    }

    private AppBarButton BuildToolbarMenu(NatuiNode owner, JsonObject item)
    {
        var button = new AppBarButton();
        ApplyToolbarMenu(button, owner, item);
        return button;
    }

    private void ApplyToolbarMenu(AppBarButton button, NatuiNode owner, JsonObject item)
    {
        ApplyToolbarButton(button, item);
        var flyout = new MenuFlyout();
        FillMenuItems(flyout.Items, owner, Json.Arr(item, "items"), "action");
        // AppBarButton derives from Button, so Flyout exists and opens on tap.
        button.Flyout = flyout;
    }

    private static AutoSuggestBox BuildToolbarSearch(NatuiNode owner, JsonObject item)
    {
        var box = new AutoSuggestBox
        {
            QueryIcon = new SymbolIcon(Symbol.Find),
            Width = 180,
            VerticalAlignment = VerticalAlignment.Center,
        };
        ApplyToolbarSearch(box, item);
        // Uncontrolled on the wire: fire-and-forget search events, and the
        // text is never echoed back into the spec (avoids focus races).
        box.TextChanged += (_, args) =>
        {
            if (args.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
            Ipc.Event(owner.Id, "search", new JsonObject { ["value"] = box.Text });
        };
        box.QuerySubmitted += (_, _) =>
            Ipc.Event(owner.Id, "search", new JsonObject { ["value"] = box.Text });
        return box;
    }

    private static void ApplyToolbarSearch(AutoSuggestBox box, JsonObject item) =>
        box.PlaceholderText = Json.Str(item, "placeholder") ?? "";

    // -- Menu ---------------------------------------------------------------------

    private DropDownButton BuildMenu(NatuiNode node)
    {
        var button = new DropDownButton();
        var flyout = new MenuFlyout();
        flyout.Closed += (_, _) =>
        {
            if (_menuRebuildPending.Remove(node.Id)) RebuildMenuItems(flyout, node, "select");
        };
        button.Flyout = flyout;
        // Menu is not a LabelKind, so #text children never trigger
        // RefreshLabel; Loaded fires after the initial commit attached them.
        button.Loaded += (_, _) => RefreshMenuLabel(node, button);
        return button;
    }

    private void ApplyMenuProps(NatuiNode node, DropDownButton button)
    {
        if (button.Flyout is MenuFlyout flyout)
        {
            if (flyout.IsOpen) _menuRebuildPending.Add(node.Id);
            else RebuildMenuItems(flyout, node, "select");
        }
        RefreshMenuLabel(node, button);
    }

    private static void RefreshMenuLabel(NatuiNode node, DropDownButton button)
    {
        // Text label from #text children; icon-only menus fall back to
        // systemImage. Element children inside a Menu label are not supported
        // on Windows (documented divergence).
        var text = node.JoinedText();
        if (text.Length == 0 && node.Str("systemImage") is { } icon)
        {
            button.Content = new FontIcon { FontFamily = IconFontFamily(), Glyph = GlyphFor(icon) };
        }
        else if (node.Children.All(c => c.Kind == "#text"))
        {
            button.Content = text;
        }
    }

    // -- ContextMenu --------------------------------------------------------------

    private FrameworkElement BuildContextMenu(NatuiNode node)
    {
        // Ordinary children (the right-click target) attach into this stack
        // via the generic ParentSurface path.
        var stack = new NatuiStack { Orientation = Orientation.Vertical, CrossAlignment = "leading" };
        var flyout = new MenuFlyout();
        flyout.Closed += (_, _) =>
        {
            if (_menuRebuildPending.Remove(node.Id)) RebuildMenuItems(flyout, node, "select");
        };
        stack.ContextFlyout = flyout;
        return stack;
    }

    private void ApplyContextMenuProps(NatuiNode node, FrameworkElement element)
    {
        if (element.ContextFlyout is not MenuFlyout flyout) return;
        if (flyout.IsOpen) _menuRebuildPending.Add(node.Id);
        else RebuildMenuItems(flyout, node, "select");
    }

    // -- shared MenuItemSpec tree -------------------------------------------------

    private void RebuildMenuItems(MenuFlyout flyout, NatuiNode node, string eventName)
    {
        flyout.Items.Clear();
        FillMenuItems(flyout.Items, node, Json.Arr(node.Props, "items"), eventName);
    }

    /// <summary>
    /// Recursively builds MenuFlyout items from a MenuItemSpec array. Leaf
    /// clicks emit <paramref name="eventName"/> with the item id; command
    /// roles map to native behavior and never emit (protocol).
    /// </summary>
    private void FillMenuItems(
        IList<MenuFlyoutItemBase> target, NatuiNode owner, JsonArray? items, string eventName)
    {
        if (items is null) return;
        foreach (var entry in items)
        {
            if (entry is not JsonObject item) continue;
            if (Json.Bool(item, "divider") == true)
            {
                target.Add(new MenuFlyoutSeparator());
                continue;
            }

            var label = Json.Str(item, "label") ?? "";
            var disabled = Json.Bool(item, "disabled") ?? false;
            var icon = Json.Str(item, "systemImage");

            if (Json.Arr(item, "children") is { } children)
            {
                var sub = new MenuFlyoutSubItem { Text = label, IsEnabled = !disabled };
                if (icon is not null)
                {
                    sub.Icon = new FontIcon { FontFamily = IconFontFamily(), Glyph = GlyphFor(icon) };
                }
                FillMenuItems(sub.Items, owner, children, eventName);
                target.Add(sub);
                continue;
            }

            var id = Json.Str(item, "id") ?? "";
            var role = Json.Str(item, "role");

            MenuFlyoutItem flyoutItem;
            if (item.ContainsKey("checked"))
            {
                var isChecked = Json.Bool(item, "checked") ?? false;
                var toggleItem = new ToggleMenuFlyoutItem { IsChecked = isChecked };
                // ToggleMenuFlyoutItem flips itself on invoke; checked is
                // prop-driven, so reassert the spec state before emitting.
                toggleItem.Click += (_, _) => toggleItem.IsChecked = isChecked;
                flyoutItem = toggleItem;
            }
            else
            {
                flyoutItem = new MenuFlyoutItem();
            }
            flyoutItem.Text = label;
            flyoutItem.IsEnabled = !disabled;
            if (icon is not null)
            {
                flyoutItem.Icon = new FontIcon { FontFamily = IconFontFamily(), Glyph = GlyphFor(icon) };
            }
            if (ParseShortcut(Json.Str(item, "shortcut")) is { } accelerator)
            {
                flyoutItem.KeyboardAccelerators.Add(accelerator);
            }

            switch (role)
            {
                case "quit":
                    // Native Quit must take the same path as a window close:
                    // React unmounts and acknowledges with `quit` before the
                    // V8 engine and WinUI application are torn down.
                    flyoutItem.Click += (_, _) => requestQuit();
                    break;
                case "cut" or "copy" or "paste" or "selectAll" or "undo" or "redo":
                {
                    var editRole = role;
                    flyoutItem.Click += (_, _) => InvokeEditRole(editRole);
                    break;
                }
                case "about":
                    // Plain no-op item; there is no standard about box to open.
                    break;
                default:
                    if (role == "destructive")
                    {
                        // Styling only (the system critical red); still emits.
                        flyoutItem.Foreground =
                            new SolidColorBrush(Color.FromArgb(0xFF, 0xC4, 0x2B, 0x1C));
                    }
                    flyoutItem.Click += (_, _) =>
                        Ipc.Event(owner.Id, eventName, new JsonObject { ["value"] = id });
                    break;
            }
            target.Add(flyoutItem);
        }
    }

    /// <summary>
    /// Best-effort clipboard commands on the focused text box, the Windows
    /// analogue of the macOS responder-chain selectors.
    /// </summary>
    private void InvokeEditRole(string role)
    {
        if (RootStack.XamlRoot is not { } xamlRoot) return;
        if (FocusManager.GetFocusedElement(xamlRoot) is not TextBox box) return;
        switch (role)
        {
            case "cut":
                box.CutSelectionToClipboard();
                break;
            case "copy":
                box.CopySelectionToClipboard();
                break;
            case "paste":
                box.PasteFromClipboard();
                break;
            case "selectAll":
                box.SelectAll();
                break;
            case "undo":
                if (box.CanUndo) box.Undo();
                break;
            case "redo":
                if (box.CanRedo) box.Redo();
                break;
        }
    }

    /// <summary>
    /// "cmd+shift+s" style shortcuts to a KeyboardAccelerator. cmd and ctrl
    /// both map to Control on Windows; unparseable shortcuts are skipped.
    /// </summary>
    private static KeyboardAccelerator? ParseShortcut(string? shortcut)
    {
        if (string.IsNullOrWhiteSpace(shortcut)) return null;
        var modifiers = VirtualKeyModifiers.None;
        VirtualKey? key = null;
        foreach (var raw in shortcut.Split('+'))
        {
            var token = raw.Trim().ToLowerInvariant();
            if (token is "cmd" or "ctrl") modifiers |= VirtualKeyModifiers.Control;
            else if (token == "shift") modifiers |= VirtualKeyModifiers.Shift;
            else if (token == "alt") modifiers |= VirtualKeyModifiers.Menu;
            else if (token.Length == 1)
            {
                var c = token[0];
                if (c is >= 'a' and <= 'z') key = VirtualKey.A + (c - 'a');
                else if (c is >= '0' and <= '9') key = VirtualKey.Number0 + (c - '0');
            }
        }
        if (key is not { } k) return null;
        return new KeyboardAccelerator { Key = k, Modifiers = modifiers };
    }
}
