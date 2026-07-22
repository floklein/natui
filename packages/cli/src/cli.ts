#!/usr/bin/env node
import path from "node:path";
import { buildNatUI } from "./build.js";
import type { BuildPlatform } from "./bundle.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";

const HELP = `NatUI POC

Usage:
  natui build [macos|windows|all] [--config path] [--out-dir path]
  natui doctor
  natui help

Examples:
  natui build macos
  natui build all --out-dir build
`;

interface ParsedBuildArgs {
  configPath: string;
  outDirectory: string;
  platform: BuildPlatform | "all";
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function parseBuildArgs(values: string[]): ParsedBuildArgs {
  const args = [...values];
  const configPath = option(args, "--config", "natui.config.json");
  const outDirectory = option(args, "--out-dir", "build");
  const platform = args.shift() ?? "all";
  if (platform !== "macos" && platform !== "windows" && platform !== "all") {
    throw new Error(`Unknown platform: ${platform}`);
  }
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`);
  return { configPath, outDirectory, platform };
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "doctor") {
    const checks = await runDoctor(cwd);
    for (const check of checks) {
      const status = check.ok ? "ok" : check.required ? "missing" : "optional";
      console.log(`${status.padEnd(8)} ${check.name}: ${check.detail}`);
    }
    if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
    return;
  }
  if (command === "build") {
    const parsed = parseBuildArgs(args);
    const loaded = await loadConfig(cwd, parsed.configPath);
    console.log(`Building ${loaded.config.name} from ${path.relative(cwd, loaded.entryPath)}`);
    const results = await buildNatUI(loaded, {
      outDirectory: parsed.outDirectory,
      platform: parsed.platform,
      report: (message) => console.log(`  ${message}`),
    });
    for (const result of results) {
      const verification = result.verified ? "native build verified" : "source generated, Windows verification pending";
      console.log(`Built ${result.platform}: ${path.relative(cwd, result.artifactPath)} (${verification})`);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`NatUI error: ${message}`);
  process.exitCode = 1;
});
