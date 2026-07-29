using System.Text.Json.Nodes;
using NatuiHost;
using Xunit;

namespace NatuiHost.Tests;

/// <summary>
/// Tree bookkeeping: remove destroys the whole subtree and clear empties the
/// root, and both drop the ids from the store's id and parent maps so later
/// ops naming them are no-ops.
/// </summary>
public class NodeStoreTests
{
    [Fact]
    public void RemoveDestroysTheSubtree()
    {
        var mapper = new RecordingMapper();
        var store = NewTree(mapper);

        store.Apply(Ops("""[{"op":"remove","child":2}]"""));

        // Leaf first: descendants are torn down before their parent.
        Assert.Equal(new[] { 3, 2 }, mapper.Destroyed);
        Assert.Equal(new[] { 1 }, RootChildIds(store));
    }

    [Fact]
    public void RemoveForgetsTheRemovedIds()
    {
        var mapper = new RecordingMapper();
        var store = NewTree(mapper);
        store.Apply(Ops("""[{"op":"remove","child":2}]"""));
        mapper.PropsApplied.Clear();
        mapper.TextChanges.Clear();

        store.Apply(Ops("""
            [
              {"op":"update","id":2,"props":{"value":"ghost"}},
              {"op":"text","id":3,"text":"ghost"}
            ]
            """));

        Assert.Empty(mapper.PropsApplied);
        Assert.Empty(mapper.TextChanges);
    }

    [Fact]
    public void RemoveForgetsTheParentLink()
    {
        var mapper = new RecordingMapper();
        var store = NewTree(mapper);
        store.Apply(Ops("""[{"op":"remove","child":2}]"""));
        mapper.Attached.Clear();

        store.Apply(Ops("""[{"op":"append","parent":0,"child":2}]"""));

        Assert.Empty(mapper.Attached);
        Assert.Equal(new[] { 1 }, RootChildIds(store));
    }

    [Fact]
    public void ClearEmptiesTheRootAndForgetsEveryNode()
    {
        var mapper = new RecordingMapper();
        var store = NewTree(mapper);

        store.Apply(Ops("""[{"op":"clear"}]"""));

        Assert.Equal(1, mapper.RootCleared);
        Assert.Equal(new[] { 1, 2, 3 }, mapper.Destroyed.Order());
        Assert.Empty(RootChildIds(store));

        mapper.PropsApplied.Clear();
        store.Apply(Ops("""[{"op":"update","id":1,"props":{"value":"ghost"}}]"""));
        Assert.Empty(mapper.PropsApplied);
    }

    // -- helpers ------------------------------------------------------------

    /// <summary>root -> 1 (VStack) -> 2 (Text) -> 3 (#text).</summary>
    private static NodeStore NewTree(RecordingMapper mapper)
    {
        var store = new NodeStore(mapper);
        store.Apply(Ops("""
            [
              {"op":"create","id":1,"kind":"VStack"},
              {"op":"create","id":2,"kind":"Text"},
              {"op":"createText","id":3,"text":"hi"},
              {"op":"append","parent":0,"child":1},
              {"op":"append","parent":1,"child":2},
              {"op":"append","parent":2,"child":3}
            ]
            """));
        return store;
    }

    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    private static int[] RootChildIds(NodeStore store) =>
        store.DumpTree()["children"]!.AsArray()
            .Select(child => child!["id"]!.GetValue<int>())
            .ToArray();
}
