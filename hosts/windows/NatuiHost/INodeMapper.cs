namespace NatuiHost;

/// <summary>
/// What NodeStore needs from the mapper. NodeMapper is the only production
/// implementation; the seam exists because every NodeMapper instance owns
/// live WinUI controls, which cannot be activated outside a XAML runtime.
/// </summary>
internal interface INodeMapper
{
    void CreateElement(NatuiNode node);

    void ApplyProps(NatuiNode node);

    void TextChanged(NatuiNode textNode, NatuiNode? parent);

    void ClearRoot();

    void WillDestroy(NatuiNode node);

    void AttachVisual(int parentId, NatuiNode? parent, NatuiNode child, int index);

    void DetachVisual(int parentId, NatuiNode? parent, NatuiNode child);
}
