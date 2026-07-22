import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const fixtures: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixture(name: string, config: unknown): Promise<string> {
  const directory = path.join(process.cwd(), ".natui", "config-tests", `${name}-${Date.now()}-${Math.random()}`);
  fixtures.push(directory);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "natui.config.json"), JSON.stringify(config));
  return directory;
}

describe("NatUI config", () => {
  it("loads defaults and resolves the entry from the config directory", async () => {
    const directory = await fixture("valid", {
      entry: "src/App.tsx",
      identifier: "com.example.desktop",
      name: "Example",
    });
    const loaded = await loadConfig(directory);
    expect(loaded.entryPath).toBe(path.join(directory, "src", "App.tsx"));
    expect(loaded.config).toMatchObject({
      macos: { minimumVersion: "14.0" },
      version: "0.1.0",
      window: { height: 640, resizable: true, width: 900 },
      windows: { architecture: "x64", minimumVersion: "10.0.19041.0" },
    });
  });

  it("rejects identifiers that are unsafe for native projects", async () => {
    const directory = await fixture("invalid", {
      entry: "src/App.tsx",
      identifier: "not a bundle identifier",
      name: "Example",
    });
    await expect(loadConfig(directory)).rejects.toThrow(/reverse-DNS identifier/);
  });

  it("rejects invalid window dimensions", async () => {
    const directory = await fixture("window", {
      entry: "src/App.tsx",
      identifier: "com.example.desktop",
      name: "Example",
      window: { width: 0 },
    });
    await expect(loadConfig(directory)).rejects.toThrow(/window.width must be a positive number/);
  });
});
