using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace NatuiHost;

/// <summary>
/// Typed accessors over loosely-typed protocol JSON. Wrong-typed values read
/// as absent, mirroring the Swift host's JSONValue accessors.
/// </summary>
internal static class Json
{
    public static string? Str(JsonObject? obj, string key) =>
        obj?[key] is { } n && n.GetValueKind() == JsonValueKind.String ? n.GetValue<string>() : null;

    public static double? Num(JsonObject? obj, string key) =>
        obj?[key] is { } n && n.GetValueKind() == JsonValueKind.Number ? n.GetValue<double>() : null;

    public static int? Int(JsonObject? obj, string key) =>
        Num(obj, key) is { } d ? (int)d : null;

    public static bool? Bool(JsonObject? obj, string key) =>
        obj?[key] is { } n && n.GetValueKind() is JsonValueKind.True or JsonValueKind.False
            ? n.GetValue<bool>()
            : null;

    public static JsonObject? Obj(JsonObject? obj, string key) => obj?[key] as JsonObject;

    public static JsonArray? Arr(JsonObject? obj, string key) => obj?[key] as JsonArray;
}

/// <summary>One UI node: the retained model the WinUI elements are built from.</summary>
internal sealed class NatuiNode(int id, string kind)
{
    public int Id { get; } = id;
    public string Kind { get; } = kind;
    public JsonObject Props { get; set; } = [];
    public string Text { get; set; } = "";
    public List<NatuiNode> Children { get; } = [];

    /// <summary>Monotonic counter for optimistic local edits (protocol seq/ack).</summary>
    public int LastSentSeq;

    /// <summary>
    /// The WinUI element for this node. Null for #text nodes that only feed a
    /// parent label; they get an element lazily if attached to the root.
    /// </summary>
    public FrameworkElement? Element;

    /// <summary>Inner TextBlock for Text/#text nodes (Element is a Border shell).</summary>
    public TextBlock? Label;

    /// <summary>
    /// frame.maxWidth / frame.maxHeight was the string "infinity". The parent
    /// NatuiStack turns these into stretch alignment and star tracks.
    /// </summary>
    public bool StretchH;
    public bool StretchV;

    public string? Str(string key) => Json.Str(Props, key);
    public double? Num(string key) => Json.Num(Props, key);
    public bool Flag(string key) => Json.Bool(Props, key) ?? false;

    /// <summary>Concatenated #text children: the label of Text/Button/Toggle nodes.</summary>
    public string JoinedText() =>
        string.Concat(Children.Where(c => c.Kind == "#text").Select(c => c.Text));
}

/// <summary>
/// Node registry and op interpreter. Semantics mirror the Swift host's Store:
/// append/insert move an already-parented child, remove destroys the subtree,
/// update honors ack for echo suppression and skips structurally equal props.
/// Must only be touched on the UI thread.
/// </summary>
internal sealed class NodeStore(NodeMapper mapper)
{
    public const int RootId = 0;

    private readonly Dictionary<int, NatuiNode> _byId = [];
    private readonly Dictionary<int, int> _parentOf = []; // childId -> parentId (0 = root)
    private readonly List<NatuiNode> _rootChildren = [];

    public void Apply(JsonArray ops)
    {
        foreach (var item in ops)
        {
            if (item is not JsonObject op) continue;
            switch (Json.Str(op, "op"))
            {
                case "create":
                {
                    if (Json.Int(op, "id") is not { } id || Json.Str(op, "kind") is not { } kind) break;
                    var node = new NatuiNode(id, kind) { Props = Json.Obj(op, "props") ?? [] };
                    _byId[id] = node;
                    mapper.CreateElement(node);
                    break;
                }
                case "createText":
                {
                    if (Json.Int(op, "id") is not { } id) break;
                    _byId[id] = new NatuiNode(id, "#text") { Text = Json.Str(op, "text") ?? "" };
                    break;
                }
                case "append":
                {
                    if (Json.Int(op, "parent") is not { } parent
                        || Json.Int(op, "child") is not { } child
                        || !_byId.TryGetValue(child, out var node)) break;
                    Detach(child);
                    ChildrenOf(parent)?.Add(node);
                    _parentOf[child] = parent;
                    AttachVisual(parent, node);
                    break;
                }
                case "insert":
                {
                    if (Json.Int(op, "parent") is not { } parent
                        || Json.Int(op, "child") is not { } child
                        || Json.Int(op, "before") is not { } before
                        || !_byId.TryGetValue(child, out var node)) break;
                    Detach(child);
                    if (ChildrenOf(parent) is { } siblings)
                    {
                        var index = siblings.FindIndex(c => c.Id == before);
                        if (index >= 0) siblings.Insert(index, node);
                        else siblings.Add(node);
                    }
                    _parentOf[child] = parent;
                    AttachVisual(parent, node);
                    break;
                }
                case "remove":
                {
                    if (Json.Int(op, "child") is not { } child) break;
                    Detach(child);
                    Destroy(child);
                    break;
                }
                case "update":
                {
                    if (Json.Int(op, "id") is not { } id
                        || !_byId.TryGetValue(id, out var node)
                        || Json.Obj(op, "props") is not { } props) break;
                    // Echo suppression: if the user edited since JS produced
                    // this update, keep the local value (docs/protocol.md).
                    if (Json.Int(op, "ack") is { } ack && node.LastSentSeq > ack
                        && node.Props["value"] is { } local)
                    {
                        props["value"] = local.DeepClone();
                    }
                    // Skip structurally equal props: rewriting an equal string
                    // into a TextBox still resets the caret and selection.
                    if (!JsonNode.DeepEquals(props, node.Props))
                    {
                        node.Props = props;
                        mapper.ApplyProps(node);
                    }
                    break;
                }
                case "text":
                {
                    if (Json.Int(op, "id") is not { } id
                        || !_byId.TryGetValue(id, out var node)
                        || Json.Str(op, "text") is not { } text) break;
                    if (node.Text == text) break;
                    node.Text = text;
                    mapper.TextChanged(node, ParentNodeOf(id));
                    break;
                }
                case "clear":
                {
                    var removed = _rootChildren.ToList();
                    _rootChildren.Clear();
                    mapper.ClearRoot();
                    foreach (var child in removed)
                    {
                        _parentOf.Remove(child.Id);
                        Destroy(child.Id);
                    }
                    break;
                }
                default:
                    Ipc.Log($"unknown op: {Json.Str(op, "op")}");
                    break;
            }
        }
    }

    // -- tree bookkeeping -----------------------------------------------------

    private List<NatuiNode>? ChildrenOf(int parentId) =>
        parentId == RootId ? _rootChildren : _byId.GetValueOrDefault(parentId)?.Children;

    private NatuiNode? ParentNodeOf(int childId) =>
        _parentOf.TryGetValue(childId, out var parentId) && parentId != RootId
            ? _byId.GetValueOrDefault(parentId)
            : null;

    private void Detach(int childId)
    {
        if (!_parentOf.TryGetValue(childId, out var parentId)) return;
        ChildrenOf(parentId)?.RemoveAll(c => c.Id == childId);
        _parentOf.Remove(childId);
        if (_byId.TryGetValue(childId, out var node))
        {
            mapper.DetachVisual(parentId, _byId.GetValueOrDefault(parentId), node);
        }
    }

    private void Destroy(int id)
    {
        if (!_byId.TryGetValue(id, out var node)) return;
        foreach (var child in node.Children)
        {
            _parentOf.Remove(child.Id);
            Destroy(child.Id);
        }
        _byId.Remove(id);
    }

    private void AttachVisual(int parentId, NatuiNode child)
    {
        var parent = parentId == RootId ? null : _byId.GetValueOrDefault(parentId);
        if (parentId != RootId && parent is null) return;
        mapper.AttachVisual(parentId, parent, child, VisualIndexOf(parentId, child));
    }

    /// <summary>
    /// Index of the child among the parent's visually attached children.
    /// Label-consumed #text nodes never occupy a visual slot.
    /// </summary>
    private int VisualIndexOf(int parentId, NatuiNode child)
    {
        var index = 0;
        foreach (var sibling in ChildrenOf(parentId) ?? [])
        {
            if (ReferenceEquals(sibling, child)) break;
            if (NodeMapper.IsAttachable(parentId, sibling)) index++;
        }
        return index;
    }

    // -- debug dump -------------------------------------------------------------

    public JsonObject DumpTree()
    {
        static JsonObject Dump(NatuiNode node)
        {
            var obj = new JsonObject { ["id"] = node.Id, ["kind"] = node.Kind };
            if (node.Kind == "#text")
            {
                obj["text"] = node.Text;
            }
            else
            {
                obj["props"] = node.Props.DeepClone().AsObject();
                obj["children"] = new JsonArray(node.Children.Select(c => (JsonNode)Dump(c)).ToArray());
            }
            return obj;
        }

        return new JsonObject
        {
            ["id"] = RootId,
            ["kind"] = "#root",
            ["children"] = new JsonArray(_rootChildren.Select(c => (JsonNode)Dump(c)).ToArray()),
        };
    }
}
