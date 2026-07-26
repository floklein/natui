using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace NatuiHost;

/// <summary>
/// WinUI has separate date and time controls. This stable pair represents the
/// protocol's combined dateTime mode while still using native pickers.
/// </summary>
internal sealed class NatuiDateTimePicker : Grid
{
    public CalendarDatePicker DatePicker { get; } = new();
    public TimePicker TimePicker { get; } = new() { MinuteIncrement = 1 };

    public NatuiDateTimePicker()
    {
        ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        ColumnSpacing = 8;
        SetColumn(DatePicker, 0);
        SetColumn(TimePicker, 1);
        Children.Add(DatePicker);
        Children.Add(TimePicker);
    }
}

/// <summary>
/// Input kinds: SearchField (AutoSuggestBox), DatePicker (native date, time, or
/// paired date/time controls), Stepper (NumberBox), TextEditor (multiline
/// TextBox), Link (HyperlinkButton + Launcher), Label (icon + text), and the
/// segmented (SelectorBar) and radioGroup (RadioButtons) Picker styles.
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

    private FrameworkElement BuildDatePicker(NatuiNode node)
    {
        switch (node.Str("displayedComponents"))
        {
            case "time":
            {
                var picker = new TimePicker { MinuteIncrement = 1 };
                picker.SelectedTimeChanged += (_, _) => OnDatePickerChanged(node, picker);
                return picker;
            }
            case "dateTime":
            {
                var picker = new NatuiDateTimePicker();
                picker.DatePicker.DateChanged += (_, _) => OnDatePickerChanged(node, picker);
                picker.TimePicker.SelectedTimeChanged += (_, _) => OnDatePickerChanged(node, picker);
                return picker;
            }
            default:
            {
                var picker = new CalendarDatePicker();
                picker.DateChanged += (_, _) => OnDatePickerChanged(node, picker);
                return picker;
            }
        }
    }

    private void OnDatePickerChanged(NatuiNode node, FrameworkElement picker)
    {
        if (_applyingRemote > 0) return;
        if (DatePickerValue(picker) is not { } value)
        {
            // The wire contract has no user-generated null DatePicker value,
            // matching SwiftUI's non-optional binding. A cleared native value
            // therefore snaps back to the controlled prop.
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
        if (value == (node.Str("value") ?? "")) return;
        node.UserEdit(JsonValue.Create(value));
    }

    private static string? DatePickerValue(FrameworkElement picker) => picker switch
    {
        CalendarDatePicker date when date.Date is { } value =>
            value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TimePicker time when time.SelectedTime is { } value =>
            string.Create(
                CultureInfo.InvariantCulture, $"{value.Hours:00}:{value.Minutes:00}"),
        NatuiDateTimePicker pair
            when pair.DatePicker.Date is { } date && pair.TimePicker.SelectedTime is { } time =>
            string.Create(
                CultureInfo.InvariantCulture,
                $"{date:yyyy-MM-dd}T{time.Hours:00}:{time.Minutes:00}"),
        _ => null,
    };

    private static void ApplyDatePickerProps(NatuiNode node, FrameworkElement picker)
    {
        var value = node.Str("value");
        switch (picker)
        {
            case CalendarDatePicker date:
                ApplyDateValue(value, date);
                date.IsEnabled = !node.Flag("disabled");
                break;
            case TimePicker time:
                ApplyTimeValue(value, time);
                time.IsEnabled = !node.Flag("disabled");
                break;
            case NatuiDateTimePicker pair:
                ApplyDateTimeValue(value, pair);
                pair.DatePicker.IsEnabled = !node.Flag("disabled");
                pair.TimePicker.IsEnabled = !node.Flag("disabled");
                break;
        }
    }

    private static void ApplyDateValue(string? value, CalendarDatePicker picker)
    {
        if (value is null)
        {
            picker.Date = null;
            return;
        }
        if (!DateTime.TryParseExact(
                value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None,
                out var parsed))
        {
            return;
        }
        var incoming = parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (DatePickerValue(picker) != incoming) picker.Date = new DateTimeOffset(parsed);
    }

    private static void ApplyTimeValue(string? value, TimePicker picker)
    {
        if (value is null)
        {
            picker.SelectedTime = null;
            return;
        }
        if (!DateTime.TryParseExact(
                value, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None,
                out var parsed))
        {
            return;
        }
        var incoming = new TimeSpan(parsed.Hour, parsed.Minute, 0);
        if (picker.SelectedTime != incoming) picker.SelectedTime = incoming;
    }

    private static void ApplyDateTimeValue(string? value, NatuiDateTimePicker picker)
    {
        if (value is null)
        {
            picker.DatePicker.Date = null;
            picker.TimePicker.SelectedTime = null;
            return;
        }
        if (!DateTime.TryParseExact(
                value, "yyyy-MM-dd'T'HH:mm", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsed))
        {
            return;
        }
        var date = parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (picker.DatePicker.Date is not { } current
            || current.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != date)
        {
            picker.DatePicker.Date = new DateTimeOffset(parsed.Date);
        }
        var time = new TimeSpan(parsed.Hour, parsed.Minute, 0);
        if (picker.TimePicker.SelectedTime != time) picker.TimePicker.SelectedTime = time;
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
    // of ToggleButtons). SelectorBar requires WinAppSDK 1.5+.

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
