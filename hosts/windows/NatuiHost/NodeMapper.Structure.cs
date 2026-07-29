using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace NatuiHost;

/// <summary>
/// A list-row presentation shell that keeps arbitrary NatUI content in the
/// leading column and renders the common badge prop at the trailing edge.
/// Section rows also use this shell for controlled selection highlighting.
/// </summary>
internal sealed class NatuiListRow : ContentControl
{
    private readonly Grid _layout = new();
    private readonly FrameworkElement _content;
    private readonly Border _badge;
    private readonly TextBlock _badgeText;

    public NatuiNode Node { get; }

    public NatuiListRow(NatuiNode node, FrameworkElement content)
    {
        Node = node;
        Tag = node;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        IsTabStop = node.Parent?.Kind == "Section";
        _layout.ColumnDefinitions.Add(
            new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _layout.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _layout.ColumnSpacing = 8;
        Content = _layout;

        _content = content;
        _content.HorizontalAlignment = HorizontalAlignment.Stretch;
        Grid.SetColumn(_content, 0);
        _layout.Children.Add(_content);

        _badgeText = new TextBlock
        {
            FontSize = 11,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            VerticalAlignment = VerticalAlignment.Center,
        };
        _badge = new Border
        {
            Background = ResourceBrush(
                "AccentFillColorDefaultBrush",
                new SolidColorBrush(Microsoft.UI.Colors.DodgerBlue)),
            CornerRadius = new CornerRadius(9),
            Padding = new Thickness(6, 1, 6, 1),
            Child = _badgeText,
            VerticalAlignment = VerticalAlignment.Center,
            Visibility = Visibility.Collapsed,
        };
        Grid.SetColumn(_badge, 1);
        _layout.Children.Add(_badge);
    }

    public void UpdateBadge(string? text)
    {
        _badgeText.Text = text ?? "";
        _badge.Visibility = text is null ? Visibility.Collapsed : Visibility.Visible;
    }

    public void SetSectionSelected(bool selected)
    {
        Background = selected
            ? ResourceBrush(
                "AccentFillColorSecondaryBrush",
                new SolidColorBrush(Windows.UI.Color.FromArgb(0x33, 0x00, 0x78, 0xD4)))
            : null;
    }

    public void ReleaseContent() => _layout.Children.Remove(_content);

    private static Brush ResourceBrush(string key, Brush fallback) =>
        Theme.Resource<Brush>(key) ?? fallback;
}

/// <summary>
/// WinUI SplitView plus a persistent native sidebar-toggle button. SplitView
/// deliberately has no built-in toggle, so the wrapper reserves a small
/// header row in both columns and keeps the affordance in the detail header.
/// </summary>
internal sealed class NatuiSplitView : Grid
{
    public SplitView NativeSplit { get; } = new()
    {
        DisplayMode = SplitViewDisplayMode.Inline,
        IsPaneOpen = true,
    };

    public Grid SidebarHost { get; } = new();
    public Grid DetailHost { get; } = new();
    public Button ToggleButton { get; } = new()
    {
        Width = 36,
        Height = 36,
        Padding = new Thickness(0),
        Margin = new Thickness(4, 2, 4, 2),
        HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Center,
        Content = new FontIcon { Glyph = "\uE89F", FontSize = 16 },
    };

    public NatuiSplitView()
    {
        var sidebar = ColumnWithHeader(SidebarHost);
        var detail = ColumnWithHeader(DetailHost);
        Grid.SetRow(ToggleButton, 0);
        detail.Children.Add(ToggleButton);
        NativeSplit.Pane = sidebar;
        NativeSplit.Content = detail;
        Children.Add(NativeSplit);
    }

    private static Grid ColumnWithHeader(Grid content)
    {
        var column = new Grid();
        column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(content, 1);
        column.Children.Add(content);
        return column;
    }
}

/// <summary>
/// Structural kinds: SplitView (+ Sidebar/Detail slots), TabView/Tab, Section,
/// Table, DisclosureGroup, plus the slot-routing hooks and List selection.
/// </summary>
internal sealed partial class NodeMapper
{
    /// <summary>Header grid + row ListView per Table node id.</summary>
    private readonly Dictionary<int, (Grid Header, ListView List)> _tableParts = [];

    /// <summary>Presentation shells for direct List rows and Section rows.</summary>
    private readonly Dictionary<int, NatuiListRow> _listRows = [];

    // -- slot routing -------------------------------------------------------------

    /// <summary>
    /// Parents that place children by KIND rather than index: SplitView
    /// (Sidebar/Detail), TabView (Tab -> TabViewItem), Popover
    /// (PopoverContent -> Flyout content). Returns true when the child was
    /// consumed (including logged-and-swallowed strays).
    /// </summary>
    private bool AttachToSlottedParent(NatuiNode parent, NatuiNode child)
    {
        switch (parent.Kind)
        {
            case "SplitView":
            {
                if (parent.Inner is not NatuiSplitView splitView) return false;
                switch (child.Kind)
                {
                    case "Sidebar":
                        if (splitView.SidebarHost.Children.Count > 0)
                        {
                            Ipc.Log($"SplitView {parent.Id}: extra Sidebar {child.Id} ignored");
                            return true;
                        }
                        splitView.SidebarHost.Children.Add(EnsureElement(child));
                        return true;
                    case "Detail":
                        if (splitView.DetailHost.Children.Count > 0)
                        {
                            Ipc.Log($"SplitView {parent.Id}: extra Detail {child.Id} ignored");
                            return true;
                        }
                        splitView.DetailHost.Children.Add(EnsureElement(child));
                        return true;
                    default:
                        // Never render stray children inline; macOS ignores
                        // them too.
                        Ipc.Log($"SplitView {parent.Id}: child kind {child.Kind} ignored");
                        return true;
                }
            }
            case "TabView":
                return AttachTabChild(parent, child);
            case "Popover":
                return AttachPopoverContent(parent, child);
            default:
                return false;
        }
    }

    private bool DetachFromSlottedParent(NatuiNode parent, NatuiNode child)
    {
        switch (parent.Kind)
        {
            case "SplitView":
            {
                if (parent.Inner is not NatuiSplitView splitView) return false;
                switch (child.Kind)
                {
                    case "Sidebar":
                        if (child.Element is { } sidebar
                            && splitView.SidebarHost.Children.Contains(sidebar))
                        {
                            splitView.SidebarHost.Children.Remove(sidebar);
                        }
                        return true;
                    case "Detail":
                        if (child.Element is { } detail
                            && splitView.DetailHost.Children.Contains(detail))
                        {
                            splitView.DetailHost.Children.Remove(detail);
                        }
                        return true;
                    default:
                        return true;
                }
            }
            case "TabView":
                return DetachTabChild(parent, child);
            case "Popover":
                return DetachPopoverContent(parent, child);
            default:
                return false;
        }
    }

    /// <summary>Sidebar/Detail/PopoverContent/Tab: a plain vertical surface.</summary>
    private static NatuiStack BuildSlotStack() => new()
    {
        Orientation = Orientation.Vertical,
        CrossAlignment = "leading",
    };

    // -- SplitView ----------------------------------------------------------------

    private NatuiSplitView BuildSplitView(NatuiNode node)
    {
        var splitView = new NatuiSplitView();
        splitView.ToggleButton.Click += (_, _) =>
            splitView.NativeSplit.IsPaneOpen = !splitView.NativeSplit.IsPaneOpen;
        splitView.NativeSplit.PaneOpened += (_, _) =>
            OnSplitViewVisibilityChanged(node, splitView);
        splitView.NativeSplit.PaneClosed += (_, _) =>
            OnSplitViewVisibilityChanged(node, splitView);
        return splitView;
    }

    private void ApplySplitViewProps(NatuiNode node, NatuiSplitView splitView)
    {
        splitView.NativeSplit.IsPaneOpen = node.Str("value") != "detailOnly";
        var width = node.Num("sidebarWidth") ?? 220;
        if (node.Num("minSidebarWidth") is { } minimum) width = Math.Max(width, minimum);
        if (node.Num("maxSidebarWidth") is { } maximum) width = Math.Min(width, maximum);
        splitView.NativeSplit.OpenPaneLength = Math.Max(0, width);
        SetSplitToggleLabel(splitView);
    }

    private void OnSplitViewVisibilityChanged(NatuiNode node, NatuiSplitView splitView)
    {
        if (_applyingRemote > 0) return;
        SetSplitToggleLabel(splitView);
        var visibility = splitView.NativeSplit.IsPaneOpen ? "all" : "detailOnly";
        if (visibility == (node.Str("value") ?? "all")) return;
        node.UserEdit(JsonValue.Create(visibility));
    }

    private static void SetSplitToggleLabel(NatuiSplitView splitView)
    {
        var label = splitView.NativeSplit.IsPaneOpen ? "Hide sidebar" : "Show sidebar";
        ToolTipService.SetToolTip(splitView.ToggleButton, label);
        AutomationProperties.SetName(splitView.ToggleButton, label);
    }

    // -- TabView / Tab ------------------------------------------------------------

    private TabView BuildTabView(NatuiNode node)
    {
        var tabView = new TabView
        {
            IsAddTabButtonVisible = false,
            CanReorderTabs = false,
            CanDragTabs = false,
        };
        tabView.SelectionChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            var id = ((tabView.SelectedItem as TabViewItem)?.Tag as NatuiNode)?.Str("id");
            if (id is null || id == (node.Str("value") ?? "")) return;
            node.UserEdit(JsonValue.Create(id));
        };
        return tabView;
    }

    private void ApplyTabViewProps(NatuiNode node, TabView tabView) =>
        SelectTabByValue(node, tabView);

    private void SelectTabByValue(NatuiNode node, TabView tabView)
    {
        var value = node.Str("value");
        foreach (var entry in tabView.TabItems)
        {
            if (entry is not TabViewItem item) continue;
            if ((item.Tag as NatuiNode)?.Str("id") != value) continue;
            if (!ReferenceEquals(tabView.SelectedItem, item)) tabView.SelectedItem = item;
            return;
        }
    }

    private bool AttachTabChild(NatuiNode parent, NatuiNode child)
    {
        if (parent.Inner is not TabView tabView) return false;
        if (child.Kind != "Tab")
        {
            Ipc.Log($"TabView {parent.Id}: child kind {child.Kind} ignored");
            return true;
        }
        var item = new TabViewItem
        {
            Content = EnsureElement(child),
            Tag = child,
        };
        child.Hosted = item;
        RefreshTabItem(child);
        // Insert at the child's index among its Tab siblings (the store has
        // already placed it in parent.Children).
        var index = 0;
        foreach (var sibling in parent.Children)
        {
            if (ReferenceEquals(sibling, child)) break;
            if (sibling.Kind == "Tab") index++;
        }
        // Inserting can auto-select (first item) or shift the selection;
        // guard, then reassert the JS-declared selected tab.
        _applyingRemote++;
        try
        {
            tabView.TabItems.Insert(Math.Min(index, tabView.TabItems.Count), item);
            SelectTabByValue(parent, tabView);
        }
        finally
        {
            _applyingRemote--;
        }
        return true;
    }

    private bool DetachTabChild(NatuiNode parent, NatuiNode child)
    {
        if (parent.Inner is not TabView tabView) return false;
        if (child.Kind != "Tab") return true;
        if (child.Hosted is TabViewItem item)
        {
            _applyingRemote++;
            try
            {
                tabView.TabItems.Remove(item);
            }
            finally
            {
                _applyingRemote--;
            }
            child.Hosted = null;
        }
        return true;
    }

    private void ApplyTabProps(NatuiNode node) => RefreshTabItem(node);

    private void RefreshTabItem(NatuiNode node)
    {
        if (node.Hosted is not TabViewItem item) return;
        var title = node.Str("title") ?? "";
        // TabViewItem has no badge affordance; fold it into the header text.
        item.Header = BadgeText(node) is { } badge ? $"{title} ({badge})" : title;
        item.IconSource = node.Str("systemImage") is { } icon
            ? new FontIconSource { Glyph = GlyphFor(icon) }
            : null;
    }

    /// <summary>The badge common prop: a string, or a number formatted as one.</summary>
    private static string? BadgeText(NatuiNode node)
    {
        if (node.Str("badge") is { } text) return text;
        if (node.Num("badge") is { } number)
        {
            return number == Math.Floor(number)
                ? ((long)number).ToString(CultureInfo.InvariantCulture)
                : number.ToString(CultureInfo.InvariantCulture);
        }
        return null;
    }

    private NatuiListRow CreateListRow(NatuiNode node, FrameworkElement content)
    {
        var row = new NatuiListRow(node, content);
        row.UpdateBadge(BadgeText(node));
        row.Tapped += (_, args) =>
        {
            if (!OnSectionListRowTapped(node)) return;
            args.Handled = true;
        };
        row.KeyDown += (_, args) =>
        {
            if (args.Key is not (Windows.System.VirtualKey.Enter or Windows.System.VirtualKey.Space)
                || !OnSectionListRowTapped(node))
            {
                return;
            }
            args.Handled = true;
        };
        _listRows[node.Id] = row;
        return row;
    }

    private NatuiListRow? ReleaseListRow(NatuiNode node)
    {
        if (!_listRows.Remove(node.Id, out var row)) return null;
        row.ReleaseContent();
        return row;
    }

    private void RefreshListRow(NatuiNode node)
    {
        if (_listRows.TryGetValue(node.Id, out var row)) row.UpdateBadge(BadgeText(node));
    }

    private static void SetSectionRowsInList(NatuiNode section, bool inList)
    {
        foreach (var row in section.Children)
        {
            row.InList = inList;
            SyncInnerAlignment(row);
        }
    }

    // -- Section ------------------------------------------------------------------

    private FrameworkElement BuildSection(NatuiNode node)
    {
        var header = new TextBlock
        {
            FontWeight = FontWeights.SemiBold,
            Visibility = Visibility.Collapsed,
        };
        var content = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            CrossAlignment = "leading",
            Spacing = 8,
        };
        _contentSurface[node.Id] = content;
        var footer = new TextBlock
        {
            FontSize = 12,
            Foreground = SecondaryTextBrush(),
            Visibility = Visibility.Collapsed,
        };
        var stack = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            CrossAlignment = "leading",
            Spacing = 4,
        };
        stack.Children.Add(header);
        stack.Children.Add(content);
        stack.Children.Add(footer);
        stack.RebuildLayout();
        return stack;
    }

    private void ApplySectionProps(NatuiNode node)
    {
        if (node.Inner is not NatuiStack stack || stack.Children.Count < 3) return;
        if (stack.Children[0] is TextBlock header) SetSectionText(header, node.Str("header"));
        if (stack.Children[2] is TextBlock footer) SetSectionText(footer, node.Str("footer"));
    }

    private static void SetSectionText(TextBlock block, string? text)
    {
        block.Text = text ?? "";
        block.Visibility = text is null ? Visibility.Collapsed : Visibility.Visible;
    }

    // -- Table --------------------------------------------------------------------

    private FrameworkElement BuildTable(NatuiNode node)
    {
        var header = new Grid();
        var list = new ListView { SelectionMode = ListViewSelectionMode.None };
        // Rows must span the full list width so the shared column tracks line
        // up with the header (same concern as BuildList's stretch style).
        var itemStyle = new Style(typeof(ListViewItem));
        itemStyle.Setters.Add(new Setter(
            Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch));
        list.ItemContainerStyle = itemStyle;
        list.SelectionChanged += (_, _) => OnTableSelection(node, list);
        _tableParts[node.Id] = (header, list);
        // A plain Grid rather than a NatuiStack: header and list must both
        // stretch to the table's width for star columns to align, and the
        // list gets the leftover height.
        var container = new Grid();
        container.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        container.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(header, 0);
        container.Children.Add(header);
        Grid.SetRow(list, 1);
        container.Children.Add(list);
        return container;
    }

    private void ApplyTableProps(NatuiNode node)
    {
        if (!_tableParts.TryGetValue(node.Id, out var parts)) return;
        var (header, list) = parts;
        var columns = Json.Arr(node.Props, "columns") ?? [];
        var sort = Json.Obj(node.Props, "sort");
        var sortKey = Json.Str(sort, "key");
        var descending = Json.Str(sort, "order") == "desc";

        // Wholesale rebuild; NodeStore skips structurally equal props.
        header.Children.Clear();
        header.ColumnDefinitions.Clear();
        for (var i = 0; i < columns.Count; i++)
        {
            var column = columns[i] as JsonObject;
            header.ColumnDefinitions.Add(TableColumnDefinition(column));
            var key = Json.Str(column, "key") ?? "";
            var label = Json.Str(column, "label") ?? "";
            var headerContent = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 4,
            };
            headerContent.Children.Add(new TextBlock
            {
                Text = label,
                VerticalAlignment = VerticalAlignment.Center,
            });
            if (key == sortKey)
            {
                headerContent.Children.Add(new FontIcon
                {
                    FontFamily = IconFontFamily(),
                    FontSize = 10,
                    Glyph = GlyphFor(descending ? "chevron.down" : "chevron.up"),
                    VerticalAlignment = VerticalAlignment.Center,
                });
            }
            var button = new Button
            {
                Content = headerContent,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                FontWeight = FontWeights.SemiBold,
            };
            if (Json.Bool(column, "sortable") != false)
            {
                button.Click += (_, _) => EmitSortChange(node, key);
            }
            Grid.SetColumn(button, i);
            header.Children.Add(button);
        }

        list.Items.Clear();
        foreach (var entry in Json.Arr(node.Props, "rows") ?? [])
        {
            if (entry is not JsonObject row) continue;
            // Row grids are not node elements, so the Tag convention (row id
            // string) is safe; selection reads it back.
            var rowGrid = new Grid { Tag = Json.Str(row, "id") ?? "" };
            var cells = Json.Obj(row, "cells");
            for (var i = 0; i < columns.Count; i++)
            {
                var column = columns[i] as JsonObject;
                rowGrid.ColumnDefinitions.Add(TableColumnDefinition(column));
                var cell = new TextBlock
                {
                    Text = Json.Str(cells, Json.Str(column, "key") ?? "") ?? "",
                    TextTrimming = TextTrimming.CharacterEllipsis,
                };
                Grid.SetColumn(cell, i);
                rowGrid.Children.Add(cell);
            }
            list.Items.Add(rowGrid);
        }

        // Re-select by row id under the guard ApplyProps is holding.
        list.SelectionMode = SelectionModeFor(node);
        ApplySelectionValue(node, list, RowIdOfTableRow);
    }

    /// <summary>
    /// Pixel width when given, else Star. NEVER Auto: the header and each row
    /// are separate Grids, and Auto tracks cannot share measurement.
    /// </summary>
    private static ColumnDefinition TableColumnDefinition(JsonObject? column) => new()
    {
        Width = Json.Num(column, "width") is { } width
            ? new GridLength(width)
            : new GridLength(1, GridUnitType.Star),
    };

    /// <summary>
    /// Request semantics: never reorder locally; the app re-sorts rows and
    /// echoes the sort prop, which moves the native sort glyph.
    /// </summary>
    private void EmitSortChange(NatuiNode node, string key)
    {
        var sort = Json.Obj(node.Props, "sort");
        var order = Json.Str(sort, "key") == key && Json.Str(sort, "order") != "desc"
            ? "desc"
            : "asc";
        Ipc.Event(node.Id, "sortChange", new JsonObject
        {
            ["value"] = new JsonObject { ["key"] = key, ["order"] = order },
        });
    }

    private void OnTableSelection(NatuiNode node, ListView list) =>
        OnSelectionChanged(node, list, RowIdOfTableRow);

    private static string RowIdOfTableRow(object entry) =>
        (entry as FrameworkElement)?.Tag as string ?? "";

    // -- DisclosureGroup ----------------------------------------------------------

    private Expander BuildDisclosureGroup(NatuiNode node)
    {
        var content = new NatuiStack
        {
            Orientation = Orientation.Vertical,
            CrossAlignment = "leading",
        };
        _contentSurface[node.Id] = content;
        var expander = new Expander
        {
            Content = content,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        expander.Expanding += (_, _) => OnDisclosure(node, true);
        expander.Collapsed += (_, _) => OnDisclosure(node, false);
        return expander;
    }

    private void OnDisclosure(NatuiNode node, bool expanded)
    {
        if (_applyingRemote > 0) return;
        if (expanded == (Json.Bool(node.Props, "value") ?? false)) return;
        node.UserEdit(JsonValue.Create(expanded));
    }

    private void ApplyDisclosureGroupProps(NatuiNode node, Expander expander)
    {
        expander.Header = node.Str("label") ?? "";
        expander.IsExpanded = Json.Bool(node.Props, "value") ?? false;
    }

    // -- List selection -----------------------------------------------------------

    private void ApplyListProps(NatuiNode node, ListView list)
    {
        list.SelectionMode = SelectionModeFor(node);
        ApplySelectionValue(node, list, RowTagOfListRow);
        ApplySectionSelectionValue(node);
    }

    private void OnListSelection(NatuiNode node, ListView list) =>
        OnSelectionChanged(node, list, RowTagOfListRow);

    /// <summary>
    /// List rows identify themselves by the tag common prop (falling back to
    /// the node id). A Section shell is structural rather than selectable;
    /// its child row presenters participate in the outer list separately.
    /// </summary>
    private static string RowTagOfListRow(object entry) =>
        (entry as FrameworkElement)?.Tag is NatuiNode node
            ? node.Kind == "Section"
                ? ""
                : node.Str("tag") ?? node.Id.ToString(CultureInfo.InvariantCulture)
            : "";

    /// <summary>Selectable only when props carry a value key (even null).</summary>
    private static ListViewSelectionMode SelectionModeFor(NatuiNode node) =>
        !node.Props.ContainsKey("value") ? ListViewSelectionMode.None
        : node.Str("selectionMode") == "multiple" ? ListViewSelectionMode.Multiple
        : ListViewSelectionMode.Single;

    /// <summary>
    /// Pushes the value prop into the ListView's selection. Callers hold the
    /// _applyingRemote guard (ApplyProps), so SelectionChanged stays silent.
    /// </summary>
    private static void ApplySelectionValue(
        NatuiNode node, ListView list, Func<object, string> rowId)
    {
        if (list.SelectionMode == ListViewSelectionMode.None) return;
        var value = node.Props.TryGetPropertyValue("value", out var v) ? v : null;
        if (list.SelectionMode == ListViewSelectionMode.Multiple)
        {
            var wanted = new HashSet<string>();
            if (value is JsonArray array)
            {
                foreach (var item in array)
                {
                    if (StringOf(item) is { } s) wanted.Add(s);
                }
            }
            list.SelectedItems.Clear();
            foreach (var entry in list.Items)
            {
                if (wanted.Contains(rowId(entry))) list.SelectedItems.Add(entry);
            }
        }
        else
        {
            var wanted = StringOf(value);
            object? match = null;
            if (wanted is not null)
            {
                foreach (var entry in list.Items)
                {
                    if (rowId(entry) == wanted)
                    {
                        match = entry;
                        break;
                    }
                }
            }
            // Values matching no row (or null) render as no selection.
            if (!ReferenceEquals(list.SelectedItem, match)) list.SelectedItem = match;
        }
    }

    /// <summary>
    /// A user selection change: single mode round-trips string-or-null,
    /// multiple a SORTED string array (matching the macOS host, so repeated
    /// dumps are deterministic). UserEdit no-ops on equal values.
    /// </summary>
    private void OnSelectionChanged(NatuiNode node, ListView list, Func<object, string> rowId)
    {
        if (_applyingRemote > 0) return;
        if (!node.Props.ContainsKey("value")) return;
        JsonNode? value;
        if (list.SelectionMode == ListViewSelectionMode.Multiple)
        {
            var ids = new List<string>();
            foreach (var entry in list.SelectedItems)
            {
                var id = rowId(entry);
                if (id.Length > 0) ids.Add(id);
            }
            // Section rows live inside the structural Section item rather
            // than in this ListView's Items collection. Preserve their
            // controlled selections when a direct row is toggled.
            var sectionIds = SectionRowIds(node);
            if (node.Props["value"] is JsonArray current)
            {
                foreach (var item in current)
                {
                    if (StringOf(item) is { } id && sectionIds.Contains(id)) ids.Add(id);
                }
            }
            ids.Sort(StringComparer.Ordinal);
            value = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());
        }
        else
        {
            var id = list.SelectedItem is { } selected ? rowId(selected) : null;
            if (id is { Length: 0 })
            {
                // Clicking the structural Section item must not clear or
                // replace the controlled row selection.
                ReapplyListSelection(node, list);
                return;
            }
            if (id is null && !SelectedRowIsPresent(node, list, rowId))
            {
                // SelectedItem also clears when the selected row is removed,
                // and stays clear while the controlled value names a Section
                // row (those are not in Items). Neither is a user edit.
                ReapplyListSelection(node, list);
                return;
            }
            // Deselecting a row (Ctrl+click) reports a real null selection.
            value = id is null ? null : JsonValue.Create(id);
        }
        node.UserEdit(value);
        ReapplyListSelection(node, list);
    }

    /// <summary>True when the controlled value names a row still in the list.</summary>
    private static bool SelectedRowIsPresent(
        NatuiNode node, ListView list, Func<object, string> rowId)
    {
        var value = node.Props.TryGetPropertyValue("value", out var v) ? v : null;
        if (StringOf(value) is not { } wanted) return false;
        foreach (var entry in list.Items)
        {
            if (rowId(entry) == wanted) return true;
        }
        return false;
    }

    private bool OnSectionListRowTapped(NatuiNode row)
    {
        if (row.Parent is not { Kind: "Section", Parent: { Kind: "List" } listNode }
            || listNode.Inner is not ListView list
            || !listNode.Props.ContainsKey("value"))
        {
            return false;
        }
        var id = row.Str("tag") ?? row.Id.ToString(CultureInfo.InvariantCulture);
        JsonNode? value;
        if (SelectionModeFor(listNode) == ListViewSelectionMode.Multiple)
        {
            var selected = new HashSet<string>(StringComparer.Ordinal);
            if (listNode.Props["value"] is JsonArray current)
            {
                foreach (var item in current)
                {
                    if (StringOf(item) is { } currentId) selected.Add(currentId);
                }
            }
            if (!selected.Add(id)) selected.Remove(id);
            value = new JsonArray(selected.Order(StringComparer.Ordinal)
                .Select(selectedId => (JsonNode?)JsonValue.Create(selectedId)).ToArray());
        }
        else
        {
            value = JsonValue.Create(id);
        }
        listNode.UserEdit(value);
        ReapplyListSelection(listNode, list);
        return true;
    }

    private void ReapplyListSelection(NatuiNode node, ListView list)
    {
        _applyingRemote++;
        try
        {
            ApplyListProps(node, list);
        }
        finally
        {
            _applyingRemote--;
        }
    }

    private void ApplySectionSelectionValue(NatuiNode listNode)
    {
        var selected = SelectedListValues(listNode);
        foreach (var row in _listRows.Values)
        {
            var node = row.Node;
            if (node.Parent is not { Kind: "Section", Parent: var owner }
                || !ReferenceEquals(owner, listNode))
            {
                continue;
            }
            var id = node.Str("tag") ?? node.Id.ToString(CultureInfo.InvariantCulture);
            row.SetSectionSelected(selected.Contains(id));
        }
    }

    private HashSet<string> SectionRowIds(NatuiNode listNode)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in _listRows.Values)
        {
            var node = row.Node;
            if (node.Parent is not { Kind: "Section", Parent: var owner }
                || !ReferenceEquals(owner, listNode))
            {
                continue;
            }
            result.Add(node.Str("tag") ?? node.Id.ToString(CultureInfo.InvariantCulture));
        }
        return result;
    }

    private static HashSet<string> SelectedListValues(NatuiNode node)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!node.Props.TryGetPropertyValue("value", out var value)) return result;
        if (value is JsonArray array)
        {
            foreach (var item in array)
            {
                if (StringOf(item) is { } id) result.Add(id);
            }
        }
        else if (StringOf(value) is { } id)
        {
            result.Add(id);
        }
        return result;
    }

    private static string? StringOf(JsonNode? value) =>
        value is not null && value.GetValueKind() == JsonValueKind.String
            ? value.GetValue<string>()
            : null;
}
