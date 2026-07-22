import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import type { LoadedConfig } from "./config.js";
import { run } from "./process.js";

export type BuildPlatform = "macos" | "windows";

export interface BundleResult {
  bundlePath: string;
  controllerPath: string;
}

function bootstrapSource(entryPath: string, platform: BuildPlatform): string {
  return [
    'import { createElement } from "react";',
    `import App from ${JSON.stringify(entryPath)};`,
    'import { startController } from "@natui/runtime";',
    `startController(createElement(App), { platform: ${JSON.stringify(platform)} });`,
    "",
  ].join("\n");
}

function bunTarget(platform: BuildPlatform, architecture: "x64" | "arm64"): string {
  if (platform === "macos") return process.arch === "x64" ? "bun-darwin-x64" : "bun-darwin-arm64";
  return architecture === "arm64" ? "bun-windows-arm64" : "bun-windows-x64-baseline";
}

export async function buildController(
  loaded: LoadedConfig,
  platform: BuildPlatform,
  outputDirectory: string,
): Promise<BundleResult> {
  const controllerDirectory = path.join(outputDirectory, "controller");
  await mkdir(controllerDirectory, { recursive: true });
  const bootstrapPath = path.join(controllerDirectory, "bootstrap.mjs");
  const bundlePath = path.join(controllerDirectory, "controller.bundle.mjs");
  await writeFile(bootstrapPath, bootstrapSource(loaded.entryPath, platform));
  await build({
    bundle: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    entryPoints: [bootstrapPath],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: true,
    outfile: bundlePath,
    platform: "node",
    sourcemap: "external",
    target: "node22",
  });

  const controllerName = platform === "windows" ? "NatUIController.exe" : "NatUIController";
  const controllerPath = path.join(controllerDirectory, controllerName);
  await run(
    "bun",
    [
      "build",
      bundlePath,
      "--compile",
      `--target=${bunTarget(platform, loaded.config.windows.architecture)}`,
      "--outfile",
      controllerPath,
    ],
    { cwd: loaded.cwd },
  );
  await chmod(controllerPath, 0o755);
  return { bundlePath, controllerPath };
}
