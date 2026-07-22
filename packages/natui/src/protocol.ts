/**
 * TypeScript types for the natui wire protocol v1 (see docs/protocol.md).
 * One JSON object per line (NDJSON) in both directions.
 */

export const PROTOCOL_VERSION = 1;

/** JSON-serializable prop values. Functions never cross the wire. */
export type PropValue =
  | string
  | number
  | boolean
  | null
  | PropValue[]
  | { [key: string]: PropValue };

export type SerializedProps = Record<string, PropValue>;

// ---------------------------------------------------------------------------
// Ops (inside a commit batch)
// ---------------------------------------------------------------------------

export type Op =
  | { op: 'create'; id: number; kind: string; props: SerializedProps }
  | { op: 'createText'; id: number; text: string }
  | { op: 'append'; parent: number; child: number }
  | { op: 'insert'; parent: number; child: number; before: number }
  | { op: 'remove'; parent: number; child: number }
  | {
      op: 'update';
      id: number;
      props: SerializedProps;
      /**
       * Echo suppression: the highest event `seq` from this node that JS had
       * processed when it produced these props. If the host has since emitted
       * a newer seq (the user kept typing/dragging), the host keeps its local
       * `value` and applies only the other props. See docs/protocol.md.
       */
      ack?: number;
    }
  | { op: 'text'; id: number; text: string }
  | { op: 'clear' };

/** Node id of the window's root container. */
export const ROOT_ID = 0;

// ---------------------------------------------------------------------------
// JS -> Host
// ---------------------------------------------------------------------------

export interface WindowProps {
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

export type OutboundMessage =
  | { t: 'window'; props: WindowProps }
  | { t: 'commit'; ops: Op[] }
  | { t: 'dump' }
  | { t: 'screenshot'; path: string }
  | { t: 'emit'; id: number; name: string; payload?: Record<string, PropValue> }
  /**
   * Debug: perform a real optimistic user edit on node `id`, through the same
   * code path as a native control edit (local value write, seq increment,
   * change event with seq). Unlike `emit`, this exercises seq/ack end to end.
   */
  | { t: 'edit'; id: number; value: PropValue }
  | { t: 'quit' };

// ---------------------------------------------------------------------------
// Host -> JS
// ---------------------------------------------------------------------------

export interface TreeNode {
  id: number;
  kind: string;
  props?: SerializedProps;
  text?: string;
  children?: TreeNode[];
}

export type InboundMessage =
  | { t: 'ready'; platform: 'macos' | 'windows'; protocol: number }
  | {
      t: 'event';
      id: number;
      name: string;
      payload: Record<string, PropValue>;
      /** Monotonic per-node counter for optimistic local edits (change events). */
      seq?: number;
    }
  | { t: 'window'; name: 'close' }
  | { t: 'tree'; root: TreeNode }
  /** Reply to `screenshot`. `error` set (and no file written) on failure. */
  | { t: 'shot'; path: string; error?: string };
