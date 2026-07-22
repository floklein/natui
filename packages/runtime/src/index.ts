export { startController } from "./controller.js";
export { createNativeRoot } from "./renderer.js";
export { NATUI_PROTOCOL_VERSION, isControllerMessage } from "./protocol.js";
export type {
  ControllerMessage,
  ErrorMessage,
  EventMessage,
  HelloMessage,
  HostMessage,
  JsonValue,
  SnapshotMessage,
  WireNode,
} from "./protocol.js";
