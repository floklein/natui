import { describe, expect, it } from "vitest";
import { macosHostSource, macosInfoPlist } from "./macos.js";
import { windowsProjectFiles } from "./windows.js";

const base = {
  height: 600,
  identifier: "com.example.natui",
  minimumVersion: "14.0",
  name: "Example & Native",
  resizable: true,
  version: "1.2.3",
  width: 800,
};

describe("native host templates", () => {
  it("generates a deterministic native SwiftUI host and escaped plist", () => {
    const source = macosHostSource(base);
    expect(source).toBe(macosHostSource(base));
    expect(source).toContain("import SwiftUI");
    expect(source).toContain("Process()");
    expect(source).toContain('case "button"');
    expect(source).not.toContain("WebView");
    expect(macosInfoPlist(base)).toContain("<string>Example &amp; Native</string>");
  });

  it("generates a complete WinUI project around native controls", () => {
    const files = windowsProjectFiles({
      ...base,
      architecture: "x64",
      minimumVersion: "10.0.19041.0",
      namespace: "ExampleNative",
    });
    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        "App.xaml",
        "App.xaml.cs",
        "ControllerSession.cs",
        "MainWindow.xaml",
        "MainWindow.xaml.cs",
        "NatUIHost.csproj",
        "NatUIProtocol.cs",
        "NatUIRenderer.cs",
        "app.manifest",
      ]),
    );
    expect(files["NatUIHost.csproj"]).toContain("Microsoft.WindowsAppSDK");
    expect(files["ControllerSession.cs"]).toContain("ProcessStartInfo");
    expect(files["NatUIRenderer.cs"]).toContain("Microsoft.UI.Xaml.Controls");
    expect(files["NatUIRenderer.cs"]).toContain('"textfield"');
    expect(Object.values(files).join("\n")).not.toContain("WebView");
  });

  it("escapes native source and manifest strings", () => {
    const macSource = macosHostSource({ ...base, name: "Quote \" and newline\n" });
    expect(macSource).toContain('static let name = "Quote \\\" and newline\\n"');
    const windows = windowsProjectFiles({
      ...base,
      architecture: "arm64",
      minimumVersion: "10.0.19041.0",
      name: "A & B",
      namespace: "SafeNamespace",
    });
    expect(windows["app.manifest"]).toContain("<description>A &amp; B</description>");
  });
});
