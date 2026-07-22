import { access, chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildController } from "./bundle.js";
import type { BuildPlatform } from "./bundle.js";
import type { LoadedConfig } from "./config.js";
import { csharpNamespace, safeProductName } from "./config.js";
import { run } from "./process.js";
import { macosHostSource, macosInfoPlist } from "./templates/macos.js";
import { windowsProjectFiles } from "./templates/windows.js";

export interface BuildOptions {
  outDirectory: string;
  platform: BuildPlatform | "all";
  report?: (message: string) => void;
}

export interface PlatformBuildResult {
  artifactPath: string;
  bundlePath: string;
  platform: BuildPlatform;
  verified: boolean;
}

function assertSafeOutput(cwd: string, output: string): void {
  const relative = path.relative(cwd, output);
  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Output directory must be a child of the project: ${output}`);
  }
}

async function replaceDirectory(staging: string, destination: string): Promise<void> {
  await rm(destination, { force: true, recursive: true });
  await rename(staging, destination);
}

async function buildMacOS(
  loaded: LoadedConfig,
  staging: string,
  report: (message: string) => void,
): Promise<Omit<PlatformBuildResult, "bundlePath"> & { bundlePathInStage: string }> {
  report("Bundling the macOS React controller");
  const controller = await buildController(loaded, "macos", staging);
  const product = safeProductName(loaded.config.name);
  const sourceDirectory = path.join(staging, "native");
  const sourcePath = path.join(sourceDirectory, "NatUIHost.swift");
  await mkdir(sourceDirectory, { recursive: true });
  const templateOptions = {
    height: loaded.config.window.height,
    identifier: loaded.config.identifier,
    minimumVersion: loaded.config.macos.minimumVersion,
    name: loaded.config.name,
    resizable: loaded.config.window.resizable,
    version: loaded.config.version,
    width: loaded.config.window.width,
  };
  await writeFile(sourcePath, macosHostSource(templateOptions));

  const appPath = path.join(staging, `${product}.app`);
  const contents = path.join(appPath, "Contents");
  const executables = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  await mkdir(executables, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), macosInfoPlist(templateOptions));
  await copyFile(controller.controllerPath, path.join(resources, "NatUIController"));
  await chmod(path.join(resources, "NatUIController"), 0o755);

  report("Compiling the SwiftUI host");
  const architecture = process.arch === "x64" ? "x86_64" : "arm64";
  const moduleCache = path.join(staging, "module-cache");
  await mkdir(moduleCache, { recursive: true });
  await run(
    "xcrun",
    [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-target",
      `${architecture}-apple-macosx${loaded.config.macos.minimumVersion}`,
      "-module-cache-path",
      moduleCache,
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      "-o",
      path.join(executables, "NatUIHost"),
      sourcePath,
    ],
    {
      cwd: loaded.cwd,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULE_CACHE_PATH: moduleCache,
      },
    },
  );
  await chmod(path.join(executables, "NatUIHost"), 0o755);
  report("Applying a local ad hoc signature");
  await run("codesign", ["--force", "--sign", "-", path.join(resources, "NatUIController")], {
    cwd: loaded.cwd,
    quiet: true,
  });
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    cwd: loaded.cwd,
    quiet: true,
  });
  return {
    artifactPath: appPath,
    bundlePathInStage: controller.bundlePath,
    platform: "macos",
    verified: true,
  };
}

async function buildWindows(
  loaded: LoadedConfig,
  staging: string,
  report: (message: string) => void,
): Promise<Omit<PlatformBuildResult, "bundlePath"> & { bundlePathInStage: string }> {
  report("Cross-compiling the Windows React controller");
  const controller = await buildController(loaded, "windows", staging);
  const projectDirectory = path.join(staging, "NatUIHost");
  await mkdir(projectDirectory, { recursive: true });
  const files = windowsProjectFiles({
    architecture: loaded.config.windows.architecture,
    height: loaded.config.window.height,
    identifier: loaded.config.identifier,
    minimumVersion: loaded.config.windows.minimumVersion,
    name: loaded.config.name,
    namespace: csharpNamespace(loaded.config.name),
    resizable: loaded.config.window.resizable,
    version: loaded.config.version,
    width: loaded.config.window.width,
  });
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(projectDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await copyFile(controller.controllerPath, path.join(projectDirectory, "NatUIController.exe"));

  let verified = false;
  if (process.platform === "win32") {
    report("Compiling the WinUI host");
    await run("dotnet", ["build", "NatUIHost.csproj", "-c", "Release"], {
      cwd: projectDirectory,
    });
    verified = true;
  } else {
    report("Generated WinUI sources. Native compilation requires Windows");
  }
  return {
    artifactPath: projectDirectory,
    bundlePathInStage: controller.bundlePath,
    platform: "windows",
    verified,
  };
}

async function buildOne(
  loaded: LoadedConfig,
  platform: BuildPlatform,
  outDirectory: string,
  report: (message: string) => void,
): Promise<PlatformBuildResult> {
  const staging = path.join(outDirectory, `.natui-${platform}-${process.pid}-${Date.now()}`);
  const destination = path.join(outDirectory, platform);
  await rm(staging, { force: true, recursive: true });
  await mkdir(staging, { recursive: true });
  try {
    const staged =
      platform === "macos"
        ? await buildMacOS(loaded, staging, report)
        : await buildWindows(loaded, staging, report);
    const relativeArtifact = path.relative(staging, staged.artifactPath);
    const relativeBundle = path.relative(staging, staged.bundlePathInStage);
    await replaceDirectory(staging, destination);
    return {
      artifactPath: path.join(destination, relativeArtifact),
      bundlePath: path.join(destination, relativeBundle),
      platform,
      verified: staged.verified,
    };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

export async function buildNatUI(
  loaded: LoadedConfig,
  options: BuildOptions,
): Promise<PlatformBuildResult[]> {
  await access(loaded.entryPath);
  const outDirectory = path.resolve(loaded.cwd, options.outDirectory);
  assertSafeOutput(loaded.cwd, outDirectory);
  await mkdir(outDirectory, { recursive: true });
  const report = options.report ?? (() => undefined);
  const platforms: BuildPlatform[] =
    options.platform === "all" ? ["macos", "windows"] : [options.platform];
  const results: PlatformBuildResult[] = [];
  for (const platform of platforms) {
    results.push(await buildOne(loaded, platform, outDirectory, report));
  }
  return results;
}
