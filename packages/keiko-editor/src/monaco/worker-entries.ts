/**
 * Default Monaco worker constructors — the single browser/bundler-only edge of the worker strategy
 * (Issue #1193, ADR-0042 D3).
 *
 * The runtime ships Monaco's editor worker only. Keiko gates language intelligence through
 * host/server providers; rich Monaco TS/JS, JSON, CSS, and HTML language workers are deliberately
 * excluded from the release artifact under ADR-0042 D3.6 unless a future ADR reopens the budgets.
 * No CDN URL appears.
 *
 * Construction is deferred inside each factory, so importing this module is side-effect-free and
 * safe in non-browser contexts; the `Worker`/`URL` calls run only when the host invokes a factory at
 * mount time. The dispatch logic that selects a factory is the pure, unit-tested `./workers.ts`.
 */

import { MONACO_WORKER_MODULES, type MonacoWorkerFactories } from "./workers.js";

function createEditorWorker(): Worker {
  // Read the worker specifier from the single source of truth (`./workers.ts`) so the runtime
  // constructor and the build/test verification checks cannot drift by construction (KEIKO-0584).
  return new Worker(new URL(MONACO_WORKER_MODULES.editor, import.meta.url), {
    type: "module",
  });
}

/**
 * Same-origin ESM worker constructors for the locally installed monaco-editor (no CDN).
 */
export const defaultMonacoWorkerFactories: MonacoWorkerFactories = {
  editor: createEditorWorker,
};
