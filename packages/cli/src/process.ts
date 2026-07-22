import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

export async function run(command: string, args: string[], options: RunOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.quiet === true ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (options.quiet === true) {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const suffix = output.trim() === "" ? "" : `\n${output.trim()}`;
        reject(new Error(`${command} exited with ${code ?? signal ?? "an unknown status"}${suffix}`));
      }
    });
  });
}

export async function capture(command: string, args: string[], cwd: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code === 0 ? output.trim() : null));
  });
}
