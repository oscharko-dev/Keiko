/**
 * Default Monaco worker constructors — the single browser/bundler-only edge of the worker strategy
 * (Issue #1193, ADR-0042 D3).
 *
 * The governed v1 runtime ships only Monaco's editor worker. TypeScript/JavaScript, JSON, CSS, and
 * HTML language-service workers are intentionally not constructed by default because Keiko routes
 * language intelligence through the server-governed providers (ADR-0042 D4); #1213 owns any future
 * multi-language worker expansion. Keeping exactly one static `new Worker(new URL(...))` literal here
 * lets Turbopack emit only the editor worker chunk in the static export. No CDN URL appears.
 *
 * Construction is deferred inside each factory, so importing this module is side-effect-free and
 * safe in non-browser contexts; the `Worker`/`URL` calls run only when the host invokes a factory at
 * mount time. The dispatch logic that selects a factory is the pure, unit-tested `./workers.ts`.
 */

import type { MonacoWorkerFactories } from "./workers.js";

function createEditorWorker(): Worker {
  return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
    type: "module",
  });
}

/**
 * Same-origin ESM worker constructors for the locally installed monaco-editor (no CDN).
 *
 * All labels intentionally map to the editor worker in v1. The host disables Monaco's built-in
 * language services before mount, so a language-worker request would be unexpected; falling back to
 * the editor worker preserves Monaco's base service without shipping unused language workers.
 */
export const defaultMonacoWorkerFactories: MonacoWorkerFactories = {
  editor: createEditorWorker,
  ts: createEditorWorker,
  json: createEditorWorker,
  css: createEditorWorker,
  html: createEditorWorker,
};
