import { createInterface } from "node:readline";
import type { ReactNode } from "react";
import { NATUI_PROTOCOL_VERSION, isControllerMessage } from "./protocol.js";
import type { ControllerMessage, ErrorMessage, HostMessage } from "./protocol.js";
import { createNativeRoot } from "./renderer.js";

export interface ControllerOptions {
  platform: "macos" | "windows";
  send?: (message: HostMessage) => void;
}

function errorMessage(error: unknown): ErrorMessage {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    message: normalized.message,
    protocol: NATUI_PROTOCOL_VERSION,
    ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
    type: "error",
  };
}

export function startController(element: ReactNode, options: ControllerOptions): () => void {
  (globalThis as { __NATUI_PLATFORM__?: "macos" | "windows" }).__NATUI_PLATFORM__ = options.platform;
  const send = options.send ?? ((message: HostMessage) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const root = createNativeRoot(
    (tree, revision) =>
      send({ protocol: NATUI_PROTOCOL_VERSION, revision, root: tree, type: "snapshot" }),
    (error) => send(errorMessage(error)),
  );

  send({
    capabilities: ["snapshots", "events", "controlled-inputs"],
    platform: options.platform,
    protocol: NATUI_PROTOCOL_VERSION,
    type: "hello",
  });
  root.render(element);

  if (options.send !== undefined) return () => root.unmount();

  const input = createInterface({ input: process.stdin, terminal: false });
  const onMessage = (message: ControllerMessage): void => {
    if (message.type === "event" && !root.dispatch(message.handler, message.payload)) {
      send(errorMessage(new Error(`Unknown or stale event handler: ${message.handler}`)));
    }
  };
  input.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isControllerMessage(message)) throw new Error("Invalid controller message");
      onMessage(message);
    } catch (error) {
      send(errorMessage(error));
    }
  });
  return () => {
    input.close();
    root.unmount();
  };
}
