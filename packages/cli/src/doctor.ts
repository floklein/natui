import { capture } from "./process.js";

export interface DoctorCheck {
  detail: string;
  name: string;
  ok: boolean;
  required: boolean;
}

async function versionCheck(
  cwd: string,
  name: string,
  command: string,
  args: string[],
  required: boolean,
): Promise<DoctorCheck> {
  const value = await capture(command, args, cwd);
  return {
    detail: value?.split("\n")[0] ?? "not found",
    name,
    ok: value !== null,
    required,
  };
}

export async function runDoctor(cwd: string): Promise<DoctorCheck[]> {
  const checks = await Promise.all([
    versionCheck(cwd, "Node.js", "node", ["--version"], true),
    versionCheck(cwd, "Bun standalone compiler", "bun", ["--version"], true),
    versionCheck(cwd, "TypeScript", "npx", ["tsc", "--version"], true),
    versionCheck(cwd, "Xcode", "xcodebuild", ["-version"], process.platform === "darwin"),
    versionCheck(cwd, "Swift", "swift", ["--version"], process.platform === "darwin"),
    versionCheck(cwd, "Code signing", "xcrun", ["--find", "codesign"], process.platform === "darwin"),
    versionCheck(cwd, ".NET SDK for WinUI", "dotnet", ["--version"], process.platform === "win32"),
  ]);
  return checks;
}
