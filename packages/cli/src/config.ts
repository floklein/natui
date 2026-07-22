import { readFile } from "node:fs/promises";
import path from "node:path";

export interface NatUIConfig {
  entry: string;
  identifier: string;
  macos: {
    minimumVersion: string;
  };
  name: string;
  version: string;
  window: {
    height: number;
    resizable: boolean;
    width: number;
  };
  windows: {
    architecture: "x64" | "arm64";
    minimumVersion: string;
  };
}

export interface LoadedConfig {
  config: NatUIConfig;
  configPath: string;
  cwd: string;
  entryPath: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function number(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function validate(raw: unknown): NatUIConfig {
  const root = record(raw, "NatUI config");
  const window = record(root.window ?? {}, "window");
  const macos = record(root.macos ?? {}, "macos");
  const windows = record(root.windows ?? {}, "windows");
  const identifier = text(root.identifier, "identifier");
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+$/.test(identifier)) {
    throw new Error("identifier must be a reverse-DNS identifier, for example com.example.app");
  }
  const architecture = text(windows.architecture, "windows.architecture", "x64");
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("windows.architecture must be x64 or arm64");
  }
  return {
    entry: text(root.entry, "entry"),
    identifier,
    macos: {
      minimumVersion: text(macos.minimumVersion, "macos.minimumVersion", "14.0"),
    },
    name: text(root.name, "name"),
    version: text(root.version, "version", "0.1.0"),
    window: {
      height: number(window.height, "window.height", 640),
      resizable: boolean(window.resizable, "window.resizable", true),
      width: number(window.width, "window.width", 900),
    },
    windows: {
      architecture,
      minimumVersion: text(
        windows.minimumVersion,
        "windows.minimumVersion",
        "10.0.19041.0",
      ),
    },
  };
}

export async function loadConfig(cwd: string, requestedPath = "natui.config.json"): Promise<LoadedConfig> {
  const configPath = path.resolve(cwd, requestedPath);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read NatUI config at ${configPath}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(`NatUI config is not valid JSON: ${configPath}`, { cause: error });
  }
  const config = validate(raw);
  return {
    config,
    configPath,
    cwd,
    entryPath: path.resolve(path.dirname(configPath), config.entry),
  };
}

export function safeProductName(name: string): string {
  const product = name.replace(/[^A-Za-z0-9 _.-]/g, "").trim();
  if (product === "" || product === "." || product === "..") {
    throw new Error("name must contain at least one filename-safe character");
  }
  return product;
}

export function csharpNamespace(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
  return /^[A-Za-z_]/.test(joined) ? joined : `NatUI${joined}`;
}
