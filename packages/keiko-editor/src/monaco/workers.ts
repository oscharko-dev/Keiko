/**
 * Monaco web-worker registration for the Keiko Editor (Issue #1193).
 *
 * monaco-editor 0.55.1 runs its editor service in a web worker selected through a
 * `self.MonacoEnvironment.getWorker(workerId, label)` factory. Per ADR-0042 D3/D3.6, Keiko ships
 * only Monaco's base editor worker **same-origin from the locally installed `monaco-editor`
 * package** using the ESM `new Worker(new URL(..., import.meta.url), { type: "module" })` pattern
 * (Turbopack-compatible; the `monaco-editor-webpack-plugin` is forbidden) — never from a CDN.
 *
 * This module separates the pure, node-testable parts (which worker serves which Monaco label, and
 * the local worker module specifiers) from the single browser/bundler-only edge that constructs the
 * actual `Worker` objects (`./worker-entries.ts`). The `getWorker` factory is built from injected
 * worker constructors so it is fully unit-testable.
 */

/** The distinct Monaco worker bundle the governed runtime ships. @internal (not public API). */
export const MONACO_WORKER_ENTRIES = ["editor"] as const;

/** One of the {@link MONACO_WORKER_ENTRIES}. */
export type MonacoWorkerEntry = (typeof MONACO_WORKER_ENTRIES)[number];

/**
 * Local, same-origin ESM module specifier for the worker bundle in the installed `monaco-editor`
 * package. This resolves inside `node_modules/monaco-editor`; no CDN host appears here. Used both to
 * construct the worker (`./worker-entries.ts`) and to verify worker availability in the build.
 * @internal Not part of the package public API (used by `./worker-entries.ts` and tests).
 */
export const MONACO_WORKER_MODULES: Readonly<Record<MonacoWorkerEntry, string>> = {
  editor: "monaco-editor/esm/vs/editor/editor.worker.js",
};

/**
 * Map a Monaco worker `label` to the worker bundle that serves it.
 *
 * The governed v1 runtime intentionally ships only the base editor worker. Keiko's language
 * intelligence and formatting paths are host/server-owned; rich Monaco language workers are not
 * part of the release artifact unless a future ADR reopens the bundle budgets. Any label therefore
 * falls back to the editor worker.
 * @internal Consumed by {@link createMonacoEnvironment}; not part of the package public API.
 */
export function monacoWorkerEntryForLabel(label: string): MonacoWorkerEntry {
  void label;
  return "editor";
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
