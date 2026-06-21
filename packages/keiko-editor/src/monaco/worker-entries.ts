/**
 * Default Monaco worker constructors — the single browser/bundler-only edge of the worker strategy
 * (Issue #1193, ADR-0042 D3).
 *
 * The runtime ships Monaco's editor worker plus the built-in TS/JS, JSON, CSS, and HTML language
 * workers. Keiko still gates governed language intelligence through host providers, but Monaco's
 * local workers back syntax services such as JSON/CSS/HTML formatting, folding, symbols, and schema
 * parsing when those language contributions are loaded. No CDN URL appears.
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

function createTypeScriptWorker(): Worker {
  return new Worker(
    new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url),
    {
      type: "module",
    },
  );
}

function createJsonWorker(): Worker {
  return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), {
    type: "module",
  });
}

function createCssWorker(): Worker {
  return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), {
    type: "module",
  });
}

function createHtmlWorker(): Worker {
  return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), {
    type: "module",
  });
}

/**
 * Same-origin ESM worker constructors for the locally installed monaco-editor (no CDN).
 */
export const defaultMonacoWorkerFactories: MonacoWorkerFactories = {
  editor: createEditorWorker,
  ts: createTypeScriptWorker,
  json: createJsonWorker,
  css: createCssWorker,
  html: createHtmlWorker,
};
