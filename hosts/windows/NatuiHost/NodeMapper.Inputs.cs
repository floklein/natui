using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace NatuiHost;

/// <summary>
/// Input kinds: SearchField (AutoSuggestBox), DatePicker (CalendarDatePicker,
/// date part only), Stepper (NumberBox), TextEditor (multiline TextBox), Link
/// (HyperlinkButton + Launcher), Label (icon + text), and the segmented
/// (SelectorBar) and radioGroup (RadioButtons) Picker styles.
/// </summary>
internal sealed partial class NodeMapper
{
    // -- SearchField --------------------------------------------------------------

    private AutoSuggestBox BuildSearchField(NatuiNode node)
    {
        var box = new AutoSuggestBox { QueryIcon = new SymbolIcon(Symbol.Find) };
        box.TextChanged += (_, args) =>
        {
            // Programmatic writes report a non-UserInput reason; the
            // _applyingRemote guard in OnTextInput covers the rest.
            if (args.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
            OnTextInput(node, box.Text);
        };
        box.QuerySubmitted += (_, _) => EmitSubmit(node);
        return box;
    }

    private void ApplySearchFieldProps(NatuiNode node, AutoSuggestBox box)
    {
        box.PlaceholderText = node.Str("placeholder") ?? "";
        var value = node.Str("value") ?? "";
        if (box.Text != value) box.Text = value;
    }

    // -- DatePicker ---------------------------------------------------------------

    // Only the date part is supported on Windows: displayedComponents time /
    // dateTime degrade to date (documented divergence). Fixed-format
    // invariant parsing keeps unchanged round-trips byte-identical, so the
    // props-equality guard settles.
    private static readonly string[] DateFormats = ["yyyy-MM-dd", "yyyy-MM-ddTHH:mm"];

    private CalendarDatePicker BuildDatePicker(NatuiNode node)
    {
        var picker = new CalendarDatePicker();
        picker.DateChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            if (picker.Date is not { } date)
            {
                // The protocol has no null DatePicker value from the user
                // side (macOS parity: SwiftUI's date is non-optional), so a
                // user clear snaps back to the prop value instead of
                // desyncing the control from JS.
                _applyingRemote++;
                try
                {
                    ApplyDatePickerProps(node, picker);
                }
                finally
                {
                    _applyingRemote--;
                }
                return;
            }
            var iso = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (iso == (node.Str("value") ?? "")) return;
            node.UserEdit(JsonValue.Create(iso));
        };
        return picker;
    }

    private void ApplyDatePickerProps(NatuiNode node, CalendarDatePicker picker)
    {
        var value = node.Str("value");
        if (value is null)
        {
            picker.Date = null;
            return;
        }
        if (!DateTime.TryParseExact(
                value, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None,
                out var parsed))
        {
            return; // unparseable: keep the current native state
        }
        // Compare as ISO before writing so an echo of our own change event
        // does not reset an equal date (and re-fire DateChanged).
        var current = picker.Date is { } date
            ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;
        var incoming = parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (current != incoming) picker.Date = new DateTimeOffset(parsed);
    }

    // -- Stepper ------------------------------------------------------------------

    private NumberBox BuildStepper(NatuiNode node)
    {
        var box = new NumberBox
        {
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline,
            SmallChange = 1,
            Minimum = double.MinValue,
            Maximum = double.MaxValue,
        };
        box.ValueChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            var value = box.Value; // NaN while the text is empty/invalid
            if (double.IsNaN(value)) return;
            if (value == (node.Num("value") ?? 0)) return;
            node.UserEdit(JsonValue.Create(value));
        };
        return box;
    }

    private void ApplyStepperProps(NatuiNode node, NumberBox box)
    {
        box.Minimum = node.Num("min") ?? double.MinValue;
        box.Maximum = node.Num("max") ?? double.MaxValue;
        box.SmallChange = node.Num("step") ?? 1;
        var value = node.Num("value") ?? 0;
        if (box.Value != value) box.Value = value;
    }

    // -- TextEditor ---------------------------------------------------------------

    private TextBox BuildTextEditor(NatuiNode node)
    {
        var box = new TextBox
        {
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
        };
        ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        box.TextChanged += (_, _) => OnTextInput(node, box.Text);
        return box;
    }

    private void ApplyTextEditorProps(NatuiNode node, TextBox box)
    {
        var value = node.Str("value") ?? "";
        if (box.Text != value) box.Text = value;
    }

    // -- Link ---------------------------------------------------------------------

    private FrameworkElement BuildLink(NatuiNode node)
    {
        // Label content refreshes via RefreshContent (Link is a LabelKind).
        var button = new HyperlinkButton();
        button.Click += (_, _) =>
        {
            // The press event is informative; the host opens the URL itself.
            Ipc.Event(node.Id, "press");
            try
            {
                var uri = new Uri(node.Str("url") ?? "");
                _ = Windows.System.Launcher.LaunchUriAsync(uri);
            }
            catch (Exception)
            {
                // Missing or invalid url: the press event already went out.
            }
        };
        return button;
    }

    // -- Label --------------------------------------------------------------------

    private FrameworkElement BuildLabel(NatuiNode node)
    {
        var icon = new FontIcon { FontFamily = IconFontFamily(), FontSize = 14 };
        var text = new TextBlock();
        // RefreshLabel's Label-first path writes the joined #text children.
        node.Label = text;
        var stack = new NatuiStack { Orientation = Orientation.Horizontal, Spacing = 6 };
        stack.Children.Add(icon);
        stack.Children.Add(text);
        stack.RebuildLayout();
        return stack;
    }

    private void ApplyLabelProps(NatuiNode node)
    {
        if (node.Inner is not NatuiStack stack || stack.Children.Count == 0) return;
        if (stack.Children[0] is FontIcon icon) icon.Glyph = GlyphFor(node.Str("systemImage"));
    }

    // -- Picker style "segmented" (SelectorBar) -----------------------------------

    // ALL SelectorBar API usage stays inside these two members so a compile
    // failure has a single fallback point (fallback: a horizontal StackPanel
    // of ToggleButtons). SelectorBar requires WinAppSDK 1.5+; the repo pins
    // 1.7.*.

    private FrameworkElement BuildSegmentedPicker(NatuiNode node)
    {
        var bar = new SelectorBar();
        bar.SelectionChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            var value = bar.SelectedItem?.Tag as string;
            if (value is null || value == (node.Str("value") ?? "")) return;
            node.UserEdit(JsonValue.Create(value));
        };
        return bar;
    }

    private void ApplySegmentedPickerProps(NatuiNode node, FrameworkElement element)
    {
        if (element is not SelectorBar bar) return;
        // Rebuild fires SelectionChanged; the ApplyProps guard keeps it silent.
        bar.Items.Clear();
        var value = node.Str("value") ?? "";
        SelectorBarItem? selected = null;
        foreach (var entry in Json.Arr(node.Props, "options") ?? [])
        {
            var option = entry as JsonObject;
            var item = new SelectorBarItem
            {
                Text = Json.Str(option, "label") ?? "",
                Tag = Json.Str(option, "value") ?? "",
            };
            bar.Items.Add(item);
            if ((item.Tag as string) == value) selected = item;
        }
        bar.SelectedItem = selected;
    }

    // -- Picker style "radioGroup" (RadioButtons) ---------------------------------

    private RadioButtons BuildRadioPicker(NatuiNode node)
    {
        var radios = new RadioButtons();
        radios.SelectionChanged += (_, _) =>
        {
            if (_applyingRemote > 0) return;
            var options = Json.Arr(node.Props, "options") ?? [];
            var index = radios.SelectedIndex;
            if (index < 0 || index >= options.Count) return;
            var value = Json.Str(options[index] as JsonObject, "value") ?? "";
            if (value == (node.Str("value") ?? "")) return;
            node.UserEdit(JsonValue.Create(value));
        };
        return radios;
    }

    private void ApplyRadioPickerProps(NatuiNode node, RadioButtons radios)
    {
        radios.Header = node.Str("label");
        // Items are plain option-label strings; selection maps by index.
        radios.Items.Clear();
        var value = node.Str("value") ?? "";
        var selectedIndex = -1;
        var options = Json.Arr(node.Props, "options") ?? [];
        for (var i = 0; i < options.Count; i++)
        {
            var option = options[i] as JsonObject;
            radios.Items.Add(Json.Str(option, "label") ?? "");
            if ((Json.Str(option, "value") ?? "") == value) selectedIndex = i;
        }
        radios.SelectedIndex = selectedIndex;
    }
}
