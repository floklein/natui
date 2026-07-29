using System.Text.Json.Nodes;
using NatuiHost;
using Xunit;

namespace NatuiHost.Tests;

/// <summary>
/// The protocol's seq/ack echo-suppression rule (docs/protocol.md): an update
/// that JavaScript produced before it saw the user's latest edit must not
/// overwrite the local value. Ops are parsed from text, like real inbound
/// messages, so the number handling matches production.
/// </summary>
public class EchoSuppressionTests
{
    [Fact]
    public void StaleAckKeepsTheLocalValue()
    {
        var store = NewStoreWithTextField();
        store.UserEdit(1, JsonValue.Create("local")); // LastSentSeq -> 1

        store.Apply(Ops("""[{"op":"update","id":1,"ack":0,"props":{"value":"remote"}}]"""));

        Assert.Equal("local", ValueOf(store));
    }

    [Fact]
    public void CurrentAckLetsJavaScriptWin()
    {
        var store = NewStoreWithTextField();
        store.UserEdit(1, JsonValue.Create("local")); // LastSentSeq -> 1

        store.Apply(Ops("""[{"op":"update","id":1,"ack":1,"props":{"value":"remote"}}]"""));

        Assert.Equal("remote", ValueOf(store));
    }

    [Fact]
    public void MissingAckLetsJavaScriptWin()
    {
        var store = NewStoreWithTextField();
        store.UserEdit(1, JsonValue.Create("local")); // LastSentSeq -> 1

        store.Apply(Ops("""[{"op":"update","id":1,"props":{"value":"remote"}}]"""));

        Assert.Equal("remote", ValueOf(store));
    }

    /// <summary>
    /// A cleared value is a local JSON null, which System.Text.Json models as
    /// a C# null. Suppression keys on the KEY BEING PRESENT, not on the value
    /// being non-null, or a stale echo would resurrect the old value.
    /// </summary>
    [Fact]
    public void StaleAckKeepsALocalJsonNull()
    {
        var store = NewStoreWithTextField();
        store.UserEdit(1, null); // LastSentSeq -> 1, value -> JSON null

        store.Apply(Ops("""[{"op":"update","id":1,"ack":0,"props":{"value":"remote"}}]"""));

        var props = PropsOf(store);
        Assert.True(props.ContainsKey("value"));
        Assert.Null(props["value"]);
    }

    // -- helpers ------------------------------------------------------------

    private static NodeStore NewStoreWithTextField()
    {
        var store = new NodeStore(new RecordingMapper());
        store.Apply(Ops("""
            [
              {"op":"create","id":1,"kind":"TextField","props":{"value":"initial"}},
              {"op":"append","parent":0,"child":1}
            ]
            """));
        return store;
    }

    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    private static JsonObject PropsOf(NodeStore store) =>
        store.DumpTree()["children"]!.AsArray()[0]!["props"]!.AsObject();

    private static string? ValueOf(NodeStore store) =>
        PropsOf(store)["value"]?.GetValue<string>();
}
