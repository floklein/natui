using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
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
            var crossStretch = IsCrossStretch(node, vertical);
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
            var ancestor = Parent as NatuiStack ?? (Parent as Border)?.Parent as NatuiStack;
            ancestor?.RebuildLayout();
        }
    }

    // Stack children are the nodes' frame shells, so nested-stack greediness
    // is read through node.Inner rather than the child element itself.
    private static bool IsMainStar(NatuiNode? node, bool vertical)
    {
        if (node is null) return false;
        if (node.Kind == "Spacer") return true;
        return vertical
            ? node.StretchV || GreedyVerticalKinds.Contains(node.Kind)
                || node.Inner is NatuiStack { VGreedy: true }
            : node.StretchH || GreedyHorizontalKinds.Contains(node.Kind)
                || node.Inner is NatuiStack { HGreedy: true };
    }

    private static bool IsCrossStretch(NatuiNode? node, bool vertical)
    {
        if (node is null) return false;
        if (node.Kind == "Divider") return true;
        return vertical
            ? node.StretchH || GreedyHorizontalKinds.Contains(node.Kind)
                || node.Inner is NatuiStack { HGreedy: true }
            : node.StretchV || GreedyVerticalKinds.Contains(node.Kind)
                || node.Inner is NatuiStack { VGreedy: true };
    }

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
/// Builds WinUI elements for nodes, applies props, refreshes labels, and wires
/// user events back to the protocol channel. UI thread only. The app-shell
/// kinds live in the NodeMapper.*.cs partials (Menus, Overlays, Structure,
/// Inputs).
/// </summary>
internal sealed partial class NodeMapper(
    NatuiStack rootStack, StackPanel chromePanel, Grid overlayLayer)
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
        ["Text", "Button", "Toggle", "Link", "Label"];

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
        "ZStack" => new Grid(),
        "Text" or "#text" => BuildText(node),
        "Button" => BuildButton(node),
        "TextField" => BuildTextField(node),
        "Toggle" => BuildToggle(node),
        "Slider" => BuildSlider(node),
        "Picker" => BuildPicker(node),
        "ScrollView" => BuildScrollView(node),
        "List" => BuildList(node),
        "Image" => new FontIcon { FontFamily = IconFontFamily() },
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

    private static Button BuildButton(NatuiNode node)
    {
        var button = new Button();
        button.Click += (_, _) => Ipc.Event(node.Id, "press");
        return button;
    }

    private FrameworkElement BuildTextField(NatuiNode node)
    {
        // The secure flag is fixed at creation; flipping it later would need
        // an element swap and is not supported.
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
        // The style is fixed at creation (like TextField's secure flag):
        // flipping it later would need an element swap.
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
        // Style is fixed at creation, like Toggle's.
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

    private static FontFamily IconFontFamily()
    {
        try
        {
            if (Application.Current.Resources["SymbolThemeFontFamily"] is FontFamily family)
            {
                return family;
            }
        }
        catch (Exception)
        {
            // Resource lookup throws on a missing key; fall through.
        }
        return new FontFamily("Segoe MDL2 Assets");
    }

    // -- attach / detach ----------------------------------------------------------

    public void AttachVisual(int parentId, NatuiNode? parent, NatuiNode child, int index)
    {
        if (parent is not null && LabelKinds.Contains(parent.Kind))
        {
            RefreshLabel(parent);
            return;
        }
        if (!IsAttachable(parentId, parent, child)) return;
        // Slot-routed parents (SplitView/TabView/Popover) place children by
        // KIND, not index; see NodeMapper.Structure.cs / Overlays.cs.
        if (parent is not null && AttachToSlottedParent(parent, child)) return;
        var element = EnsureElement(child);
        switch (ParentSurface(parentId, parent))
        {
            case NatuiStack stack:
                stack.Children.Insert(index, element);
                stack.RebuildLayout();
                break;
            case Panel panel: // ZStack: overlapping children, no tracks
                panel.Children.Insert(index, element);
                break;
            case ListView list:
                // SwiftUI list rows lead-align their content.
                child.InList = true;
                SyncInnerAlignment(child);
                list.Items.Insert(index, element);
                break;
            case null:
                // Parent kind cannot hold visual children; the Swift host
                // silently ignores them too.
                break;
        }
    }

    public void DetachVisual(int parentId, NatuiNode? parent, NatuiNode child)
    {
        if (parent is not null && LabelKinds.Contains(parent.Kind))
        {
            RefreshLabel(parent);
            return;
        }
        if (parent is not null && DetachFromSlottedParent(parent, child)) return;
        if (child.Element is not { } element) return;
        switch (ParentSurface(parentId, parent))
        {
            case NatuiStack stack:
                stack.Children.Remove(element);
                stack.RebuildLayout();
                break;
            case Panel panel:
                panel.Children.Remove(element);
                break;
            case ListView list:
                child.InList = false;
                SyncInnerAlignment(child); // drop the list-row lead alignment
                list.Items.Remove(element);
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
    /// WinUI is retained, not reactive: when #text children change, the parent
    /// Text/Button/Toggle must recompute its label by hand.
    /// </summary>
    public void TextChanged(NatuiNode textNode, NatuiNode? parent)
    {
        if (textNode.Label is { } label) label.Text = textNode.Text; // root-attached raw text
        if (parent is not null && LabelKinds.Contains(parent.Kind)) RefreshLabel(parent);
    }

    private void RefreshLabel(NatuiNode node)
    {
        _applyingRemote++;
        try
        {
            // node.Label first: covers Text-in-Border AND the Label kind
            // (whose Inner is a NatuiStack around icon + TextBlock).
            if (node.Label is { } label)
            {
                label.Text = node.JoinedText();
                return;
            }
            switch (node.Inner)
            {
                case ToggleSwitch toggle: // Toggle style="switch"
                    toggle.Header = node.JoinedText();
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
        var stack = new NatuiStack { Orientation = Orientation.Horizontal, Spacing = 4 };
        foreach (var child in node.Children) stack.Children.Add(EnsureElement(child));
        stack.RebuildLayout();
        control.Content = stack;
    }

    // -- prop application ------------------------------------------------------------

    public void ApplyProps(NatuiNode node)
    {
        if (node.Element is not { } shell || node.Inner is not { } inner) return;
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
        // Frame stretch, spacing, or spacer changes affect the parent's tracks.
        if (shell.Parent is NatuiStack parent) parent.RebuildLayout();
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
                var icon = (FontIcon)element;
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
                ApplySplitViewProps(node, (SplitView)element);
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
                ApplyDatePickerProps(node, (CalendarDatePicker)element);
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
        var label = node.Label!;
        label.Text = node.Kind == "#text" ? node.Text : node.JoinedText();

        var (fontSize, fontWeight) = node.Str("font") switch
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
        label.FontSize = node.Num("size") ?? fontSize;

        var weight = node.Str("weight") switch
        {
            "regular" => (FontWeight?)FontWeights.Normal,
            "medium" => FontWeights.Medium,
            "semibold" => FontWeights.SemiBold,
            "bold" => FontWeights.Bold,
            _ => null,
        } ?? fontWeight;
        label.FontWeight = weight ?? FontWeights.Normal;

        label.FontStyle = node.Flag("italic")
            ? Windows.UI.Text.FontStyle.Italic
            : Windows.UI.Text.FontStyle.Normal;
        label.TextDecorations = node.Flag("strikethrough")
            ? Windows.UI.Text.TextDecorations.Strikethrough
            : Windows.UI.Text.TextDecorations.None;

        if (node.Flag("monospaced")) label.FontFamily = new FontFamily("Consolas");
        else label.ClearValue(TextBlock.FontFamilyProperty);

        label.MaxLines = node.Num("lineLimit") is { } limit ? (int)limit : 0;
    }

    private static void ApplyButtonProps(NatuiNode node, Button button)
    {
        if (node.Str("variant") == "prominent" && AccentButtonStyle() is { } accent)
        {
            button.Style = accent;
        }
        else
        {
            // Back to the implicit default style (bordered/plain/link render
            // as standard buttons for now).
            button.ClearValue(FrameworkElement.StyleProperty);
        }
    }

    private static Style? AccentButtonStyle()
    {
        try
        {
            return Application.Current.Resources["AccentButtonStyle"] as Style;
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
                if (node.Hosted is UIElement overlay) OverlayLayer.Children.Remove(overlay);
                break;
            case "Alert":
                if (node.Hosted is ContentDialog dialog)
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
        if (inner is Control control) control.IsEnabled = !node.Flag("disabled");
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
            || inner is NatuiStack { HGreedy: true };
        var fillsV = node.Kind is "Spacer" or "Divider"
            || NatuiStack.GreedyVerticalKinds.Contains(node.Kind)
            || inner is NatuiStack { VGreedy: true };
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
        FrameworkElement? target = node.Label ?? node.Inner;
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
        var brush = BrushFromHex(node.Str("color")) ?? DefaultForeground(node);
        switch (element)
        {
            case Border when node.Label is { } label:
                if (brush is not null) label.Foreground = brush;
                else label.ClearValue(TextBlock.ForegroundProperty);
                break;
            case FontIcon icon:
                if (brush is not null) icon.Foreground = brush;
                else icon.ClearValue(IconElement.ForegroundProperty);
                break;
            case Control control:
                if (brush is not null) control.Foreground = brush;
                else control.ClearValue(Control.ForegroundProperty);
                break;
        }
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

    private static Brush SecondaryTextBrush()
    {
        try
        {
            if (Application.Current.Resources["TextFillColorSecondaryBrush"] is Brush brush)
            {
                return brush;
            }
        }
        catch (Exception)
        {
            // Resource lookup throws on a missing key; fall through.
        }
        return new SolidColorBrush(Color.FromArgb(0xFF, 0x6E, 0x6E, 0x6E));
    }

    /// <summary>
    /// Protocol colors are #RRGGBB or #RRGGBBAA with alpha LAST, unlike
    /// WinUI's #AARRGGBB convention. Do not reorder.
    /// </summary>
    private static Brush? BrushFromHex(string? hex)
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
            return new SolidColorBrush(Color.FromArgb(a, r, g, b));
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
