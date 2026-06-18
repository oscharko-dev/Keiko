/**
 * Keiko Editor Monaco runtime: no-CDN loader configuration, capability detection, and controlled
 * error states (Issue #1193, ADR-0042 D3).
 *
 * `@monaco-editor/react` ships `@monaco-editor/loader`, whose default configuration fetches Monaco
 * from a CDN (`cdn.jsdelivr.net/npm/monaco-editor@.../min/vs`). {@link configureMonacoLoader} injects
 * the locally-installed `monaco-editor` instance via `loader.config({ monaco })` so no editor asset
 * is ever fetched from a CDN — the no-CDN invariant. There is deliberately **no CDN fallback**: if
 * the local runtime or its workers are unavailable the editor surfaces a controlled, actionable
 * error state instead of silently reaching the network.
 *
 * All logic here is pure and node-testable: the loader and the environment probe are injected.
 */

/** Structural view of the `@monaco-editor/loader` `loader` export. */
export interface MonacoLoaderLike {
  config(options: { monaco: unknown }): void;
}

let monacoLoaderConfigured = false;

/**
 * Point `@monaco-editor/react`'s loader at the locally-installed `monaco-editor` instance so its
 * default CDN loader is never used. Call once, before the first editor mount.
 */
export function configureMonacoLoader(loader: MonacoLoaderLike, monacoInstance: unknown): void {
  loader.config({ monaco: monacoInstance });
  monacoLoaderConfigured = true;
}

/**
 * Whether {@link configureMonacoLoader} has run in this runtime. The host should assert this before
 * mounting the editor: mounting `@monaco-editor/react` without it would let the loader fall back to
 * its default CDN — the no-CDN invariant (ADR-0042 D3) depends on the loader being configured first.
 */
export function isMonacoLoaderConfigured(): boolean {
  return monacoLoaderConfigured;
}

/** Reasons the Keiko Editor runtime cannot start; each maps to an actionable user-facing message. */
export const EDITOR_RUNTIME_UNSUPPORTED_REASONS = [
  "web-workers-unavailable",
  "url-api-unavailable",
  "monaco-runtime-load-failed",
] as const;

/** A reason the editor runtime is unsupported. */
export type EditorRuntimeUnsupportedReason = (typeof EDITOR_RUNTIME_UNSUPPORTED_REASONS)[number];

/** Outcome of a runtime capability check: supported, or an actionable unsupported state. */
export type EditorRuntimeStatus =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: EditorRuntimeUnsupportedReason;
      readonly message: string;
    };

/** Feature probe for the browser capabilities the Monaco ESM worker strategy requires. */
export interface EditorRuntimeProbe {
  /** Web Workers are constructable (`typeof Worker !== "undefined"`). */
  readonly hasWorker: boolean;
  /** The `URL` API is available (the ESM `new Worker(new URL(...))` pattern needs it). */
  readonly hasUrl: boolean;
}

/** Actionable, user-readable message for an unsupported-runtime reason. */
export function describeEditorRuntimeError(reason: EditorRuntimeUnsupportedReason): string {
  switch (reason) {
    case "web-workers-unavailable":
      return "The code editor needs Web Workers, which are unavailable in this browser or context. Editing is disabled; open this workspace in a current browser to use the editor.";
    case "url-api-unavailable":
      return "The code editor could not start because the browser URL API is unavailable, so its language workers cannot load. Editing is disabled.";
    case "monaco-runtime-load-failed":
      return "The code editor runtime failed to load from this application. Editing is disabled; reload the page, and if the problem persists check that the editor assets were deployed. The editor never falls back to a third-party CDN.";
    default:
      return "The code editor is unavailable.";
  }
}

function unsupported(reason: EditorRuntimeUnsupportedReason): EditorRuntimeStatus {
  return { supported: false, reason, message: describeEditorRuntimeError(reason) };
}

/**
 * Decide whether the editor runtime can start from a feature probe. Pure; build the probe with
 * {@link probeEditorRuntime} (or any equivalent) so this is node-testable.
 */
export function detectEditorRuntimeSupport(probe: EditorRuntimeProbe): EditorRuntimeStatus {
  if (!probe.hasWorker) {
    return unsupported("web-workers-unavailable");
  }
  if (!probe.hasUrl) {
    return unsupported("url-api-unavailable");
  }
  return { supported: true };
}

/** Global scope whose runtime capabilities are probed (browser `self`/`window` or a test double). */
export interface EditorRuntimeGlobalScope {
  readonly Worker?: unknown;
  readonly URL?: unknown;
}

/** Build an {@link EditorRuntimeProbe} from a global scope (injectable for tests). */
export function probeEditorRuntime(scope: EditorRuntimeGlobalScope): EditorRuntimeProbe {
  return {
    hasWorker: typeof scope.Worker !== "undefined",
    hasUrl: typeof scope.URL !== "undefined",
  };
}

/**
 * Convert a Monaco runtime load failure into a controlled, actionable status — never a CDN fallback.
 * Call from the host's editor load/error boundary when the local Monaco runtime fails to initialise.
 */
export function editorRuntimeLoadFailure(): EditorRuntimeStatus {
  return unsupported("monaco-runtime-load-failed");
}
