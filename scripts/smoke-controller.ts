import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { buildController } from "../packages/cli/src/bundle.js";
import { loadConfig } from "../packages/cli/src/config.js";

interface ProtocolNode {
  children: ProtocolNode[];
  events: Record<string, string>;
}

interface ProtocolMessage {
  revision?: number;
  root?: ProtocolNode | null;
  type?: string;
}

function firstPressHandler(node: ProtocolNode | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node.events.press === "string") return node.events.press;
  for (const child of node.children) {
    const handler = firstPressHandler(child);
    if (handler !== null) return handler;
  }
  return null;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const platform = process.argv.includes("--windows") || process.platform === "win32" ? "windows" : "macos";
  const output = path.join(cwd, ".natui", `${platform}-controller-smoke`);
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });
  const loaded = await loadConfig(cwd);
  const built = await buildController(loaded, platform, output);

  if (platform === "windows" && process.platform !== "win32") {
    const executable = await readFile(built.controllerPath);
    if (executable.subarray(0, 2).toString("ascii") !== "MZ") {
      throw new Error("Cross-compiled Windows controller is not a PE executable");
    }
    console.log(`Windows controller cross-compile passed: ${path.relative(cwd, built.controllerPath)}`);
    return;
  }

  const child = spawn(built.controllerPath, [], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, terminal: false });
  let stderr = "";
  let helloSeen = false;
  let firstRevision = 0;
  let eventSent = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Controller smoke test timed out\n${stderr}`)), 20_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!eventSent) reject(new Error(`Controller exited early with ${code ?? "unknown"}\n${stderr}`));
      });
      lines.on("line", (line) => {
        let message: ProtocolMessage;
        try {
          message = JSON.parse(line) as ProtocolMessage;
        } catch (error) {
          clearTimeout(timeout);
          reject(new Error(`Controller wrote non-JSON output: ${line}`, { cause: error }));
          return;
        }
        if (message.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`Controller reported an error: ${line}`));
          return;
        }
        if (message.type === "hello") helloSeen = true;
        if (message.type !== "snapshot" || message.revision === undefined) return;
        if (!eventSent) {
          const handler = firstPressHandler(message.root);
          if (handler === null) {
            clearTimeout(timeout);
            reject(new Error("Controller snapshot did not contain a press handler"));
            return;
          }
          firstRevision = message.revision;
          eventSent = true;
          child.stdin.write(`${JSON.stringify({ handler, protocol: 1, type: "event" })}\n`);
          return;
        }
        if (message.revision > firstRevision) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  } finally {
    lines.close();
    child.kill();
  }
  if (!helloSeen) throw new Error("Controller did not send a hello frame");
  console.log(`Controller smoke test passed: ${path.relative(cwd, built.controllerPath)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
