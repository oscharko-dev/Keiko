/**
 * Default Monaco worker constructors — the single browser/bundler-only edge of the worker strategy
 * (Issue #1193, ADR-0042 D3).
 *
 * Each entry constructs its worker with the ESM `new Worker(new URL("monaco-editor/esm/...",
 * import.meta.url), { type: "module" })` pattern. The specifier must be a static string literal so
 * Turbopack (and the static-export build) can emit the worker as a same-origin chunk; the literals
 * mirror {@link MONACO_WORKER_MODULES} (a source check keeps them in lock-step). No CDN URL appears.
 *
 * Construction is deferred inside each factory, so importing this module is side-effect-free and
 * safe in non-browser contexts; the `Worker`/`URL` calls run only when the host invokes a factory at
 * mount time. The dispatch logic that selects a factory is the pure, unit-tested `./workers.ts`.
 */

import type { MonacoWorkerFactories } from "./workers.js";

/** Same-origin, ESM worker constructors for the locally installed monaco-editor (no CDN). */
export const defaultMonacoWorkerFactories: MonacoWorkerFactories = {
  editor: () =>
    new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
      type: "module",
    }),
  ts: () =>
    new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), {
      type: "module",
    }),
  json: () =>
    new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), {
      type: "module",
    }),
  css: () =>
    new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), {
      type: "module",
    }),
  html: () =>
    new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), {
      type: "module",
    }),
};
