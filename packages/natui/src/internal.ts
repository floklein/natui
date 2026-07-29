/**
 * Internal seam between `@natui/core` and `@natui/dev`.
 *
 * These are not public API and carry no stability guarantee: they exist so the
 * development server can drive a run() lifecycle it needs to cancel, supersede
 * and re-render across hot-reload generations. Application code should import
 * from `@natui/core` instead. The two packages are versioned together.
 */
export {
  runWithController,
  type NatuiAppController,
} from './run.js';
export type { NatuiApp, RunOptions } from './run.js';
