using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace NatuiHost;

/// <summary>
/// Structural kinds: SplitView (+ Sidebar/Detail slots), TabView/Tab, Section,
/// Table, DisclosureGroup, plus the slot-routing hooks and List selection.
/// </summary>
internal sealed partial class NodeMapper
{
    /// <summary>Header grid + row ListView per Table node id.</summary>
    private readonly Dictionary<int, (Grid Header, ListView List)> _tableParts = [];

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
                if (parent.Inner is not SplitView splitView) return false;
                switch (child.Kind)
                {
                    case "Sidebar":
                        splitView.Pane = EnsureElement(child);
                        return true;
                    case "Detail":
                        splitView.Content = EnsureElement(child);
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
                if (parent.Inner is not SplitView splitView) return false;
                switch (child.Kind)
                {
                    case "Sidebar":
                        if (ReferenceEquals(splitView.Pane, child.Element)) splitView.Pane = null;
                        return true;
                    case "Detail":
                        if (ReferenceEquals(splitView.Content, child.Element)) splitView.Content = null;
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

    private static SplitView BuildSplitView(NatuiNode node) => new()
    {
        // Inline: the pane shares space with the content, like a macOS
        // sidebar column. Sidebar visibility is JS-driven on Windows (no
        // native toggle affordance), so there are no events to wire.
        DisplayMode = SplitViewDisplayMode.Inline,
        IsPaneOpen = true,
    };

    private void ApplySplitViewProps(NatuiNode node, SplitView splitView)
    {
        splitView.IsPaneOpen = node.Str("value") != "detailOnly";
        splitView.OpenPaneLength = node.Num("sidebarWidth") ?? 220;
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
            var arrow = key == sortKey ? (descending ? " v" : " ^") : "";
            var button = new Button
            {
                Content = (Json.Str(column, "label") ?? "") + arrow,
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
    /// echoes the sort prop, which moves the arrow.
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
    }

    private void OnListSelection(NatuiNode node, ListView list) =>
        OnSelectionChanged(node, list, RowTagOfListRow);

    /// <summary>
    /// List rows identify themselves by the tag common prop (falling back to
    /// the node id). Divergence: rows inside Sections are not individually
    /// selectable on Windows v1 (they are not items of the outer ListView).
    /// </summary>
    private static string RowTagOfListRow(object entry) =>
        (entry as FrameworkElement)?.Tag is NatuiNode node
            ? node.Str("tag") ?? node.Id.ToString(CultureInfo.InvariantCulture)
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
            foreach (var entry in list.SelectedItems) ids.Add(rowId(entry));
            ids.Sort(StringComparer.Ordinal);
            value = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());
        }
        else
        {
            value = list.SelectedItem is { } selected
                ? JsonValue.Create(rowId(selected))
                : null;
        }
        node.UserEdit(value);
    }

    private static string? StringOf(JsonNode? value) =>
        value is not null && value.GetValueKind() == JsonValueKind.String
            ? value.GetValue<string>()
            : null;
}
