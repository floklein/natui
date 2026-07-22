export const NATUI_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WireNode {
  children: WireNode[];
  events: Record<string, string>;
  id: string;
  props: Record<string, JsonValue>;
  type: string;
}

export interface HelloMessage {
  capabilities: string[];
  platform: "macos" | "windows";
  protocol: typeof NATUI_PROTOCOL_VERSION;
  type: "hello";
}

export interface SnapshotMessage {
  protocol: typeof NATUI_PROTOCOL_VERSION;
  revision: number;
  root: WireNode | null;
  type: "snapshot";
}

export interface ErrorMessage {
  message: string;
  protocol: typeof NATUI_PROTOCOL_VERSION;
  stack?: string;
  type: "error";
}

export type HostMessage = HelloMessage | SnapshotMessage | ErrorMessage;

export interface EventMessage {
  handler: string;
  payload?: JsonValue;
  protocol?: typeof NATUI_PROTOCOL_VERSION;
  type: "event";
}

export interface PingMessage {
  type: "ping";
}

export type ControllerMessage = EventMessage | PingMessage;

export function isControllerMessage(value: unknown): value is ControllerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === "ping") return true;
  return type === "event" && typeof (value as { handler?: unknown }).handler === "string";
}
