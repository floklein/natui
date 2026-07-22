export * from './components.js';
export { run, type RunOptions, type NatuiApp } from './run.js';
export type {
  Op,
  InboundMessage,
  OutboundMessage,
  SerializedProps,
  TreeNode,
  WindowProps,
} from './protocol.js';
export { PROTOCOL_VERSION, ROOT_ID } from './protocol.js';

// Lower-level building blocks, exported for tests and custom transports.
export { Bridge } from './bridge/bridge.js';
export { createNatuiRenderer } from './reconciler/renderer.js';
export {
  spawnStdioTransport,
  type Transport,
  type HostCommand,
} from './bridge/transport.js';
export { defaultHostCommand } from './bridge/locate.js';
