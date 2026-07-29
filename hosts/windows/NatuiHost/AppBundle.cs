using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;

namespace NatuiHost;

internal sealed record PackagedApp(
    string Id,
    string Name,
    string Version,
    string SourceName,
    string Source);

/// <summary>
/// Resolves and validates the packaged application stored beside the
/// self-contained host. Development --bundle launches are available only
/// when the host has no embedded application.
/// </summary>
internal static class AppBundle
{
    private const int SchemaVersion = 1;
    private const int ProtocolVersion = 1;
    private const int HostApiVersion = 2;

    private const string ManifestResource = "NatuiHost.App.manifest.json";
    private const string ScriptResource = "NatuiHost.App.main.js";

    private static Assembly HostAssembly => typeof(AppBundle).Assembly;

    public static bool IsEmbedded =>
        HostAssembly.GetManifestResourceInfo(ManifestResource) is not null;

    public static bool TryLoad(out PackagedApp? app, out string? error)
    {
        app = null;
        error = null;
        JsonObject manifest;
        try
        {
            using var stream = HostAssembly.GetManifestResourceStream(ManifestResource)
                ?? throw new InvalidDataException("embedded manifest resource is missing");
            manifest = JsonNode.Parse(stream) as JsonObject
                ?? throw new InvalidDataException("manifest root is not an object");
        }
        catch (Exception ex)
        {
            error = $"Cannot read the embedded app manifest: {ex.Message}";
            return false;
        }

        if (Int(manifest, "schemaVersion") != SchemaVersion)
        {
            error = $"Unsupported app bundle schema {Value(manifest, "schemaVersion")}; "
                + $"this host supports schema {SchemaVersion}.";
            return false;
        }
        if (Int(manifest, "protocolVersion") != ProtocolVersion)
        {
            error = $"App requires protocol {Value(manifest, "protocolVersion")}; "
                + $"this host implements protocol {ProtocolVersion}.";
            return false;
        }
        if (Int(manifest, "minHostApi") is not { } minimumHostApi
            || minimumHostApi < 1
            || minimumHostApi > HostApiVersion)
        {
            error = $"App requires host API {Value(manifest, "minHostApi")}; "
                + $"this host implements API {HostApiVersion}.";
            return false;
        }
        if (Str(manifest, "platform") != "windows")
        {
            error = $"App bundle targets {Value(manifest, "platform")}, not windows.";
            return false;
        }

        var expectedArchitecture = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.Arm64 => "arm64",
            _ => null,
        };
        if (expectedArchitecture is null
            || Str(manifest, "architecture") != expectedArchitecture)
        {
            error = $"App bundle targets {Value(manifest, "architecture")}; "
                + $"this host is {expectedArchitecture ?? RuntimeInformation.ProcessArchitecture.ToString()}.";
            return false;
        }

        var id = Str(manifest, "id");
        var name = Str(manifest, "name");
        var version = Str(manifest, "version");
        var entry = Str(manifest, "entry");
        var expectedHash = Str(manifest, "entrySha256");
        if (string.IsNullOrWhiteSpace(id)
            || string.IsNullOrWhiteSpace(name)
            || string.IsNullOrWhiteSpace(version)
            || string.IsNullOrWhiteSpace(entry)
            || expectedHash is null
            || expectedHash.Length != 64)
        {
            error = "App manifest is missing identity, entry, or integrity fields.";
            return false;
        }

        if (entry != "main.js")
        {
            error = $"Invalid app entry {entry}; Windows single-file apps require main.js.";
            return false;
        }

        string source;
        byte[] sourceBytes;
        try
        {
            using var stream = HostAssembly.GetManifestResourceStream(ScriptResource)
                ?? throw new InvalidDataException("embedded main.js resource is missing");
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            sourceBytes = memory.ToArray();
            source = new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true).GetString(sourceBytes);
        }
        catch (Exception ex)
        {
            error = $"Cannot read the embedded app entry: {ex.Message}";
            return false;
        }

        try
        {
            var actualHash = Convert.ToHexString(
                SHA256.HashData(sourceBytes)).ToLowerInvariant();
            // The digest and the entry it covers ship in the same embedded
            // resource set, so this catches a stale or partial publish rather
            // than tampering; an ordinary comparison is what it calls for.
            if (!string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
            {
                error = "App entry integrity check failed.";
                return false;
            }
        }
        catch (Exception ex)
        {
            error = $"Cannot verify the embedded app entry: {ex.Message}";
            return false;
        }

        app = new PackagedApp(id, name, version, "main.js", source);
        return true;
    }

    private static int? Int(JsonObject value, string key)
    {
        try { return value[key]?.GetValue<int>(); }
        catch { return null; }
    }

    private static string? Str(JsonObject value, string key)
    {
        try { return value[key]?.GetValue<string>(); }
        catch { return null; }
    }

    private static string Value(JsonObject value, string key) =>
        value[key]?.ToJsonString() ?? "a missing value";
}
