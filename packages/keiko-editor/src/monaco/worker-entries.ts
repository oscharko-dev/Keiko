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

import { type MonacoWorkerFactories } from "./workers.js";

function createEditorWorker(): Worker {
  // KEIKO-0584: Turbopack (and every ESM bundler) requires the URL argument to be a static string
  // literal so it can resolve and rewrite the worker asset at build time; a variable reference —
  // even a readonly typed constant — is rejected with "Module not found: Can't resolve <dynamic>".
  // The specifier is duplicated at MONACO_WORKER_MODULES.editor in ./workers.ts and pinned equal
  // to this literal by workers.test.ts so the two cannot drift.
  return new Worker(new URL("monaco-editor/editor/editor.worker.js", import.meta.url), {
    type: "module",
  });
}

/**
 * Same-origin ESM worker constructors for the locally installed monaco-editor (no CDN).
 */
export const defaultMonacoWorkerFactories: MonacoWorkerFactories = {
  editor: createEditorWorker,
};
