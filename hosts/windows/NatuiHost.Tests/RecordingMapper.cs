using NatuiHost;

namespace NatuiHost.Tests;

/// <summary>
/// INodeMapper stand-in that records what the store asked for. A real
/// NodeMapper owns WinUI controls, which cannot be activated outside a XAML
/// runtime, so this is how the store's pure bookkeeping is observed.
/// </summary>
internal sealed class RecordingMapper : INodeMapper
{
    public List<int> Created { get; } = [];
    public List<int> PropsApplied { get; } = [];
    public List<int> TextChanges { get; } = [];
    public List<int> Destroyed { get; } = [];
    public List<int> Attached { get; } = [];
    public List<int> Detached { get; } = [];
    public int RootCleared { get; private set; }

    public void CreateElement(NatuiNode node) => Created.Add(node.Id);

    public void ApplyProps(NatuiNode node) => PropsApplied.Add(node.Id);

    public void TextChanged(NatuiNode textNode, NatuiNode? parent) =>
        TextChanges.Add(textNode.Id);

    public void ClearRoot() => RootCleared++;

    public void WillDestroy(NatuiNode node) => Destroyed.Add(node.Id);

    public void AttachVisual(int parentId, NatuiNode? parent, NatuiNode child, int index) =>
        Attached.Add(child.Id);

    public void DetachVisual(int parentId, NatuiNode? parent, NatuiNode child) =>
        Detached.Add(child.Id);
}
