/**
 * Monaco diagnostics bridge (Issue #1201, ADR-0042 D4).
 *
 * Diagnostics are not a Monaco "provider": they are markers set on a model. This bridge owns that
 * lifecycle. It binds to the editor's active model, runs the host-injected {@link EditorDiagnosticsResolver}
 * on an initial pass and after each (debounced) content change, and writes the result with
 * `editor.setModelMarkers(model, owner, markers)`. It computes no diagnostics, calls no model, and
 * performs no I/O — every result comes from the deterministic server language service via the host
 * resolver (ADR-0042 D4).
 *
 * Marker lifecycle and stale-diagnostics safety:
 *  - A successful response always rewrites the owner's markers (so a fixed error's squiggle clears).
 *  - A response is DISCARDED when the buffer changed while it was in flight (the captured model
 *    version no longer matches), when a newer request superseded it, or when the model was swapped —
 *    so a slow analysis of old content can never paint stale squiggles over newer text.
 *  - The in-flight request is aborted when a newer run starts or the bridge is disposed.
 *  - On model swap the previous model's markers are cleared and the new model is rebound.
 *  - An unsupported-language model is never analysed and carries no markers (clean degradation).
 *  - A resolver failure leaves existing markers untouched and never throws, so diagnostics never
 *    break editing.
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`); the timer is injectable, so the whole lifecycle is unit-testable without a browser
 * and the module stays import-side-effect-free.
 */
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorDiagnostic,
  EditorDiagnosticSeverity,
  EditorDiagnosticsQuery,
  EditorDiagnosticsRequest,
  EditorDiagnosticsResolver,
  EditorRequestIdentity,
} from "../types.js";
import type { MonacoDisposable } from "./completion-bridge.js";
import type { EditorDiagnosticsSummary } from "./status-bar.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

/** Monaco's `MarkerSeverity` enum (Hint=1, Info=2, Warning=4, Error=8). */
export interface MonacoMarkerSeverities {
  readonly Error: number;
  readonly Warning: number;
  readonly Info: number;
  readonly Hint: number;
}

/** One Monaco marker (1-based coordinates). */
export interface MonacoMarkerData {
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly source?: string;
  readonly code?: string;
}

/** Overview marker rendered by the React shell. */
export interface DiagnosticOverviewMarker {
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly source?: string | undefined;
  readonly code?: string | undefined;
}

export interface MonacoDiagnosticsModel {
  getValue(): string;
  getVersionId(): number;
  getLanguageId(): string;
  onDidChangeContent(listener: () => void): MonacoDisposable;
  readonly uri: { toString(): string };
}

/** The slice of the live `monaco.editor` namespace the diagnostics bridge consumes. */
export interface MonacoMarkerEditorNamespace {
  readonly MarkerSeverity: MonacoMarkerSeverities;
  setModelMarkers(
    model: MonacoDiagnosticsModel,
    owner: string,
    markers: readonly MonacoMarkerData[],
  ): void;
}

/** The slice of the live standalone editor the diagnostics bridge consumes. */
export interface MonacoDiagnosticsEditor {
  getModel(): MonacoDiagnosticsModel | null;
  onDidChangeModel(listener: () => void): MonacoDisposable;
}

/** An opaque debounce timer handle (a `setTimeout` return value by default). */
export type DiagnosticsTimerHandle = unknown;

/** Injectable debounce scheduler so the lifecycle is deterministic under test. */
export interface DiagnosticsScheduler {
  schedule(callback: () => void, delayMs: number): DiagnosticsTimerHandle;
  cancel(handle: DiagnosticsTimerHandle): void;
}

/** The default scheduler: `setTimeout`/`clearTimeout`. */
export const defaultDiagnosticsScheduler: DiagnosticsScheduler = {
  schedule: (callback, delayMs): DiagnosticsTimerHandle => setTimeout(callback, delayMs),
  cancel: (handle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

// Editor severity → the `MonacoMarkerSeverities` member name. A total map, so the lookup is
// exhaustive without a switch.
const EDITOR_SEVERITY_TO_MONACO: Readonly<
  Record<EditorDiagnosticSeverity, keyof MonacoMarkerSeverities>
> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
  hint: "Hint",
};

/** Map an editor diagnostic severity onto Monaco's numeric `MarkerSeverity`. */
export function severityToMarker(
  severity: EditorDiagnosticSeverity,
  severities: MonacoMarkerSeverities,
): number {
  return severities[EDITOR_SEVERITY_TO_MONACO[severity]];
}

/** Map one editor diagnostic to a Monaco marker (0-based range → 1-based coordinates). */
export function editorDiagnosticToMarker(
  diagnostic: EditorDiagnostic,
  severities: MonacoMarkerSeverities,
): MonacoMarkerData {
  return {
    severity: severityToMarker(diagnostic.severity, severities),
    message: diagnostic.message,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.column + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.column + 1,
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

/** Map a diagnostics list to Monaco markers. */
export function diagnosticsToMarkers(
  diagnostics: readonly EditorDiagnostic[],
  severities: MonacoMarkerSeverities,
): readonly MonacoMarkerData[] {
  return diagnostics.map((diagnostic) => editorDiagnosticToMarker(diagnostic, severities));
}

export function markersToOverviewMarkers(
  markers: readonly MonacoMarkerData[],
): readonly DiagnosticOverviewMarker[] {
  return markers.map((marker) => ({
    severity: marker.severity,
    message: marker.message,
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
    ...(marker.source === undefined ? {} : { source: marker.source }),
    ...(marker.code === undefined ? {} : { code: marker.code }),
  }));
}

/**
 * Tally diagnostics into the content-free status-bar summary (Issue #1205). `info` and `hint` both
 * count as informational, so the status bar shows error/warning/info totals without leaking content.
 */
export function summarizeDiagnostics(
  diagnostics: readonly EditorDiagnostic[],
): EditorDiagnosticsSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors += 1;
    } else if (diagnostic.severity === "warning") {
      warnings += 1;
    } else {
      infos += 1;
    }
  }
  return { errors, warnings, infos };
}

// ─── Controller ─────────────────────────────────────────────────────────────────────────────────

export interface RegisterKeikoDiagnosticsArgs {
  /** The live standalone editor whose active model is analysed. */
  readonly editor: MonacoDiagnosticsEditor;
  /** The live `monaco.editor` namespace (marker write + severity enum). */
  readonly markers: MonacoMarkerEditorNamespace;
  /** The host-injected resolver that produces diagnostics (BFF call lives here). */
  readonly resolve: EditorDiagnosticsResolver;
  /** Languages that have a governed deterministic provider; others carry no markers. */
  readonly documentLanguages: readonly EditorLanguageId[];
  /** Marker owner key — only markers under this key are read/written by the bridge. */
  readonly owner: string;
  /** Per-change debounce (ms) before re-analysis. */
  readonly debounceMs: number;
  /** Stream identity for this bridge instance; supersession is scoped to it. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
  /** Debounce scheduler; defaults to `setTimeout`/`clearTimeout`. */
  readonly scheduler?: DiagnosticsScheduler | undefined;
  /**
   * Content-free diagnostic-count observer (Issue #1205). Called with the error/warning/info tally
   * after each non-stale analysis writes markers, so the host's status bar reflects the live problem
   * count. Never receives diagnostic text or ranges.
   */
  readonly onSummary?: ((summary: EditorDiagnosticsSummary) => void) | undefined;
  /** Ranges and diagnostic labels for the rounded Keiko overview marker overlay. */
  readonly onOverviewMarkers?: ((markers: readonly DiagnosticOverviewMarker[]) => void) | undefined;
  /**
   * Issue #2213 (ADR-0126) — the full per-diagnostic list (string severity, no Monaco-numbered leak)
   * delivered to a host that aggregates diagnostics across panes (the workspace Problems panel). Fed
   * `response.diagnostics` directly, so no host needs to depend on Monaco's numeric marker severity.
   */
  readonly onDiagnostics?: ((diagnostics: readonly EditorDiagnostic[]) => void) | undefined;
}

interface DiagnosticsState {
  model: MonacoDiagnosticsModel | null;
  contentSub: MonacoDisposable | null;
  // `null` means "no timer scheduled"; `null` is a valid `DiagnosticsTimerHandle` value.
  timer: DiagnosticsTimerHandle;
  controller: AbortController | null;
  latestSeq: number;
}

// The mutable lifecycle bundle the module-level helpers operate on, so each helper stays a small,
// independently-testable unit rather than a nested closure (keeps the public function thin).
interface DiagnosticsRuntime {
  readonly args: RegisterKeikoDiagnosticsArgs;
  readonly scheduler: DiagnosticsScheduler;
  readonly state: DiagnosticsState;
}

function isEligibleModel(rt: DiagnosticsRuntime, model: MonacoDiagnosticsModel): boolean {
  return rt.args.documentLanguages.includes(model.getLanguageId() as EditorLanguageId);
}

function cancelTimer(rt: DiagnosticsRuntime): void {
  if (rt.state.timer !== null) {
    rt.scheduler.cancel(rt.state.timer);
    rt.state.timer = null;
  }
}

function abortInFlight(rt: DiagnosticsRuntime): void {
  rt.state.controller?.abort();
  rt.state.controller = null;
}

// True when the response no longer describes the live buffer: the model was swapped, a newer run
// superseded this one, or the buffer changed while the request was in flight.
function isStale(
  rt: DiagnosticsRuntime,
  model: MonacoDiagnosticsModel,
  sequence: number,
  versionBefore: number,
): boolean {
  return (
    rt.state.model !== model ||
    sequence !== rt.state.latestSeq ||
    model.getVersionId() !== versionBefore
  );
}

function runDiagnostics(rt: DiagnosticsRuntime, model: MonacoDiagnosticsModel): void {
  abortInFlight(rt);
  const versionBefore = model.getVersionId();
  rt.state.latestSeq += 1;
  const sequence = rt.state.latestSeq;
  const identity: EditorRequestIdentity = {
    requestId: rt.args.newRequestId(),
    streamId: rt.args.streamId,
    sequence,
  };
  const request: EditorDiagnosticsRequest = {
    request: identity,
    document: {
      uri: model.uri.toString(),
      language: model.getLanguageId() as EditorLanguageId,
      version: versionBefore,
    },
  };
  const query: EditorDiagnosticsQuery = { request, documentText: model.getValue() };
  const controller = new AbortController();
  rt.state.controller = controller;
  rt.args.resolve(query, controller.signal).then(
    (response) => {
      if (isStale(rt, model, sequence, versionBefore)) {
        return;
      }
      const markers = diagnosticsToMarkers(response.diagnostics, rt.args.markers.MarkerSeverity);
      rt.args.markers.setModelMarkers(model, rt.args.owner, markers);
      rt.args.onSummary?.(summarizeDiagnostics(response.diagnostics));
      rt.args.onOverviewMarkers?.(markersToOverviewMarkers(markers));
      rt.args.onDiagnostics?.(response.diagnostics);
    },
    () => {
      // A failure (network, abort, host error) leaves existing markers untouched and never throws.
    },
  );
}

function scheduleRun(rt: DiagnosticsRuntime, model: MonacoDiagnosticsModel): void {
  cancelTimer(rt);
  rt.state.timer = rt.scheduler.schedule(() => {
    rt.state.timer = null;
    runDiagnostics(rt, model);
  }, rt.args.debounceMs);
}

function unbindModel(rt: DiagnosticsRuntime): void {
  cancelTimer(rt);
  abortInFlight(rt);
  rt.state.contentSub?.dispose();
  rt.state.contentSub = null;
  if (rt.state.model !== null) {
    rt.args.markers.setModelMarkers(rt.state.model, rt.args.owner, []);
    rt.args.onOverviewMarkers?.([]);
  }
  rt.state.model = null;
}

function bindModel(rt: DiagnosticsRuntime, model: MonacoDiagnosticsModel | null): void {
  rt.state.model = model;
  if (model === null) {
    return;
  }
  if (!isEligibleModel(rt, model)) {
    // Unsupported language: ensure no stale markers remain and register no analysis.
    rt.args.markers.setModelMarkers(model, rt.args.owner, []);
    rt.args.onOverviewMarkers?.([]);
    return;
  }
  rt.state.contentSub = model.onDidChangeContent(() => {
    scheduleRun(rt, model);
  });
  runDiagnostics(rt, model);
}

/**
 * Bind the diagnostics lifecycle to the editor's active model and return a disposer that tears down
 * the model-change subscription, the active model binding, the debounce timer, the in-flight request,
 * and the markers. The caller owns disposal (the editor's unmount path).
 */
export function registerKeikoDiagnostics(args: RegisterKeikoDiagnosticsArgs): MonacoDisposable {
  const rt: DiagnosticsRuntime = {
    args,
    scheduler: args.scheduler ?? defaultDiagnosticsScheduler,
    state: { model: null, contentSub: null, timer: null, controller: null, latestSeq: 0 },
  };
  bindModel(rt, args.editor.getModel());
  const modelSub = args.editor.onDidChangeModel(() => {
    unbindModel(rt);
    bindModel(rt, args.editor.getModel());
  });
  return {
    dispose(): void {
      modelSub.dispose();
      unbindModel(rt);
    },
  };
}

/** The governed languages eligible for diagnostics (TS/JS; the #1198 deterministic set). */
export const DIAGNOSTICS_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];

/** Default per-change debounce (ms) before re-running diagnostics. */
export const DEFAULT_DIAGNOSTICS_DEBOUNCE_MS = 400;

/** Default marker owner key for Keiko language-service diagnostics. */
export const DEFAULT_DIAGNOSTICS_OWNER = "keiko-language-service";
