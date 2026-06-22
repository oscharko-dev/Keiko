/**
 * Monaco web-worker registration for the Keiko Editor (Issue #1193).
 *
 * monaco-editor 0.55.1 runs its editor service and language services (TypeScript/JavaScript, JSON,
 * CSS, HTML) in web workers selected through a `self.MonacoEnvironment.getWorker(workerId, label)`
 * factory. Per ADR-0042 D3, Keiko loads these workers **same-origin from the locally installed
 * `monaco-editor` package** using the ESM `new Worker(new URL(..., import.meta.url), { type: "module" })`
 * pattern (Turbopack-compatible; the `monaco-editor-webpack-plugin` is forbidden) — never from a CDN.
 *
 * This module separates the pure, node-testable parts (which worker serves which Monaco label, and
 * the local worker module specifiers) from the single browser/bundler-only edge that constructs the
 * actual `Worker` objects (`./worker-entries.ts`). The `getWorker` factory is built from injected
 * worker constructors so it is fully unit-testable.
 */

/** The distinct Monaco worker bundles the editor loads. @internal (not part of the public API). */
export const MONACO_WORKER_ENTRIES = ["editor", "ts", "json", "css", "html"] as const;

/** One of the {@link MONACO_WORKER_ENTRIES}. */
export type MonacoWorkerEntry = (typeof MONACO_WORKER_ENTRIES)[number];

/**
 * Local, same-origin ESM module specifier for each worker bundle in the installed `monaco-editor`
 * package. These resolve inside `node_modules/monaco-editor`; no CDN host appears here. Used both to
 * construct the workers (`./worker-entries.ts`) and to verify worker availability in the build.
 * @internal Not part of the package public API (used by `./worker-entries.ts` and tests).
 */
export const MONACO_WORKER_MODULES: Readonly<Record<MonacoWorkerEntry, string>> = {
  editor: "monaco-editor/esm/vs/editor/editor.worker.js",
  ts: "monaco-editor/esm/vs/language/typescript/ts.worker.js",
  json: "monaco-editor/esm/vs/language/json/json.worker.js",
  css: "monaco-editor/esm/vs/language/css/css.worker.js",
  html: "monaco-editor/esm/vs/language/html/html.worker.js",
};

/**
 * Map a Monaco worker `label` to the worker bundle that serves it.
 *
 * Monaco passes its language ids (`typescript`/`javascript`, `json`, `css`/`scss`/`less`,
 * `html`/`handlebars`/`razor`) or `editorWorkerService` for the base editor worker. Anything else
 * (including the base service and unknown labels) falls back to the editor worker.
 * @internal Consumed by {@link createMonacoEnvironment}; not part of the package public API.
 */
export function monacoWorkerEntryForLabel(label: string): MonacoWorkerEntry {
  switch (label) {
    case "typescript":
    case "javascript":
      return "ts";
    case "json":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "handlebars":
    case "razor":
      return "html";
    default:
      return "editor";
  }
}

/** Constructs the `Worker` for a worker bundle (the browser/bundler-only edge). */
export type MonacoWorkerFactory = () => Worker;

/** A constructor for every worker bundle, keyed by {@link MonacoWorkerEntry}. */
export type MonacoWorkerFactories = Readonly<Record<MonacoWorkerEntry, MonacoWorkerFactory>>;

/** Structural view of the `MonacoEnvironment` object Monaco reads off the global scope. */
export interface MonacoEnvironmentLike {
  getWorker(workerId: string, label: string): Worker;
}

/**
 * Build a `MonacoEnvironment` whose `getWorker` dispatches each label to the injected worker
 * constructor. Pure given the factories, so it is fully node-testable; the real factories
 * ({@link MONACO_WORKER_MODULES}-backed) live in `./worker-entries.ts`.
 */
export function createMonacoEnvironment(factories: MonacoWorkerFactories): MonacoEnvironmentLike {
  return {
    getWorker(_workerId: string, label: string): Worker {
      return factories[monacoWorkerEntryForLabel(label)]();
    },
  };
}

/** Global scope that may carry a `MonacoEnvironment` (browser `self`/`window` or a test double). */
export interface MonacoGlobalScope {
  MonacoEnvironment?: MonacoEnvironmentLike;
}

/**
 * Install a `MonacoEnvironment` on the given global scope so Monaco picks up the same-origin worker
 * factory before the editor mounts. The scope is injected, so this is node-testable.
 */
export function installMonacoEnvironment(
  scope: MonacoGlobalScope,
  environment: MonacoEnvironmentLike,
): void {
  scope.MonacoEnvironment = environment;
}
