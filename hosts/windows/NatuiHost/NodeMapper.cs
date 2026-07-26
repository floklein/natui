using System.Numerics;
using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Windows.UI;
using FontWeight = Windows.UI.Text.FontWeight;

namespace NatuiHost;

/// <summary>
/// VStack/HStack. A Grid rather than a StackPanel: StackPanel offers children
/// unlimited main-axis space, so "Spacer fills the leftover" cannot be
/// expressed. Each child gets its own Auto track; Spacers (and other greedy
/// children) get Star tracks. RebuildLayout must be called after every
/// children mutation.
/// </summary>
internal sealed class NatuiStack : Grid
{
    public Orientation Orientation { get; set; } = Orientation.Vertical;

    /// <summary>
    /// Protocol alignment string: leading/center/trailing for vertical stacks,
    /// top/center/bottom for horizontal ones. Null means the default: center
    /// on both axes, like SwiftUI stacks. (Greedy children still stretch via
    /// IsCrossStretch, independent of this alignment.)
    /// </summary>
    public string? CrossAlignment { get; set; }

    public double Spacing { get; set; }

    /// <summary>
    /// True when some child wants all leftover space on this axis (Spacer, an
    /// "infinity" frame, or an inherently greedy control). A greedy child stack
    /// becomes a star track in its parent, which is how SwiftUI's "propose the
    /// full size down the tree" behaves in a Grid world.
    /// </summary>
    public bool HGreedy { get; private set; }
    public bool VGreedy { get; private set; }

    // Kinds that expand to fill an axis in SwiftUI without an explicit frame.
    // Internal: NodeMapper.SyncInnerAlignment shares them.
    internal static readonly HashSet<string> GreedyHorizontalKinds =
    [
        "TextField", "Slider", "ProgressView", "List", "ScrollView",
        "SplitView", "TabView", "Table", "SearchField", "TextEditor",
    ];
    internal static readonly HashSet<string> GreedyVerticalKinds =
        ["List", "ScrollView", "SplitView", "TabView", "Table", "TextEditor"];

    public void RebuildLayout()
    {
        var vertical = Orientation == Orientation.Vertical;
        RowDefinitions.Clear();
        ColumnDefinitions.Clear();
        RowSpacing = vertical ? Spacing : 0;
        ColumnSpacing = vertical ? 0 : Spacing;

        var anyMainStar = false;
        var anyCrossStretch = false;
        for (var i = 0; i < Children.Count; i++)
        {
            if (vertical) RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            else ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            if (Children[i] is not FrameworkElement child) continue;

            var node = child.Tag as NatuiNode;
            var mainStar = IsMainStar(node, vertical);
            // List row presenters must span the available cross axis so a
            // trailing badge and section-selection background reach the row
            // edge even when the row's own content is intrinsically narrow.
            var crossStretch = child is NatuiListRow || IsCrossStretch(node, vertical);
            anyMainStar |= mainStar;
            anyCrossStretch |= crossStretch;

            if (vertical)
            {
                if (mainStar) RowDefinitions[i].Height = new GridLength(1, GridUnitType.Star);
                SetRow(child, i);
                SetColumn(child, 0);
                // Main axis always stretches into its own track (an Auto track
                // is content-sized anyway); this also clears a stale value left
                // by a previous horizontal parent after a move.
                child.VerticalAlignment = VerticalAlignment.Stretch;
                child.HorizontalAlignment = crossStretch
                    ? HorizontalAlignment.Stretch
                    : CrossToHorizontal();
            }
            else
            {
                if (mainStar) ColumnDefinitions[i].Width = new GridLength(1, GridUnitType.Star);
                SetColumn(child, i);
                SetRow(child, 0);
                child.HorizontalAlignment = HorizontalAlignment.Stretch;
                child.VerticalAlignment = crossStretch
                    ? VerticalAlignment.Stretch
                    : CrossToVertical();
            }

            switch (node?.Kind)
            {
                case "Spacer":
                {
                    var min = node.Num("minLength") ?? 0;
                    child.MinHeight = vertical ? min : 0;
                    child.MinWidth = vertical ? 0 : min;
                    break;
                }
                case "Divider":
                    // A Divider is a 1px line across the cross axis.
                    child.Height = vertical ? 1 : double.NaN;
                    child.Width = vertical ? double.NaN : 1;
                    break;
            }
        }

        var hGreedy = vertical ? anyCrossStretch : anyMainStar;
        var vGreedy = vertical ? anyMainStar : anyCrossStretch;
        if (hGreedy != HGreedy || vGreedy != VGreedy)
        {
            HGreedy = hGreedy;
            VGreedy = vGreedy;
            // A stack that turned greedy must also fill its own frame shell.
            if (Tag is NatuiNode self) NodeMapper.SyncInnerAlignment(self);
            // Greediness bubbles up: a stack containing a greedy child is
            // itself greedy. Node stacks sit inside their frame shell (a
            // Border), so look through it; internal stacks (root, labels,
            // scroll content) may be direct children. Terminates because it
            // only recurses on change.
            var ancestor = Parent is Border shell ? shell.Parent : Parent;
            if (ancestor is NatuiStack stack) stack.RebuildLayout();
            else if (ancestor is NatuiZStack zStack) zStack.RebuildLayout();
        }
    }

    // Stack children are the nodes' frame shells, so nested-stack greediness
    // is read through node.Inner rather than the child element itself.
    private static bool IsMainStar(NatuiNode? node, bool vertical)
    {
        if (node is null) return false;
        if (node.Kind == "Spacer") return true;
        return vertical
            ? WantsVerticalSpace(node)
            : WantsHorizontalSpace(node);
    }

    private static bool IsCrossStretch(NatuiNode? node, bool vertical)
    {
        if (node is null) return false;
        if (node.Kind == "Divider") return true;
        return vertical
            ? WantsHorizontalSpace(node)
            : WantsVerticalSpace(node);
    }

    internal static bool WantsHorizontalSpace(NatuiNode node) =>
        node.StretchH || GreedyHorizontalKinds.Contains(node.Kind)
            || node.Inner is NatuiStack { HGreedy: true }
            || node.Inner is NatuiZStack { HGreedy: true };

    internal static bool WantsVerticalSpace(NatuiNode node) =>
        node.StretchV || GreedyVerticalKinds.Contains(node.Kind)
            || node.Inner is NatuiStack { VGreedy: true }
            || node.Inner is NatuiZStack { VGreedy: true };

    private HorizontalAlignment CrossToHorizontal() => CrossAlignment switch
    {
        "leading" => HorizontalAlignment.Left,
        "trailing" => HorizontalAlignment.Right,
        // SwiftUI VStacks center children horizontally by default.
        _ => HorizontalAlignment.Center,
    };

    private VerticalAlignment CrossToVertical() => CrossAlignment switch
    {
        "top" => VerticalAlignment.Top,
        "bottom" => VerticalAlignment.Bottom,
        _ => VerticalAlignment.Center,
    };
}

/// <summary>
/// Overlay stack whose proposal greediness follows its children. Unlike a
/// row or column stack, a Spacer in a ZStack expands on both axes, so the
/// containing stack must request the full proposal from its own parent.
/// </summary>
internal sealed class NatuiZStack : Grid
{
    public bool HGreedy { get; private set; }
    public bool VGreedy { get; private set; }

    public void RebuildLayout()
    {
        var hGreedy = false;
        var vGreedy = false;
        foreach (var item in Children)
        {
            if (item is not FrameworkElement child || child.Tag is not NatuiNode node) continue;
            if (node.Kind == "Spacer")
            {
                var min = node.Num("minLength") ?? 0;
                child.MinWidth = min;
                child.MinHeight = min;
                hGreedy = true;
                vGreedy = true;
                continue;
            }
            hGreedy |= NatuiStack.WantsHorizontalSpace(node);
            vGreedy |= NatuiStack.WantsVerticalSpace(node);
        }

        if (hGreedy == HGreedy && vGreedy == VGreedy) return;
        HGreedy = hGreedy;
        VGreedy = vGreedy;
        if (Tag is NatuiNode self) NodeMapper.SyncInnerAlignment(self);

        var ancestor = Parent is Border shell ? shell.Parent : Parent;
        if (ancestor is NatuiStack stack) stack.RebuildLayout();
        else if (ancestor is NatuiZStack zStack) zStack.RebuildLayout();
    }
}

/// <summary>
/// Builds WinUI elements for nodes, applies props, refreshes labels, and wires
/// user events back to the protocol channel. UI thread only. The app-shell
/// kinds live in the NodeMapper.*.cs partials (Menus, Overlays, Structure,
/// Inputs).
/// </summary>
internal sealed partial class NodeMapper(
    NatuiStack rootStack,
    StackPanel chromePanel,
    Grid overlayLayer,
    Action requestQuit) : INodeMapper
{
    public NatuiStack RootStack { get; } = rootStack;

    /// <summary>Chrome row above the root content: MenuBar, then CommandBar.</summary>
    public StackPanel ChromePanel { get; } = chromePanel;

    /// <summary>Full-window layer the Sheet overlay (scrim + card) mounts into.</summary>
    public Grid OverlayLayer { get; } = overlayLayer;

    /// <summary>
    /// Content surfaces for kinds whose children mount somewhere other than
    /// their Inner element (Sheet card, Section body, Expander content,
    /// Popover anchor is Inner itself). Cleaned up in WillDestroy.
    /// </summary>
    private readonly Dictionary<int, NatuiStack> _contentSurface = [];

    /// <summary>
    /// Depth counter, positive while remote ops mutate controls. WinUI raises
    /// TextChanged/Checked/ValueChanged for programmatic writes too (unlike
    /// SwiftUI bindings), so change handlers must know to stay silent. Change
    /// handlers additionally compare against the stored prop value, because a
    /// few WinUI events can arrive after this guard has been released.
    /// </summary>
    private int _applyingRemote;

    private static readonly HashSet<string> LabelKinds =
        ["Text", "Button", "Toggle", "Link", "Label", "Menu"];

    private static readonly HashSet<string> ContainerKinds =
    [
        "VStack", "HStack", "ZStack", "ScrollView", "List",
        "SplitView", "TabView", "Tab", "Sheet", "Popover", "ContextMenu",
        "Section", "DisclosureGroup", "Sidebar", "Detail", "PopoverContent",
    ];

    /// <summary>
    /// #text nodes are consumed by their parent's label in label kinds; in
    /// containers and at the root they render as plain text views, matching
    /// the macOS host's childViews.
    /// </summary>
    public static bool IsAttachable(int parentId, NatuiNode? parent, NatuiNode child) =>
        child.Kind != "#text"
        || parentId == NodeStore.RootId
        || (parent is not null && ContainerKinds.Contains(parent.Kind));

    // -- element construction ---------------------------------------------------

    public void CreateElement(NatuiNode node) => EnsureElement(node);

    private FrameworkElement EnsureElement(NatuiNode node)
    {
        if (node.Element is null)
        {
            node.Inner = Build(node);
            // Frame shell: the frame props size this outer Border while
            // padding, background, and cornerRadius stay on the inner
            // element. This reproduces the macOS modifier order (padding →
            // background → cornerRadius clip → frame): a frame never widens
            // the painted background.
            node.Element = new Border { Child = node.Inner };
            // Both carry the node: NatuiStack layout reads it off its
            // children (the shells), prop helpers off the inner element.
            node.Element.Tag = node;
            node.Inner.Tag = node;
            ApplyProps(node);
        }
        return node.Element;
    }

    private FrameworkElement Build(NatuiNode node) => node.Kind switch
    {
        "VStack" => new NatuiStack { Orientation = Orientation.Vertical },
        "HStack" => new NatuiStack { Orientation = Orientation.Horizontal },
        "ZStack" => new NatuiZStack(),
        "Text" or "#text" => BuildText(node),
        "Button" => BuildButton(node),
        "TextField" => BuildTextField(node),
        "Toggle" => BuildToggle(node),
        "Slider" => BuildSlider(node),
        "Picker" => BuildPicker(node),
        "ScrollView" => BuildScrollView(node),
        "List" => BuildList(node),
        "Image" => BuildImage(),
        "Spacer" => new Border(),
        "Divider" => new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(0x4D, 0x88, 0x88, 0x88)),
        },
        // ProgressView swaps between ProgressBar and ProgressRing depending on
        // whether "value" is present; the Grid shell keeps that swap local.
        "ProgressView" => new Grid(),
        // App-shell kinds (NodeMapper.*.cs partials).
        "MenuBar" => BuildMenuBar(node),
        "Toolbar" => BuildToolbar(node),
        "Menu" => BuildMenu(node),
        "ContextMenu" => BuildContextMenu(node),
        "SplitView" => BuildSplitView(node),
        "Sidebar" or "Detail" or "PopoverContent" or "Tab" => BuildSlotStack(),
        "TabView" => BuildTabView(node),
        "Sheet" => BuildSheet(node),
        "Alert" => BuildAlert(node),
        "Popover" => BuildPopover(node),
        "Section" => BuildSection(node),
        "Table" => BuildTable(node),
        "DisclosureGroup" => BuildDisclosureGroup(node),
        "SearchField" => BuildSearchField(node),
        "DatePicker" => BuildDatePicker(node),
        "Stepper" => BuildStepper(node),
        "TextEditor" => BuildTextEditor(node),
        "Link" => BuildLink(node),
        "Label" => BuildLabel(node),
        _ => new TextBlock
        {
            Text = $"unknown kind: {node.Kind}",
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.Red),
        },
    };

    private static FrameworkElement BuildText(NatuiNode node)
    {
        // TextBlock has no Background/CornerRadius, so every Text gets a
        // Border box (the node's Inner) that carries padding/background/
        // cornerRadius; the frame shell around it is added by EnsureElement.
        var label = new TextBlock { TextWrapping = TextWrapping.Wrap };
        node.Label = label;
        return new Border { Child = label };
    }

    private static Border BuildImage() => new()
    {
        Child = new FontIcon { FontFamily = IconFontFamily() },
    };

    private static Button BuildButton(NatuiNode node)
    {
        var button = new Button();
        button.Click += (_, _) => Ipc.Event(node.Id, "press");
        return button;
    }

    private FrameworkElement BuildTextField(NatuiNode node)
    {
        if (node.Flag("secure"))
        {
            var box = new PasswordBox();
            box.PasswordChanged += (_, _) => OnTextInput(node, box.Password);
            box.KeyDown += (_, e) =>
            {
                if (e.Key == Windows.System.VirtualKey.Enter) EmitSubmit(node);
            };
            return box;
        }
        var text = new TextBox();
        text.TextChanged += (_, _) => OnTextInput(node, text.Text);
        text.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter) EmitSubmit(node);
        };
        return text;
    }

    private void OnTextInput(NatuiNode node, string value)
    {
        if (_applyingRemote > 0) return;
        if (value == (node.Str("value") ?? "")) return;
        // Optimistic local write plus seq so JS echoes can be staleness-checked
        // (protocol seq/ack); shared with the "edit" debug message.
        node.UserEdit(JsonValue.Create(value));
    }

    private static void EmitSubmit(NatuiNode node) =>
        Ipc.Event(node.Id, "submit", new JsonObject { ["value"] = node.Str("value") ?? "" });

    private FrameworkElement BuildToggle(NatuiNode node)
    {
        if (node.Str("style") == "switch")
        {
            // Empty On/Off content: the label rides Header (see RefreshLabel).
            var toggle = new ToggleSwitch { OnContent = "", OffContent = "" };
            toggle.Toggled += (_, _) => OnToggle(node, toggle.IsOn);
            return toggle;
        }
        // CheckBox is the closest native analogue of SwiftUI's macOS checkbox
        // Toggle (label on the trailing side, compact).
        var box = new CheckBox { MinWidth = 0 };
        box.Checked += (_, _) => OnToggle(node, true);
        box.Unchecked += (_, _) => OnToggle(node, false);
        return box;
    }

    private void OnToggle(NatuiNode node, bool value)
    {
        if (_applyingRemote > 0) return;
        if (value == (Json.Bool(node.Props, "value") ?? false)) return;
        node.UserEdit(JsonValue.Create(value));
    }

    private Slider BuildSlider(NatuiNode node)
    {
        var slider = new Slider();
        slider.ValueChanged += (_, e) =>
        {
            if (_applyingRemote > 0) return;
            if (e.NewValue == (node.Num("value") ?? 0)) return;
            node.UserEdit(JsonValue.Create(e.NewValue));
        };
        return slider;
    }

    private FrameworkElement BuildPicker(NatuiNode node) => node.Str("style") switch
    {
        "segmented" => BuildSegmentedPicker(node),
        "radioGroup" => BuildRadioPicker(node),
        _ => BuildComboPicker(node),
    };

    private ComboBox BuildComboPicker(NatuiNode node)
    {
        var combo = new ComboBox();
        combo.SelectionChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            var value = (combo.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
            if (value == (node.Str("value") ?? "")) return;
            node.UserEdit(JsonValue.Create(value));
        };
        return combo;
    }

    private static ScrollViewer BuildScrollView(NatuiNode node)
    {
        var viewer = new ScrollViewer();
        ConfigureScrollAxis(viewer, node);
        return viewer;
    }

    private static void ConfigureScrollAxis(ScrollViewer viewer, NatuiNode node)
    {
        var horizontal = node.Str("axis") == "horizontal";
        if (viewer.Content is not NatuiStack stack
            || (stack.Orientation == Orientation.Horizontal) != horizontal)
        {
            var previous = viewer.Content as NatuiStack;
            stack = new NatuiStack
            {
                Orientation = horizontal ? Orientation.Horizontal : Orientation.Vertical,
                // Mirrors the Swift host's wrapper stacks: VStack(.leading)
                // for vertical scrolling, HStack (center) for horizontal.
                CrossAlignment = horizontal ? null : "leading",
            };
            if (previous is not null)
            {
                var moved = previous.Children.ToList();
                previous.Children.Clear();
                foreach (var child in moved) stack.Children.Add(child);
            }
            viewer.Content = stack;
            stack.RebuildLayout();
        }
        viewer.HorizontalScrollBarVisibility =
            horizontal ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled;
        viewer.HorizontalScrollMode = horizontal ? ScrollMode.Enabled : ScrollMode.Disabled;
        viewer.VerticalScrollBarVisibility =
            horizontal ? ScrollBarVisibility.Disabled : ScrollBarVisibility.Auto;
        viewer.VerticalScrollMode = horizontal ? ScrollMode.Disabled : ScrollMode.Enabled;
    }

    private ListView BuildList(NatuiNode node)
    {
        var list = new ListView { SelectionMode = ListViewSelectionMode.None };
        // Rows must span the full list width or Spacer children collapse
        // (the default item container left-aligns its content).
        var itemStyle = new Style(typeof(ListViewItem));
        itemStyle.Setters.Add(new Setter(
            Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch));
        list.ItemContainerStyle = itemStyle;
        list.SelectionChanged += (_, _) => OnListSelection(node, list);
        return list;
    }

    private static FontFamily IconFontFamily() =>
        Theme.Resource<FontFamily>("SymbolThemeFontFamily")
        ?? new FontFamily("Segoe MDL2 Assets");

    // -- attach / detach ----------------------------------------------------------

    public void AttachVisual(int parentId, NatuiNode? parent, NatuiNode child, int index)
    {
        if (parent is not null && LabelKinds.Contains(parent.Kind))
        {
            RefreshLabel(parent);
            ApplyForegroundToDescendants(parent);
            return;
        }
        if (!IsAttachable(parentId, parent, child)) return;
        // Slot-routed parents (SplitView/TabView/Popover) place children by
        // KIND, not index; see NodeMapper.Structure.cs / Overlays.cs.
        if (parent is not null && AttachToSlottedParent(parent, child))
        {
            ApplyForegroundTree(child);
            return;
        }
        var element = EnsureElement(child);
        if (parent?.Kind == "Section"
            && ParentSurface(parentId, parent) is NatuiStack sectionContent)
        {
            child.InList = parent.Parent?.Kind == "List";
            SyncInnerAlignment(child);
            var row = CreateListRow(child, element);
            sectionContent.Children.Insert(index, row);
            sectionContent.RebuildLayout();
            if (parent.Parent is { Kind: "List", Inner: ListView ownerList })
            {
                ReapplyListSelection(parent.Parent, ownerList);
            }
            ApplyForegroundTree(child);
            return;
        }
        switch (ParentSurface(parentId, parent))
        {
            case NatuiStack stack:
                stack.Children.Insert(index, element);
                stack.RebuildLayout();
                break;
            case NatuiZStack zStack:
                zStack.Children.Insert(index, element);
                zStack.RebuildLayout();
                break;
            case Panel panel:
                panel.Children.Insert(index, element);
                break;
            case ListView list:
                // SwiftUI list rows lead-align their content.
                child.InList = true;
                SyncInnerAlignment(child);
                if (child.Kind == "Section") SetSectionRowsInList(child, true);
                list.Items.Insert(index, CreateListRow(child, element));
                if (parent is not null) ReapplyListSelection(parent, list);
                break;
            case null:
                // Parent kind cannot hold visual children; the Swift host
                // silently ignores them too.
                break;
        }
        ApplyForegroundTree(child);
    }

    public void DetachVisual(int parentId, NatuiNode? parent, NatuiNode child)
    {
        if (parent is not null && LabelKinds.Contains(parent.Kind))
        {
            RefreshLabel(parent);
            ApplyForegroundToDescendants(parent);
            return;
        }
        if (parent is not null && DetachFromSlottedParent(parent, child)) return;
        if (child.Element is not { } element) return;
        if (parent?.Kind == "Section"
            && ParentSurface(parentId, parent) is NatuiStack sectionContent
            && _listRows.TryGetValue(child.Id, out var sectionRow))
        {
            sectionContent.Children.Remove(sectionRow);
            sectionContent.RebuildLayout();
            ReleaseListRow(child);
            child.InList = false;
            SyncInnerAlignment(child);
            if (parent.Parent is { Kind: "List", Inner: ListView ownerList })
            {
                ReapplyListSelection(parent.Parent, ownerList);
            }
            return;
        }
        switch (ParentSurface(parentId, parent))
        {
            case NatuiStack stack:
                stack.Children.Remove(element);
                stack.RebuildLayout();
                break;
            case NatuiZStack zStack:
                zStack.Children.Remove(element);
                zStack.RebuildLayout();
                break;
            case Panel panel:
                panel.Children.Remove(element);
                break;
            case ListView list:
                if (child.Kind == "Section") SetSectionRowsInList(child, false);
                if (_listRows.TryGetValue(child.Id, out var row)) list.Items.Remove(row);
                else list.Items.Remove(element);
                ReleaseListRow(child);
                child.InList = false;
                SyncInnerAlignment(child); // drop the list-row lead alignment
                if (parent is not null) ReapplyListSelection(parent, list);
                break;
        }
    }

    /// <summary>The object that holds a parent's visual children, if any.</summary>
    private object? ParentSurface(int parentId, NatuiNode? parent)
    {
        if (parentId == NodeStore.RootId) return RootStack;
        if (parent is not null && _contentSurface.TryGetValue(parent.Id, out var surface))
        {
            // Sheet card, Section body, DisclosureGroup (Expander) content.
            return surface;
        }
        return parent?.Inner switch
        {
            NatuiStack stack => stack,
            ListView list => list,
            ScrollViewer viewer => viewer.Content as NatuiStack,
            // parent is provably non-null here (its Inner just matched),
            // but the flow analysis cannot see through the switch target.
            Grid grid when parent!.Kind == "ZStack" => grid,
            _ => null,
        };
    }

    public void ClearRoot()
    {
        RootStack.Children.Clear();
        RootStack.RebuildLayout();
    }

    // -- labels -------------------------------------------------------------------

    /// <summary>
    /// WinUI is retained, not reactive: when label children change, the parent
    /// Text/Button/Toggle must recompute its content by hand.
    /// </summary>
    public void TextChanged(NatuiNode textNode, NatuiNode? parent)
    {
        if (textNode.Label is { } label) label.Text = textNode.Text; // root-attached raw text
        if (parent is not null && LabelKinds.Contains(parent.Kind))
        {
            RefreshLabel(parent);
            ApplyForegroundToDescendants(parent);
        }
    }

    private void RefreshLabel(NatuiNode node)
    {
        _applyingRemote++;
        try
        {
            if (node.Kind == "Text")
            {
                RefreshTextContent(node);
                return;
            }
            if (node.Kind == "Menu")
            {
                // The Menu label carries an optional systemImage, so it does
                // not go through the generic ContentControl path.
                if (node.Inner is DropDownButton menuButton) RefreshMenuLabel(node, menuButton);
                return;
            }
            // node.Label covers the Label kind (whose Inner is a NatuiStack
            // around icon + TextBlock).
            if (node.Label is { } label)
            {
                label.Text = node.JoinedText();
                return;
            }
            switch (node.Inner)
            {
                case ToggleSwitch toggle: // Toggle style="switch"
                    RefreshToggleHeader(toggle, node);
                    break;
                case ContentControl control: // Button, CheckBox, HyperlinkButton, DropDownButton
                    RefreshContent(control, node);
                    break;
            }
        }
        finally
        {
            _applyingRemote--;
        }
    }

    private void RefreshTextContent(NatuiNode node)
    {
        if (node.Inner is not Border box || node.Label is not { } label) return;

        // Release child shells from the previous mixed-content wrapper before
        // rebuilding, so they can be reparented in their current order.
        if (box.Child is ContentControl { Content: Panel mixedPanel } oldMixed)
        {
            mixedPanel.Children.Clear();
            oldMixed.Content = null;
        }
        else if (box.Child is Panel oldWrapper)
        {
            oldWrapper.Children.Clear();
        }
        box.Child = null;
        if (node.Children.All(c => c.Kind == "#text"))
        {
            label.Text = node.JoinedText();
            box.Child = label;
            ApplyAutomationProps(node);
            return;
        }

        // SwiftUI represents mixed Text content as a zero-spacing HStack.
        // Use the same structure instead of silently discarding element
        // children such as Image.
        var stack = BuildMixedLabel(node, spacing: 0);
        box.Child = new ContentControl
        {
            Content = stack,
            IsTabStop = false,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Stretch,
        };
        ApplyTextProps(node);
        ApplyAutomationProps(node);
    }

    private void RefreshToggleHeader(ToggleSwitch toggle, NatuiNode node)
    {
        if (toggle.Header is Panel oldWrapper) oldWrapper.Children.Clear();
        toggle.Header = node.Children.All(c => c.Kind == "#text")
            ? node.JoinedText()
            : BuildMixedLabel(node, spacing: 4);
    }

    private void RefreshContent(ContentControl control, NatuiNode node)
    {
        // Drop whatever we parented last time so elements can be re-added.
        if (control.Content is Panel wrapper) wrapper.Children.Clear();
        control.Content = null;

        // Pure-text fast path: a plain string label (macOS: Text(joinedText)).
        if (node.Children.All(c => c.Kind == "#text"))
        {
            control.Content = node.JoinedText();
            return;
        }
        // Mixed labels like <Button><Image/> Delete</Button>: every child in
        // document order, #text children as inline text blocks, matching the
        // macOS host's labelContent (HStack(spacing: 4)).
        control.Content = BuildMixedLabel(node, spacing: 4);
    }

    private NatuiStack BuildMixedLabel(NatuiNode node, double spacing)
    {
        var stack = new NatuiStack { Orientation = Orientation.Horizontal, Spacing = spacing };
        foreach (var child in node.Children) stack.Children.Add(EnsureElement(child));
        stack.RebuildLayout();
        return stack;
    }

    // -- prop application ------------------------------------------------------------

    public void ApplyProps(NatuiNode node)
    {
        if (node.Element is not { } shell || node.Inner is not { } inner) return;
        inner = EnsureCurrentControlVariant(node, shell, inner);
        _applyingRemote++;
        try
        {
            ApplyKindProps(node, inner);
            ApplyCommonProps(node, shell, inner);
        }
        finally
        {
            _applyingRemote--;
        }
        RefreshListRow(node);
        ApplyForegroundToDescendants(node);
        // Frame stretch, spacing, or spacer changes affect the parent's tracks.
        if (shell.Parent is NatuiStack parent) parent.RebuildLayout();
        else if (shell.Parent is NatuiZStack zStack) zStack.RebuildLayout();
    }

    /// <summary>
    /// A few protocol props select different native WinUI control classes.
    /// Keep the outer frame shell stable, but replace its inner control when
    /// those props change so updates match SwiftUI's reactive view selection.
    /// </summary>
    private FrameworkElement EnsureCurrentControlVariant(
        NatuiNode node, FrameworkElement shell, FrameworkElement current)
    {
        var matches = node.Kind switch
        {
            "TextField" => node.Flag("secure")
                ? current is PasswordBox
                : current is TextBox,
            "Toggle" => node.Str("style") == "switch"
                ? current is ToggleSwitch
                : current is CheckBox,
            "Picker" => node.Str("style") switch
            {
                "segmented" => current is SelectorBar,
                "radioGroup" => current is RadioButtons,
                _ => current is ComboBox,
            },
            "DatePicker" => node.Str("displayedComponents") switch
            {
                "time" => current is TimePicker,
                "dateTime" => current is NatuiDateTimePicker,
                _ => current is CalendarDatePicker,
            },
            _ => true,
        };
        if (matches) return current;

        if (node.Kind == "Toggle")
        {
            // Mixed labels may have parented child shells into the old
            // control. Release them before constructing the replacement.
            if (current is ToggleSwitch { Header: Panel header }) header.Children.Clear();
            if (current is ContentControl { Content: Panel content }) content.Children.Clear();
        }
        var replacement = node.Kind switch
        {
            "TextField" => BuildTextField(node),
            "Toggle" => BuildToggle(node),
            "Picker" => BuildPicker(node),
            "DatePicker" => BuildDatePicker(node),
            _ => current,
        };
        replacement.Tag = node;
        if (shell is Border border) border.Child = replacement;
        node.Inner = replacement;
        if (node.Kind == "Toggle") RefreshLabel(node);
        return replacement;
    }

    private void ApplyKindProps(NatuiNode node, FrameworkElement element)
    {
        switch (node.Kind)
        {
            case "VStack" or "HStack":
            {
                var stack = (NatuiStack)element;
                // SwiftUI's default (nil) stack spacing is about 8pt.
                stack.Spacing = node.Num("spacing") ?? 8;
                stack.CrossAlignment = node.Str("alignment");
                stack.RebuildLayout();
                break;
            }
            case "Text" or "#text":
                ApplyTextProps(node);
                break;
            case "Button":
                ApplyButtonProps(node, (Button)element);
                break;
            case "TextField":
                switch (element)
                {
                    case TextBox box:
                    {
                        box.PlaceholderText = node.Str("placeholder") ?? "";
                        var value = node.Str("value") ?? "";
                        if (box.Text != value) box.Text = value;
                        break;
                    }
                    case PasswordBox box:
                    {
                        box.PlaceholderText = node.Str("placeholder") ?? "";
                        var value = node.Str("value") ?? "";
                        if (box.Password != value) box.Password = value;
                        break;
                    }
                }
                break;
            case "Toggle":
                switch (element)
                {
                    case ToggleSwitch toggle:
                        toggle.IsOn = Json.Bool(node.Props, "value") ?? false;
                        break;
                    case CheckBox box:
                        box.IsChecked = Json.Bool(node.Props, "value") ?? false;
                        break;
                }
                break;
            case "Slider":
            {
                var slider = (Slider)element;
                var min = node.Num("min") ?? 0;
                var max = Math.Max(node.Num("max") ?? 1, min + 0.001);
                slider.Minimum = min;
                slider.Maximum = max;
                // WinUI's default StepFrequency is 1, which would quantize a
                // 0..1 slider to its endpoints.
                var step = node.Num("step");
                slider.StepFrequency = step > 0 ? step!.Value : 0.0001;
                var value = node.Num("value") ?? 0;
                if (slider.Value != value) slider.Value = value;
                break;
            }
            case "Picker":
                ApplyPickerProps(node, element);
                break;
            case "List":
                ApplyListProps(node, (ListView)element);
                break;
            case "ScrollView":
                ConfigureScrollAxis((ScrollViewer)element, node);
                break;
            case "Image":
            {
                var icon = (FontIcon)((Border)element).Child;
                icon.Glyph = GlyphFor(node.Str("systemName"));
                icon.FontSize = node.Num("size") ?? 15;
                break;
            }
            case "ProgressView":
                ApplyProgressProps(node, (Grid)element);
                break;
            // App-shell kinds (NodeMapper.*.cs partials).
            case "MenuBar":
                ApplyMenuBarProps(node);
                break;
            case "Toolbar":
                ApplyToolbarProps(node);
                break;
            case "Menu":
                ApplyMenuProps(node, (DropDownButton)element);
                break;
            case "ContextMenu":
                ApplyContextMenuProps(node, element);
                break;
            case "SplitView":
                ApplySplitViewProps(node, (NatuiSplitView)element);
                break;
            case "TabView":
                ApplyTabViewProps(node, (TabView)element);
                break;
            case "Tab":
                ApplyTabProps(node);
                break;
            case "Sheet":
                ApplySheetProps(node);
                break;
            case "Alert":
                ApplyAlertProps(node);
                break;
            case "Popover":
                ApplyPopoverProps(node);
                break;
            case "Section":
                ApplySectionProps(node);
                break;
            case "Table":
                ApplyTableProps(node);
                break;
            case "DisclosureGroup":
                ApplyDisclosureGroupProps(node, (Expander)element);
                break;
            case "SearchField":
                ApplySearchFieldProps(node, (AutoSuggestBox)element);
                break;
            case "DatePicker":
                ApplyDatePickerProps(node, element);
                break;
            case "Stepper":
                ApplyStepperProps(node, (NumberBox)element);
                break;
            case "TextEditor":
                ApplyTextEditorProps(node, (TextBox)element);
                break;
            case "Link":
                // Label content refreshes via RefreshLabel; nothing kind-specific.
                break;
            case "Label":
                ApplyLabelProps(node);
                break;
        }
    }

    private void ApplyTextProps(NatuiNode node)
    {
        if (node.Label is { } label)
        {
            ApplyTextStyle(
                node,
                label,
                node.Kind == "#text" ? node.Text : node.JoinedText());
        }
        if (node.Kind != "Text" || node.Children.All(child => child.Kind == "#text")) return;

        // Raw text fragments in a mixed Text have no props of their own.
        // They inherit the enclosing Text's typography in SwiftUI, so apply
        // that style explicitly to their retained WinUI TextBlocks.
        foreach (var child in node.Children)
        {
            if (child.Kind == "#text" && child.Label is { } fragment)
            {
                ApplyTextStyle(node, fragment, child.Text);
            }
        }
    }

    private static void ApplyTextStyle(NatuiNode style, TextBlock label, string text)
    {
        label.Text = text;
        var (fontSize, fontWeight) = style.Str("font") switch
        {
            "largeTitle" => (28.0, (FontWeight?)FontWeights.SemiBold),
            "title" => (22.0, (FontWeight?)null),
            "title2" => (18.0, (FontWeight?)null),
            "title3" => (16.0, (FontWeight?)null),
            "headline" => (14.0, (FontWeight?)FontWeights.SemiBold),
            "callout" => (13.0, (FontWeight?)null),
            "caption" => (12.0, (FontWeight?)null),
            _ => (14.0, (FontWeight?)null), // body / default
        };
        label.FontSize = style.Num("size") ?? fontSize;

        var weight = style.Str("weight") switch
        {
            "regular" => (FontWeight?)FontWeights.Normal,
            "medium" => FontWeights.Medium,
            "semibold" => FontWeights.SemiBold,
            "bold" => FontWeights.Bold,
            _ => null,
        } ?? fontWeight;
        label.FontWeight = weight ?? FontWeights.Normal;

        label.FontStyle = style.Flag("italic")
            ? Windows.UI.Text.FontStyle.Italic
            : Windows.UI.Text.FontStyle.Normal;
        label.TextDecorations = style.Flag("strikethrough")
            ? Windows.UI.Text.TextDecorations.Strikethrough
            : Windows.UI.Text.TextDecorations.None;

        if (style.Flag("monospaced")) label.FontFamily = new FontFamily("Consolas");
        else label.ClearValue(TextBlock.FontFamilyProperty);

        label.MaxLines = style.Num("lineLimit") is { } limit ? (int)limit : 0;
    }

    private static void ApplyButtonProps(NatuiNode node, Button button)
    {
        var style = node.Str("variant") switch
        {
            "bordered" => ButtonStyleResource("DefaultButtonStyle"),
            "prominent" => ButtonStyleResource("AccentButtonStyle"),
            "plain" => PlainButtonStyle(),
            "link" => ButtonStyleResource("TextBlockButtonStyle"),
            _ => null,
        };
        if (style is not null) button.Style = style;
        else button.ClearValue(FrameworkElement.StyleProperty);
    }

    private static Style? _plainButtonStyle;

    private static Style? PlainButtonStyle()
    {
        if (_plainButtonStyle is not null) return _plainButtonStyle;
        if (ButtonStyleResource("DefaultButtonStyle") is not { } defaultStyle) return null;

        var style = new Style(typeof(Button)) { BasedOn = defaultStyle };
        style.Setters.Add(new Setter(
            Control.BackgroundProperty,
            new SolidColorBrush(Microsoft.UI.Colors.Transparent)));
        style.Setters.Add(new Setter(
            Control.BorderBrushProperty,
            new SolidColorBrush(Microsoft.UI.Colors.Transparent)));
        style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(0)));
        style.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(0)));
        _plainButtonStyle = style;
        return style;
    }

    private static Style? ButtonStyleResource(string key)
    {
        try
        {
            return Application.Current.Resources[key] as Style;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void ApplyPickerProps(NatuiNode node, FrameworkElement element)
    {
        switch (element)
        {
            case ComboBox combo:
                ApplyComboPickerProps(node, combo);
                break;
            case RadioButtons radios:
                ApplyRadioPickerProps(node, radios);
                break;
            default:
                // SelectorBar (segmented), isolated in NodeMapper.Inputs.cs.
                ApplySegmentedPickerProps(node, element);
                break;
        }
    }

    private static void ApplyComboPickerProps(NatuiNode node, ComboBox combo)
    {
        combo.Header = node.Str("label");
        // Rebuilding fires SelectionChanged; the _applyingRemote guard active
        // in ApplyProps keeps it silent.
        combo.Items.Clear();
        var value = node.Str("value") ?? "";
        var selectedIndex = -1;
        var options = Json.Arr(node.Props, "options") ?? [];
        for (var i = 0; i < options.Count; i++)
        {
            var option = options[i] as JsonObject;
            var optionValue = Json.Str(option, "value") ?? "";
            combo.Items.Add(new ComboBoxItem
            {
                Content = Json.Str(option, "label") ?? "",
                Tag = optionValue,
            });
            if (optionValue == value) selectedIndex = i;
        }
        combo.SelectedIndex = selectedIndex;
    }

    private static void ApplyProgressProps(NatuiNode node, Grid container)
    {
        if (node.Num("value") is { } value)
        {
            if (container.Children.Count != 1 || container.Children[0] is not ProgressBar bar)
            {
                container.Children.Clear();
                bar = new ProgressBar();
                container.Children.Add(bar);
            }
            bar.Minimum = 0;
            bar.Maximum = 1;
            bar.Value = Math.Clamp(value, 0, 1);
        }
        else
        {
            if (container.Children.Count != 1 || container.Children[0] is not ProgressRing ring)
            {
                container.Children.Clear();
                ring = new ProgressRing();
                container.Children.Add(ring);
            }
            ring.IsActive = true;
        }
    }

    // -- teardown ----------------------------------------------------------------

    /// <summary>
    /// Called by NodeStore right before a node is destroyed: tears down
    /// Hosted objects that live outside the visual tree (an open dialog in a
    /// removed subtree would otherwise stay visible forever).
    /// </summary>
    public void WillDestroy(NatuiNode node)
    {
        switch (node.Kind)
        {
            case "MenuBar" or "Toolbar":
                if (node.Hosted is UIElement chrome) ChromePanel.Children.Remove(chrome);
                break;
            case "Sheet":
                _sheetNodes.Remove(node.Id);
                _pendingSheets.Remove(node.Id);
                _sheetXamlRootRetries.Remove(node.Id);
                if (node.Hosted is ContentDialog sheet && _openSheets.Contains(node.Id))
                {
                    _sheetClosingRemote.Add(node.Id);
                    sheet.Hide();
                }
                break;
            case "Alert":
                _alertNodes.Remove(node.Id);
                _pendingAlerts.Remove(node.Id);
                if (node.Hosted is ContentDialog dialog && _openAlerts.Contains(node.Id))
                {
                    _alertClosingRemote.Add(node.Id);
                    dialog.Hide();
                }
                break;
            case "Popover":
                if (node.Hosted is Microsoft.UI.Xaml.Controls.Flyout flyout)
                {
                    _popoverClosingRemote.Add(node.Id);
                    flyout.Hide();
                }
                break;
        }
        node.Hosted = null;
        _contentSurface.Remove(node.Id);
        _tableParts.Remove(node.Id);
        _toolbarLayouts.Remove(node.Id);
        ReleaseListRow(node);
    }

    // -- common props ----------------------------------------------------------------

    private void ApplyCommonProps(NatuiNode node, FrameworkElement shell, FrameworkElement inner)
    {
        // macOS modifier order: padding → background → cornerRadius clip →
        // frame. The first three shape the inner box; the frame sizes the
        // outer shell, so a background fills the padded bounds and never
        // bleeds into frame-added space.
        ApplyPadding(inner, ParsePadding(node));
        ApplyBackground(inner, BrushFromHex(node.Str("background")));
        ApplyCornerRadius(inner, node.Num("cornerRadius"));
        ApplyFrame(node, shell);
        SyncInnerAlignment(node);
        shell.Opacity = node.Num("opacity") ?? 1.0;
        shell.Visibility = node.Flag("hidden") ? Visibility.Collapsed : Visibility.Visible;
        var enabled = !node.Flag("disabled");
        if (inner is Control control) control.IsEnabled = enabled;
        else if (inner is NatuiSplitView splitView) splitView.NativeSplit.IsEnabled = enabled;
        ApplyForeground(node, inner);
        ToolTipService.SetToolTip(shell, node.Str("help"));
        ApplyAutomationProps(node);
    }

    /// <summary>
    /// Alignment of the inner element inside its frame shell. Greedy kinds
    /// fill the frame (a TextField expands to the proposed width in SwiftUI
    /// too); everything else floats at SwiftUI's default frame alignment
    /// (center), except List rows, which lead-align like SwiftUI list rows.
    /// Also called by NatuiStack when a stack's greediness changes.
    /// </summary>
    public static void SyncInnerAlignment(NatuiNode node)
    {
        if (node.Inner is not { } inner) return;
        var fillsH = node.Kind is "Spacer" or "Divider"
            || NatuiStack.GreedyHorizontalKinds.Contains(node.Kind)
            || inner is NatuiStack { HGreedy: true }
            || inner is NatuiZStack { HGreedy: true };
        var fillsV = node.Kind is "Spacer" or "Divider"
            || NatuiStack.GreedyVerticalKinds.Contains(node.Kind)
            || inner is NatuiStack { VGreedy: true }
            || inner is NatuiZStack { VGreedy: true };
        inner.HorizontalAlignment = fillsH ? HorizontalAlignment.Stretch
            : node.InList ? HorizontalAlignment.Left
            : HorizontalAlignment.Center;
        inner.VerticalAlignment =
            fillsV ? VerticalAlignment.Stretch : VerticalAlignment.Center;
    }

    private static void ApplyAutomationProps(NatuiNode node)
    {
        // Target the element that produces the UIA peer: the TextBlock for
        // Text/#text nodes, the inner control otherwise (the frame shell
        // Border has no automation peer of its own).
        FrameworkElement? target = node.Kind == "Text"
            && node.Inner is Border { Child: ContentControl mixedText }
                ? mixedText
                : node.Label
                    ?? (node.Kind == "Image"
                        && node.Inner is Border { Child: FrameworkElement image }
                            ? image
                            : node.Inner);
        if (target is null) return;
        SetOrClearString(target, AutomationProperties.NameProperty,
            node.Str("accessibilityLabel"));
        SetOrClearString(target, AutomationProperties.HelpTextProperty,
            node.Str("accessibilityHint"));
        SetOrClearString(target, AutomationProperties.AutomationIdProperty,
            node.Str("accessibilityIdentifier"));
    }

    private static void SetOrClearString(
        FrameworkElement element, DependencyProperty property, string? value)
    {
        // ClearValue rather than writing "" when absent, so controls fall
        // back to their default UIA name (e.g. a Button's content text).
        if (value is not null) element.SetValue(property, value);
        else element.ClearValue(property);
    }

    private static Thickness? ParsePadding(NatuiNode node)
    {
        if (node.Num("padding") is { } all) return new Thickness(all);
        if (Json.Obj(node.Props, "padding") is { } sides)
        {
            return new Thickness(
                Json.Num(sides, "leading") ?? 0,
                Json.Num(sides, "top") ?? 0,
                Json.Num(sides, "trailing") ?? 0,
                Json.Num(sides, "bottom") ?? 0);
        }
        return null;
    }

    private static void ApplyPadding(FrameworkElement element, Thickness? padding)
    {
        // ClearValue rather than writing zero when absent: controls carry
        // themed default padding a plain assignment would destroy.
        var property = element switch
        {
            Control => Control.PaddingProperty,
            Border => Border.PaddingProperty,
            Grid => Grid.PaddingProperty,
            TextBlock => TextBlock.PaddingProperty,
            _ => null,
        };
        if (property is null) return;
        if (padding is { } value) element.SetValue(property, value);
        else element.ClearValue(property);
    }

    private static void ApplyBackground(FrameworkElement element, Brush? brush)
    {
        var property = element switch
        {
            Control => Control.BackgroundProperty,
            Panel => Panel.BackgroundProperty,
            Border => Border.BackgroundProperty,
            _ => null,
        };
        if (property is null) return;
        // The Divider's subtle line color is its Background; never clear it.
        if (brush is null && (element.Tag as NatuiNode)?.Kind == "Divider") return;
        if (brush is not null) element.SetValue(property, brush);
        else element.ClearValue(property);
    }

    private static void ApplyCornerRadius(FrameworkElement element, double? radius)
    {
        var property = element switch
        {
            Control => Control.CornerRadiusProperty,
            Grid => Grid.CornerRadiusProperty,
            Border => Border.CornerRadiusProperty,
            _ => null,
        };
        if (property is null) return;
        if (radius is { } r) element.SetValue(property, new CornerRadius(r));
        else element.ClearValue(property);

        if (element is not Panel) return;
        element.SizeChanged -= UpdateRoundedPanelClip;
        if (radius is { } panelRadius)
        {
            element.SizeChanged += UpdateRoundedPanelClip;
            SetRoundedPanelClip(element, panelRadius);
        }
        else
        {
            ElementCompositionPreview.GetElementVisual(element).Clip = null;
        }
    }

    private static void UpdateRoundedPanelClip(object sender, SizeChangedEventArgs _)
    {
        if (sender is FrameworkElement element
            && element.Tag is NatuiNode node
            && node.Num("cornerRadius") is { } radius)
        {
            SetRoundedPanelClip(element, radius);
        }
    }

    private static void SetRoundedPanelClip(FrameworkElement element, double radius)
    {
        var width = Math.Max(0, element.ActualWidth);
        var height = Math.Max(0, element.ActualHeight);
        var effectiveRadius = Math.Max(0, Math.Min(radius, Math.Min(width, height) / 2));
        var visual = ElementCompositionPreview.GetElementVisual(element);
        var geometry = visual.Compositor.CreateRoundedRectangleGeometry();
        geometry.Size = new Vector2((float)width, (float)height);
        geometry.CornerRadius = new Vector2((float)effectiveRadius);
        visual.Clip = visual.Compositor.CreateGeometricClip(geometry);
    }

    private static void ApplyFrame(NatuiNode node, FrameworkElement element)
    {
        var frame = Json.Obj(node.Props, "frame");
        element.Width = Json.Num(frame, "width") ?? double.NaN;
        element.Height = Json.Num(frame, "height") ?? double.NaN;
        element.MinWidth = Json.Num(frame, "minWidth") ?? 0;
        element.MinHeight = Json.Num(frame, "minHeight") ?? 0;
        // "infinity" means greedy on that axis; the parent NatuiStack turns
        // StretchH/StretchV into stretch alignment and star tracks. For other
        // parents (ZStack, ListView rows) the default Stretch alignment
        // already fills.
        node.StretchH = Json.Str(frame, "maxWidth") == "infinity";
        element.MaxWidth = node.StretchH
            ? double.PositiveInfinity
            : Json.Num(frame, "maxWidth") ?? double.PositiveInfinity;
        node.StretchV = Json.Str(frame, "maxHeight") == "infinity";
        element.MaxHeight = node.StretchV
            ? double.PositiveInfinity
            : Json.Num(frame, "maxHeight") ?? double.PositiveInfinity;
    }

    private static void ApplyForeground(NatuiNode node, FrameworkElement element)
    {
        var brush = EffectiveForeground(node);
        if (node.Label is { } label)
        {
            if (brush is not null) label.Foreground = brush;
            else label.ClearValue(TextBlock.ForegroundProperty);
        }

        switch (element)
        {
            case Border { Child: FontIcon image }:
                if (brush is not null) image.Foreground = brush;
                else image.ClearValue(IconElement.ForegroundProperty);
                break;
            case FontIcon icon:
                if (brush is not null) icon.Foreground = brush;
                else icon.ClearValue(IconElement.ForegroundProperty);
                break;
            case NatuiStack stack when node.Kind == "Label":
                foreach (var child in stack.Children)
                {
                    if (child is not FontIcon labelIcon) continue;
                    if (brush is not null) labelIcon.Foreground = brush;
                    else labelIcon.ClearValue(IconElement.ForegroundProperty);
                }
                break;
            case Control control:
                if (brush is not null) control.Foreground = brush;
                else control.ClearValue(Control.ForegroundProperty);
                break;
        }
    }

    private static Brush? EffectiveForeground(NatuiNode node)
    {
        for (NatuiNode? ancestor = node; ancestor is not null; ancestor = ancestor.Parent)
        {
            if (BrushFromHex(ancestor.Str("color")) is { } brush) return brush;
        }
        return DefaultForeground(node);
    }

    private static void ApplyForegroundTree(NatuiNode node)
    {
        if (node.Inner is { } inner) ApplyForeground(node, inner);
        ApplyForegroundToDescendants(node);
    }

    private static void ApplyForegroundToDescendants(NatuiNode node)
    {
        foreach (var child in node.Children) ApplyForegroundTree(child);
    }

    private static Brush? DefaultForeground(NatuiNode node) => node.Kind switch
    {
        // Caption text is secondary-colored, like SwiftUI's .caption.
        "Text" or "#text" when node.Str("font") == "caption" => SecondaryTextBrush(),
        // The system critical red, close to WinUI's destructive accents.
        "Button" when node.Str("role") == "destructive" =>
            new SolidColorBrush(Color.FromArgb(0xFF, 0xC4, 0x2B, 0x1C)),
        _ => null,
    };

    private static Brush SecondaryTextBrush() =>
        Theme.Resource<Brush>("TextFillColorSecondaryBrush")
        ?? new SolidColorBrush(Color.FromArgb(0xFF, 0x6E, 0x6E, 0x6E));

    private static Brush? BrushFromHex(string? hex) =>
        ColorFromHex(hex) is { } color ? new SolidColorBrush(color) : null;

    /// <summary>
    /// Protocol colors are #RRGGBB or #RRGGBBAA with alpha LAST, unlike
    /// WinUI's #AARRGGBB convention. Do not reorder.
    /// </summary>
    internal static Color? ColorFromHex(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        var s = hex.Trim().TrimStart('#');
        try
        {
            byte r, g, b;
            var a = (byte)0xFF;
            switch (s.Length)
            {
                case 6:
                    r = Convert.ToByte(s[..2], 16);
                    g = Convert.ToByte(s.Substring(2, 2), 16);
                    b = Convert.ToByte(s.Substring(4, 2), 16);
                    break;
                case 8:
                    r = Convert.ToByte(s[..2], 16);
                    g = Convert.ToByte(s.Substring(2, 2), 16);
                    b = Convert.ToByte(s.Substring(4, 2), 16);
                    a = Convert.ToByte(s.Substring(6, 2), 16);
                    break;
                default:
                    return null;
            }
            return Color.FromArgb(a, r, g, b);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // -- icons -------------------------------------------------------------------------

    // SF Symbols names to Segoe Fluent Icons glyphs (shared with MDL2 Assets).
    private static readonly Dictionary<string, string> Glyphs = new()
    {
        // Segoe has no atom glyph; Component (a chip) is the stand-in.
        ["atom"] = "\uE950",
        ["trash"] = "\uE74D",
        ["plus"] = "\uE710",
        ["minus"] = "\uE738",
        ["speaker.wave.2"] = "\uE767",
        ["checkmark"] = "\uE73E",
        ["xmark"] = "\uE711",
        ["gear"] = "\uE713",
        ["magnifyingglass"] = "\uE721",
        ["star"] = "\uE734",
        ["heart"] = "\uEB51",
        // App-shell set (kitchen-sink + common chrome), strings only.
        ["chevron.left"] = "\uE76B",
        ["chevron.right"] = "\uE76C",
        ["chevron.up"] = "\uE70E",
        ["chevron.down"] = "\uE70D",
        ["sidebar.left"] = "\uE89F", // DockLeft
        ["calendar"] = "\uE787",
        ["folder"] = "\uE8B7",
        ["archivebox"] = "\uE7B8", // Package
        ["info.circle"] = "\uE946",
        ["pencil"] = "\uE70F",
        ["square.and.arrow.up"] = "\uE72D", // Share
        ["arrow.clockwise"] = "\uE72C", // Refresh
        ["list.bullet"] = "\uE8FD",
        ["person"] = "\uE77B",
        ["bell"] = "\uEA8F",
        ["paperplane"] = "\uE724", // Send
        ["wrench.and.screwdriver"] = "\uE90F", // Repair
        ["plus.square.on.square"] = "\uE8C8", // Copy
        ["doc.on.doc"] = "\uE8C8",
        ["ellipsis"] = "\uE712",
        ["link"] = "\uE71B",
        ["clock"] = "\uE823",
        ["flag"] = "\uE7C1",
        ["tag"] = "\uE8EC",
    };

    private static string GlyphFor(string? systemName) =>
        systemName is not null && Glyphs.TryGetValue(systemName, out var glyph)
            ? glyph
            : "\uE9CE"; // circled question mark
}
