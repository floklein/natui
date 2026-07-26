/**
 * Types for probe.mjs. `ProbeNode` is declared structurally rather than
 * imported from '@natui/core' so this directory needs no package.json (and so
 * no workspace entry): the framework's `TreeNode` is assignable to it, and the
 * generic signatures hand the caller's own node type back.
 */
export interface ProbeNode {
  id: number;
  kind: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: ProbeNode[];
}

export interface WaitForMessageOptions {
  startIndex?: number;
  timeoutMs?: number;
  pollMs?: number;
  refresh?: () => void | Promise<void>;
  ended?: () => string | undefined;
  diagnose?: () => string | Promise<string>;
}

export declare function collect<T extends ProbeNode>(root: T, kind: string): T[];
export declare function textOf(node: ProbeNode): string;
export declare function byAxId<T extends ProbeNode>(root: T, id: string): T;
export declare function assertValidPng(path: string): void;
export declare function runningHosts(): string;
export declare function waitForMessage<T>(
  messages: readonly T[],
  predicate: (message: T) => boolean,
  label: string,
  options?: WaitForMessageOptions,
): Promise<T>;
