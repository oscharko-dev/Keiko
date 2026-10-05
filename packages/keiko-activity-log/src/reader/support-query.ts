// The streaming machine query over the segmented Activity Log (#3531).
//
// One engine answers `keiko support query`, selective `keiko support export` and incident
// resolution. It never loads a whole segment or the whole log: candidate segments are preselected by
// their manifests (`support-segment-manifest.ts`) and streamed line by line, and only the selected
// events are retained, up to a report budget.
//
// TWO KINDS OF SELECTION
//
//   closure — a correlation, an incident, or a defect fingerprint. The engine computes the full
//             registered causal closure: the roots, every ancestor reachable over
//             `parentCorrelationId`, and every descendant (child and background operations), in
//             bounded passes that each re-read only the segments whose correlation filter may hold
//             the frontier. Unrelated correlations — siblings included — are never selected. A narrow
//             pre/post context then adds the uncorrelated process signals (lifecycle, resource, loss,
//             backpressure, disk) of the closure's own process lifetimes inside
//             [first closure event - contextMs, last closure event + contextMs], plus each of those
//             lifetimes' own `process.started` (its runtime) wherever it lies, and nothing else. A
//             lifetime without a start is complete only while its segments still run unbroken and
//             intact from its first one. A user-reported incident also selects its pinned window's
//             diagnostic roots; independent successful activity is bounded optional context.
//   events  — registered operation, error kind, failure class, parent correlation, and a bounded time
//             window, combined with AND; matching events only.
//
// NEVER A SILENT TRUNCATION. The canonical report record ceiling applies while streaming.
// Required closure and lifetime records take precedence over optional context. A closure that
// does not fit the report budget (or exceeds the
// correlation bound, which also bounds its process lifetimes) returns no events and is
// `insufficient` with `report-budget-exceeded`; a selection the log no longer holds (a closure
// member, or a lifetime's start) is `insufficient` with `evidence-not-retained`; an unreadable
// candidate segment is `segment-unreadable`; only optional context is ever dropped, and that is
// declared as `context-truncated`. Every result carries exactly one diagnostic sufficiency status,
// derived by the same per-failure-class projection `keiko support analyze` uses.

import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  MAX_SUPPORT_REPORT_RECORDS,
  activityLogOperationSchema,
  diagnosticSufficiencyStatus,
  parseActivityLogSegmentId,
  type ActivityLogCompletenessState,
  type ActivityLogLossState,
  type DiagnosticSufficiencyReason,
  type DiagnosticSufficiencyStatus,
  type SupportLifetimeProvenance,
  type SupportLifetimeStart,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import {
  ACTIVITY_LOG_EVIDENCE_INTEGRITY,
  emptyEvidenceCounts,
  evidenceSummary,
  sufficiencyLine,
  type ActivityLogEvidenceClassification,
  type MutableEvidenceCounts,
  type ParsedLine,
  type ProcessSequenceAnomaly,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  projectActivityLogSufficiency,
  restrictActivityLogSufficiency,
  type ActivityLogClassSufficiency,
  type ActivityLogSufficiencyIntegrity,
} from "./support-analyze-sufficiency.js";
import {
  SEGMENT_MANIFEST_SCHEMA_VERSION,
  compareText,
  correlationKey,
  filterKeyHashes,
  manifestMayContainAnyKey,
  parentCorrelationKey,
  type FilterKeyHashes,
  type LoadedSegmentManifest,
  type SegmentManifest,
} from "./support-segment-manifest.js";
import { LIFETIME_ANCHOR_OP, LIFETIME_PROOF_OP, compareLifetimes } from "./support-lifetime.js";
import type {
  ActivityLogScanner,
  ActivityLogStoreFile,
  ScannedLine,
  SegmentManifestPassStats,
} from "./support-segment-scan.js";

export const SUPPORT_QUERY_KIND = "keiko.support.query";
export const SUPPORT_QUERY_SCHEMA_VERSION = 1;

export const SUPPORT_QUERY_CLASSES = [
  "correlation",
  "incident",
  "defect-fingerprint",
  "parent-correlation",
  "operation",
  "error-kind",
  "failure-class",
  "time-window",
] as const;
export type SupportQueryClass = (typeof SUPPORT_QUERY_CLASSES)[number];

export interface SupportQueryLimits {
  readonly maxResultBytes: number;
  readonly maxClosureCorrelations: number;
  readonly contextMs: number;
  readonly maxContextEvents: number;
}

export const DEFAULT_SUPPORT_QUERY_LIMITS: SupportQueryLimits = {
  maxResultBytes: 16 * 1024 * 1024,
  maxClosureCorrelations: 4096,
  contextMs: 5000,
  maxContextEvents: 256,
};

export interface SupportQueryWindow {
  readonly fromMs: number;
  readonly toMs: number;
  // The segments the window covers (an incident's pinned segments); `undefined` covers every file.
  readonly segmentIds?: ReadonlySet<string> | undefined;
}

export type SupportRequiredClasses =
  | { readonly kind: "observed" }
  | { readonly kind: "declared"; readonly failureClasses: readonly string[] }
  | { readonly kind: "observed-failures" };

export interface SupportClosureSelection {
  readonly kind: "closure";
  readonly queryClass: "correlation" | "incident" | "defect-fingerprint";
  readonly roots: readonly string[];
  // Pinned windows whose diagnostic events are selected and whose correlations become roots.
  readonly windows: readonly SupportQueryWindow[];
  readonly requiredClasses: SupportRequiredClasses;
  // True when the selection's descriptor could not be resolved (no open incident record).
  readonly unresolved: boolean;
}

export interface SupportEventFilter {
  readonly parentCorrelationId?: string | undefined;
  readonly op?: string | undefined;
  readonly errorKind?: string | undefined;
  readonly failureClass?: string | undefined;
  readonly fromMs?: number | undefined;
  readonly toMs?: number | undefined;
}

export interface SupportEventSelection {
  readonly kind: "events";
  readonly queryClass: Exclude<SupportQueryClass, SupportClosureSelection["queryClass"]>;
  readonly filter: SupportEventFilter;
}

export type SupportQuerySelection = SupportClosureSelection | SupportEventSelection;

export type SupportQueryEventRole = "closure" | "window" | "context" | "match";

/** One selected Activity Log line: its verbatim text stays available for selective export. */
export interface SupportSelectedEvent {
  readonly file: ActivityLogStoreFile;
  readonly index: number;
  readonly text: string;
  readonly bytes: number;
  readonly parsed: ParsedLine;
  readonly role: SupportQueryEventRole;
}

export type SupportQueryTruncation = "none" | "context-truncated" | "budget-exceeded";

export interface SupportQueryIntegrity {
  readonly classification: ActivityLogEvidenceClassification;
  readonly consultedFileCount: number;
  readonly supportedLineCount: number;
  readonly legacyLineCount: number;
  readonly unsupportedLineCount: number;
  readonly corruptLineCount: number;
  readonly truncatedLineCount: number;
  readonly incompleteLineCount: number;
  readonly sequenceAnomalyCount: number;
  readonly completeness: ActivityLogCompletenessState;
  readonly loss: ActivityLogLossState;
}

export interface SupportQueryResult {
  readonly kind: typeof SUPPORT_QUERY_KIND;
  readonly schemaVersion: typeof SUPPORT_QUERY_SCHEMA_VERSION;
  readonly provenance: {
    readonly productVersion: string;
    readonly registryVersion: number;
    readonly schemaDigest: string;
    readonly catalogDigest: string;
    readonly manifestSchemaVersion: number;
  };
  readonly query: {
    readonly class: SupportQueryClass;
    readonly limits: SupportQueryLimits & { readonly maxResultRecords: number };
  };
  readonly segments: {
    readonly total: number;
    readonly sealed: number;
    readonly active: number;
    readonly legacy: number;
    readonly candidate: number;
    readonly pruned: number;
    readonly opened: number;
    readonly unreadable: number;
    readonly manifestsReused: number;
    readonly manifestsBuilt: number;
    readonly manifestsRemoved: number;
  };
  readonly closure: {
    readonly correlationCount: number;
    readonly rootCount: number;
    readonly ancestorCount: number;
    readonly descendantCount: number;
    readonly missingCorrelationCount: number;
    readonly passCount: number;
    readonly edges: readonly {
      readonly parentCorrelationId: string;
      readonly correlationId: string;
    }[];
  } | null;
  // How each selected process lifetime accounts for its start; empty for an event selection or a
  // closure that returned no events.
  readonly lifetimes: readonly SupportLifetimeProvenance[];
  readonly integrity: SupportQueryIntegrity;
  readonly loss: {
    readonly state: ActivityLogLossState;
    readonly lossEventCount: number;
  };
  readonly truncation: {
    readonly state: SupportQueryTruncation;
    readonly omittedContextEventCount: number;
    readonly requiredBytes: number;
    readonly requiredRecordCount: number;
  };
  readonly coverage: {
    readonly requiredClassCount: number;
    readonly presentClassCount: number;
    readonly completeClassCount: number;
    readonly degradedClassCount: number;
    readonly insufficientClassCount: number;
  };
  readonly diagnosticSufficiency: {
    readonly status: DiagnosticSufficiencyStatus;
    readonly reasons: readonly DiagnosticSufficiencyReason[];
    readonly classes: readonly ActivityLogClassSufficiency[];
  };
  readonly metrics: {
    readonly candidateEventCount: number;
    readonly resultEventCount: number;
    readonly closureEventCount: number;
    readonly windowEventCount: number;
    readonly contextEventCount: number;
    readonly selectedBytes: number;
    readonly scannedBytes: number;
    readonly scannedLineCount: number;
  };
  readonly events: readonly SupportSelectedEvent[];
}

export interface SupportQueryInput {
  readonly files: readonly ActivityLogStoreFile[];
  readonly manifests: ReadonlyMap<string, LoadedSegmentManifest>;
  readonly manifestStats: SegmentManifestPassStats;
  readonly scanner: ActivityLogScanner;
  readonly selection: SupportQuerySelection;
  readonly limits: SupportQueryLimits;
}

// ─── Shared helpers ────────────────────────────────────────────────────────────────────────────

function knownCorrelation(value: string | undefined): value is string {
  return value !== undefined && value !== ACTIVITY_LOG_UNKNOWN_CORRELATION_ID;
}

function isNonCausal(parsed: ParsedLine): boolean {
  return activityLogOperationSchema(parsed.view.op)?.causal === "none";
}

function lineMs(parsed: ParsedLine): number {
  return Date.parse(parsed.view.ts);
}

function lifetimeKey(parsed: ParsedLine): string | undefined {
  const { pid, instanceId } = parsed.view;
  return parsed.hasFullIdentity && pid !== undefined && instanceId !== undefined
    ? `${String(pid)}:${instanceId}`
    : undefined;
}

function eventKey(file: ActivityLogStoreFile, index: number): string {
  return `${String(file.order)}#${String(index)}`;
}

function manifestTimeOverlaps(manifest: SegmentManifest, fromMs: number, toMs: number): boolean {
  if (manifest.time === null) return false;
  return Date.parse(manifest.time.firstTs) <= toMs && Date.parse(manifest.time.lastTs) >= fromMs;
}

interface EngineState {
  readonly input: SupportQueryInput;
  readonly candidates: Set<string>;
  readonly consulted: Set<string>;
  passCount: number;
}

// Active segments are still growing and a missing manifest proves nothing: both stay candidates.
function candidateFiles(
  state: EngineState,
  mayHold: (loaded: LoadedSegmentManifest, file: ActivityLogStoreFile) => boolean,
): readonly ActivityLogStoreFile[] {
  return state.input.files.filter((file) => {
    if (file.kind === "active") return true;
    const loaded = state.input.manifests.get(file.name);
    return loaded === undefined || mayHold(loaded, file);
  });
}

interface AcceptedLine {
  readonly line: ScannedLine;
  readonly parsed: ParsedLine;
}

function* acceptedLines(
  state: EngineState,
  files: readonly ActivityLogStoreFile[],
  consulted: boolean,
): Generator<AcceptedLine> {
  state.passCount += 1;
  for (const file of files) {
    state.candidates.add(file.name);
    if (consulted) state.consulted.add(file.name);
    for (const line of state.input.scanner.scan(file)) {
      if (line.classification.kind === "line") {
        yield { line, parsed: line.classification.parsed };
      }
    }
  }
}

// ─── Budgeted collection ───────────────────────────────────────────────────────────────────────

function selectedEvent(accepted: AcceptedLine, role: SupportQueryEventRole): SupportSelectedEvent {
  return {
    file: accepted.line.file,
    index: accepted.line.index,
    text: accepted.line.text,
    bytes: accepted.line.byteLength + 1,
    parsed: accepted.parsed,
    role,
  };
}

class EventCollector {
  public readonly events: SupportSelectedEvent[] = [];
  public requiredBytes = 0;
  public candidateCount = 0;
  public exceeded = false;

  public constructor(
    private readonly budgetBytes: number,
    private readonly budgetRecords = MAX_SUPPORT_REPORT_RECORDS,
  ) {}

  public add(accepted: AcceptedLine, role: SupportQueryEventRole): void {
    const bytes = accepted.line.byteLength + 1;
    this.candidateCount += 1;
    this.requiredBytes += bytes;
    if (this.exceeded) return;
    if (this.requiredBytes > this.budgetBytes || this.candidateCount > this.budgetRecords) {
      // Required closure is all-or-nothing.
      this.exceeded = true;
      this.events.length = 0;
      return;
    }
    this.events.push(selectedEvent(accepted, role));
  }
}

interface RankedContextEvent {
  readonly event: SupportSelectedEvent;
  readonly distance: number;
}

function compareContext(left: RankedContextEvent, right: RankedContextEvent): number {
  return (
    left.distance - right.distance ||
    left.event.file.order - right.event.file.order ||
    left.event.index - right.event.index
  );
}

// Keep a worst-first heap inside both remaining budgets. Each admitted candidate costs O(log K),
// independent of log length; later nearby events can replace earlier distant context. Oversized
// optional lines cannot prevent other fitting evidence from being selected.
class ContextCollector {
  private readonly queue: RankedContextEvent[] = [];
  private retainedBytes = 0;
  public candidateCount = 0;

  public constructor(
    private readonly budgetBytes: number,
    private readonly budgetRecords: number,
  ) {}

  public get events(): readonly SupportSelectedEvent[] {
    return this.queue.map(({ event }) => event);
  }

  public add(accepted: AcceptedLine, distance: number): void {
    this.candidateCount += 1;
    const bytes = accepted.line.byteLength + 1;
    if (this.budgetRecords <= 0 || bytes > this.budgetBytes) return;
    this.push({ event: selectedEvent(accepted, "context"), distance });
    this.retainedBytes += bytes;
    while (this.queue.length > this.budgetRecords || this.retainedBytes > this.budgetBytes) {
      this.retainedBytes -= this.removeWorst()?.event.bytes ?? 0;
    }
  }

  private push(entry: RankedContextEvent): void {
    this.queue.push(entry);
    let index = this.queue.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.queue[parentIndex];
      if (parent === undefined || compareContext(parent, entry) >= 0) break;
      this.queue[index] = parent;
      index = parentIndex;
    }
    this.queue[index] = entry;
  }

  private removeWorst(): RankedContextEvent | undefined {
    const worst = this.queue[0];
    const last = this.queue.pop();
    if (last === undefined || this.queue.length === 0) return worst;
    let index = 0;
    while (index * 2 + 1 < this.queue.length) {
      const leftIndex = index * 2 + 1;
      const left = this.queue[leftIndex];
      const right = this.queue[leftIndex + 1];
      if (left === undefined) break;
      const useRight = right !== undefined && compareContext(left, right) < 0;
      const child = useRight ? right : left;
      if (compareContext(last, child) >= 0) break;
      this.queue[index] = child;
      index = useRight ? leftIndex + 1 : leftIndex;
    }
    this.queue[index] = last;
    return worst;
  }
}

// ─── Causal closure ────────────────────────────────────────────────────────────────────────────

type ClosureRole = "root" | "ancestor" | "descendant";

interface ClosureState {
  readonly members: Map<string, ClosureRole>;
  exceeded: boolean;
}

interface Frontier {
  readonly up: ReadonlySet<string>;
  readonly down: ReadonlySet<string>;
}

function frontierKeys(frontier: Frontier): readonly FilterKeyHashes[] {
  return [
    ...[...frontier.up].map((id) => filterKeyHashes(correlationKey(id))),
    ...[...frontier.down].map((id) => filterKeyHashes(parentCorrelationKey(id))),
  ];
}

function admitMember(closure: ClosureState, id: string, role: ClosureRole, limit: number): boolean {
  if (closure.members.has(id)) return false;
  closure.members.set(id, role);
  if (closure.members.size > limit) closure.exceeded = true;
  return true;
}

// One pass: every line of an `up` correlation names an ancestor; every line whose parent is a `down`
// correlation names a descendant. Returns the next frontier.
function expandClosure(state: EngineState, closure: ClosureState, frontier: Frontier): Frontier {
  const keys = frontierKeys(frontier);
  const files = candidateFiles(state, (loaded) => manifestMayContainAnyKey(loaded, keys));
  const limit = state.input.limits.maxClosureCorrelations;
  const up = new Set<string>();
  const down = new Set<string>();
  for (const { parsed } of acceptedLines(state, files, false)) {
    if (isNonCausal(parsed)) continue;
    const id = parsed.correlationId;
    const parent = parsed.view.parentCorrelationId;
    if (!knownCorrelation(id) || !knownCorrelation(parent)) continue;
    if (frontier.up.has(id) && admitMember(closure, parent, "ancestor", limit)) up.add(parent);
    if (frontier.down.has(parent) && admitMember(closure, id, "descendant", limit)) down.add(id);
    if (closure.exceeded) break;
  }
  return { up, down };
}

function computeClosure(state: EngineState, roots: readonly string[]): ClosureState {
  const closure: ClosureState = { members: new Map(), exceeded: false };
  const limit = state.input.limits.maxClosureCorrelations;
  for (const root of roots) admitMember(closure, root, "root", limit);
  let frontier: Frontier = { up: new Set(roots), down: new Set(roots) };
  while (!closure.exceeded && (frontier.up.size > 0 || frontier.down.size > 0)) {
    frontier = expandClosure(state, closure, frontier);
  }
  return closure;
}

// ─── Windows (user-reported incidents) ─────────────────────────────────────────────────────────

// Segment ids survive sealing, so a window pinned while a segment was active still covers it.
function windowCoversFile(window: SupportQueryWindow, file: ActivityLogStoreFile): boolean {
  if (window.segmentIds === undefined) return true;
  return file.segmentId !== undefined && window.segmentIds.has(file.segmentId);
}

function lineInWindow(window: SupportQueryWindow, accepted: AcceptedLine): boolean {
  if (!windowCoversFile(window, accepted.line.file)) return false;
  const ms = lineMs(accepted.parsed);
  return ms >= window.fromMs && ms <= window.toMs;
}

function windowCandidate(
  windows: readonly SupportQueryWindow[],
  loaded: LoadedSegmentManifest,
  file: ActivityLogStoreFile,
): boolean {
  return windows.some(
    (window) =>
      windowCoversFile(window, file) &&
      manifestTimeOverlaps(loaded.manifest, window.fromMs, window.toMs),
  );
}

function successfulHttpStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 200 && status < 400;
}

/** Independent successful transport is optional context, never a mandatory diagnostic root. */
function routineHttpSuccess(accepted: AcceptedLine): boolean {
  const view = accepted.parsed.view;
  const schema = activityLogOperationSchema(view.op);
  return (
    schema?.category === "http" &&
    schema.lifecycle !== "failure" &&
    view.level !== "warn" &&
    view.level !== "error" &&
    view.errorKind === undefined &&
    !knownCorrelation(view.parentCorrelationId) &&
    successfulHttpStatus(view.status) &&
    view.extra?.aborted !== true
  );
}

/** Only positively complete, independent activity may become optional manual-report context. */
function routineWindowActivity(accepted: AcceptedLine): boolean {
  const view = accepted.parsed.view;
  const schema = activityLogOperationSchema(view.op);
  if (schema === undefined || schema.category === "diagnostic") return false;
  if (schema.category === "http") return routineHttpSuccess(accepted);
  if (knownCorrelation(view.parentCorrelationId)) return false;
  return (
    schema.lifecycle !== "failure" &&
    schema.lifecycle !== "loss" &&
    (view.level === "info" || view.level === "debug") &&
    !hasFailureFacts(accepted)
  );
}

function hasFailureFacts({ parsed: { view } }: AcceptedLine): boolean {
  const fields = view.extra;
  if (fields === undefined) return true;
  return (
    view.errorKind !== undefined ||
    view.status !== undefined ||
    view.frames !== undefined ||
    view.causeChain !== undefined ||
    fields.failureKind !== undefined ||
    fields.errorClass !== undefined ||
    fields.completeness !== "complete" ||
    fields.loss !== "none"
  );
}

type OpenWindowLifecycles = Map<string, Map<string, number>>;

function advanceWindowLifecycle(
  pending: OpenWindowLifecycles,
  correlationId: string,
  failureClass: string,
  starts: boolean,
): void {
  const classes = pending.get(correlationId) ?? new Map<string, number>();
  const previous = classes.get(failureClass) ?? 0;
  if (starts) {
    classes.set(failureClass, previous + 1);
    pending.set(correlationId, classes);
  } else {
    if (previous > 1) classes.set(failureClass, previous - 1);
    else classes.delete(failureClass);
    if (classes.size === 0) pending.delete(correlationId);
  }
}

// A start is not routine success. Match the same registered class and correlation, as the existing
// sufficiency analyzer does. Only open correlations occupy the existing closure budget; class keys
// come from the finite registry rather than arbitrary event data.
function noteWindowLifecycle(pending: OpenWindowLifecycles, accepted: AcceptedLine): void {
  const id = accepted.parsed.correlationId;
  const schema = activityLogOperationSchema(accepted.parsed.view.op);
  if (!knownCorrelation(id) || schema === undefined || schema.causal === "none") return;
  const closing = schema.lifecycle === "end" || schema.lifecycle === "failure";
  if (schema.lifecycle !== "start" && !closing) return;
  const classes = schema.failureClasses.length === 0 ? [schema.op] : schema.failureClasses;
  for (const failureClass of classes) {
    advanceWindowLifecycle(pending, id, failureClass, !closing);
  }
}

function windowRootResult(
  roots: ReadonlySet<string>,
  pending: ReadonlyMap<string, ReadonlyMap<string, number>>,
  limit: number,
): { readonly roots: readonly string[]; readonly exceeded: boolean } {
  const selected = new Set([...roots, ...pending.keys()]);
  return { roots: [...selected], exceeded: selected.size > limit };
}

/** Every diagnostic correlation inside the windows, in first-seen order (bounded). */
function windowRoots(
  state: EngineState,
  windows: readonly SupportQueryWindow[],
): { readonly roots: readonly string[]; readonly exceeded: boolean } {
  const roots = new Set<string>();
  if (windows.length === 0) return { roots: [], exceeded: false };
  const pending: OpenWindowLifecycles = new Map();
  const limit = state.input.limits.maxClosureCorrelations;
  const files = candidateFiles(state, (loaded, file) => windowCandidate(windows, loaded, file));
  for (const accepted of acceptedLines(state, files, true)) {
    if (!windows.some((window) => lineInWindow(window, accepted))) continue;
    noteWindowLifecycle(pending, accepted);
    const id = accepted.parsed.correlationId;
    if (knownCorrelation(id) && !isNonCausal(accepted.parsed) && !routineWindowActivity(accepted))
      roots.add(id);
    if (roots.size > limit || pending.size > limit) return windowRootResult(roots, pending, limit);
  }
  return windowRootResult(roots, pending, limit);
}

// ─── Closure events and context ────────────────────────────────────────────────────────────────

interface ClosureEvents {
  readonly collector: EventCollector;
  readonly observed: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  // Every selected line's process lifetime, and those with a selected line from their first segment.
  // Both are kept when the bodies are released for the budget, so the required starts and beginnings
  // are still measured, and both are bounded like the closure's correlations.
  readonly lifetimes: ReadonlySet<string>;
  readonly beginnings: ReadonlySet<string>;
  readonly lifetimesExceeded: boolean;
}

function closureRole(
  accepted: AcceptedLine,
  members: ReadonlyMap<string, ClosureRole>,
  windows: readonly SupportQueryWindow[],
): SupportQueryEventRole | undefined {
  const id = accepted.parsed.correlationId;
  if (knownCorrelation(id) && !isNonCausal(accepted.parsed) && members.has(id)) return "closure";
  if (routineWindowActivity(accepted)) return undefined;
  return windows.some((window) => lineInWindow(window, accepted)) ? "window" : undefined;
}

function isFirstSegment(file: ActivityLogStoreFile): boolean {
  return file.segmentId !== undefined && parseActivityLogSegmentId(file.segmentId)?.index === 1;
}

interface LifetimeNotes {
  readonly lifetimes: Set<string>;
  readonly beginnings: Set<string>;
  readonly limit: number;
}

function noteLifetime(notes: LifetimeNotes, accepted: AcceptedLine): void {
  const key = lifetimeKey(accepted.parsed);
  if (key === undefined || notes.lifetimes.size > notes.limit) return;
  notes.lifetimes.add(key);
  if (isFirstSegment(accepted.line.file)) notes.beginnings.add(key);
}

function collectClosureEvents(
  state: EngineState,
  members: ReadonlyMap<string, ClosureRole>,
  windows: readonly SupportQueryWindow[],
): ClosureEvents {
  const keys = [...members.keys()].map((id) => filterKeyHashes(correlationKey(id)));
  const files = candidateFiles(
    state,
    (loaded, file) =>
      manifestMayContainAnyKey(loaded, keys) || windowCandidate(windows, loaded, file),
  );
  const { maxResultBytes, maxClosureCorrelations } = state.input.limits;
  const collector = new EventCollector(maxResultBytes);
  const observed = new Set<string>();
  const edges = new Set<string>();
  const notes: LifetimeNotes = {
    lifetimes: new Set(),
    beginnings: new Set(),
    limit: maxClosureCorrelations,
  };
  for (const accepted of acceptedLines(state, files, true)) {
    const role = closureRole(accepted, members, windows);
    if (role === undefined) continue;
    collector.add(accepted, role);
    noteLifetime(notes, accepted);
    const id = accepted.parsed.correlationId;
    const parent = accepted.parsed.view.parentCorrelationId;
    if (role !== "closure" || !knownCorrelation(id)) continue;
    observed.add(id);
    if (knownCorrelation(parent) && members.has(parent)) edges.add(`${parent}\u0000${id}`);
  }
  return {
    collector,
    observed,
    edges,
    lifetimes: notes.lifetimes,
    beginnings: notes.beginnings,
    lifetimesExceeded: notes.lifetimes.size > maxClosureCorrelations,
  };
}

interface ContextSelection {
  readonly events: readonly SupportSelectedEvent[];
  readonly omitted: number;
  readonly truncated: boolean;
}

const NO_CONTEXT: ContextSelection = { events: [], omitted: 0, truncated: false };

interface ContextScope {
  readonly fromMs: number;
  readonly toMs: number;
  readonly lifetimes: ReadonlySet<string>;
  readonly selected: ReadonlySet<string>;
  readonly selectedTimes: readonly number[];
}

/**
 * The first line each lifetime wrote among `files` that `matches`, in log order. Every file is
 * streamed to its end: a scan cut short would leave that segment without the derived manifest its
 * integrity is read from.
 */
function firstLinePerLifetime(
  state: EngineState,
  lifetimes: ReadonlySet<string>,
  files: readonly ActivityLogStoreFile[],
  matches: (accepted: AcceptedLine) => boolean,
): ReadonlyMap<string, AcceptedLine> {
  const found = new Map<string, AcceptedLine>();
  if (lifetimes.size === 0 || files.length === 0) return found;
  for (const accepted of acceptedLines(state, files, true)) {
    const key = lifetimeKey(accepted.parsed);
    if (key === undefined || !lifetimes.has(key) || found.has(key) || !matches(accepted)) continue;
    found.set(key, accepted);
  }
  return found;
}

/** Each lifetime's first line of `op` (its start, or a heartbeat), wherever it lies. */
function firstOperationLines(
  state: EngineState,
  lifetimes: ReadonlySet<string>,
  op: string,
): ReadonlyMap<string, AcceptedLine> {
  if (lifetimes.size === 0) return new Map();
  const files = candidateFiles(
    state,
    (loaded) =>
      hasCount(loaded.manifest.ops, op) && manifestMayHoldLifetimes(loaded.manifest, lifetimes),
  );
  return firstLinePerLifetime(
    state,
    lifetimes,
    files,
    (accepted) => accepted.parsed.view.op === op,
  );
}

type LifetimeSegments = ReadonlyMap<number, ActivityLogStoreFile>;

/** Each lifetime's retained segments by index, read from the store's closed segment names alone. */
function lifetimeSegments(
  files: readonly ActivityLogStoreFile[],
): ReadonlyMap<string, LifetimeSegments> {
  const segments = new Map<string, Map<number, ActivityLogStoreFile>>();
  for (const file of files) {
    const identity =
      file.segmentId === undefined ? undefined : parseActivityLogSegmentId(file.segmentId);
    if (identity === undefined) continue;
    const key = `${String(identity.pid)}:${identity.instanceId}`;
    const byIndex = segments.get(key) ?? new Map<number, ActivityLogStoreFile>();
    byIndex.set(identity.index, file);
    segments.set(key, byIndex);
  }
  return segments;
}

// This pass's own derivation of a segment's manifest, else the stored one.
function segmentManifest(
  state: EngineState,
  file: ActivityLogStoreFile,
): SegmentManifest | undefined {
  return state.input.scanner.manifestOf(file) ?? state.input.manifests.get(file.name)?.manifest;
}

// A segment proves what it holds only when it is readable, every line in it is a supported record
// and its process recorded losing none of its own evidence there: a legacy, unsupported, corrupt or
// incomplete line, or a dropped event (a loss summary's process counters, a seal's confirmed drop),
// could be the start itself. The manifest counts all of these, so no body is opened for it. A torn
// tail can only end a lifetime's last segment, where a crash stops it, and is declared as truncated.
function segmentIntact(state: EngineState, file: ActivityLogStoreFile, last: boolean): boolean {
  if (state.input.scanner.unreadable.has(file.name)) return false;
  const manifest = segmentManifest(state, file);
  if (manifest === undefined) return false;
  const { evidence } = manifest;
  const unusable =
    evidence.legacyLineCount +
    evidence.unsupportedLineCount +
    evidence.corruptLineCount +
    evidence.incompleteLineCount +
    (last ? 0 : evidence.truncatedLineCount) +
    manifest.processLossLineCount;
  return unusable === 0;
}

// The writer numbers a lifetime's segments from 1 and retention prunes the oldest first, so a
// lifetime whose segments still run unbroken and intact from its first holds everything it ever
// wrote: a start it wrote would have been found. Legacy files carry no index and prove no beginning.
function beginningRetained(state: EngineState, segments: LifetimeSegments | undefined): boolean {
  if (segments === undefined) return false;
  for (let index = 1; index <= segments.size; index += 1) {
    const file = segments.get(index);
    if (file === undefined || !segmentIntact(state, file, index === segments.size)) return false;
  }
  return true;
}

/** The first line of each lifetime's first segment: what shows a receiver that its beginning held. */
function firstSegmentLines(
  state: EngineState,
  lifetimes: ReadonlySet<string>,
  segments: ReadonlyMap<string, LifetimeSegments>,
): ReadonlyMap<string, AcceptedLine> {
  const files = [...lifetimes].flatMap((key) => {
    const file = segments.get(key)?.get(1);
    return file === undefined ? [] : [file];
  });
  return firstLinePerLifetime(state, lifetimes, files, () => true);
}

interface LifetimeEvidence {
  readonly starts: ReadonlyMap<string, AcceptedLine>;
  readonly lost: ReadonlySet<string>;
  readonly beginnings: ReadonlyMap<string, AcceptedLine>;
  readonly proofs: ReadonlyMap<string, AcceptedLine>;
}

// Each lifetime's start; else, while its whole beginning is held intact, one line of its first
// segment unless the closure already shows one; else its start is lost, and its first heartbeat,
// written only after a start, is the proof a receiver recomputes the loss from.
function lifetimeEvidence(state: EngineState, closure: ClosureEvents): LifetimeEvidence {
  const starts = firstOperationLines(state, closure.lifetimes, LIFETIME_ANCHOR_OP);
  const segments = lifetimeSegments(state.input.files);
  const unanchored = [...closure.lifetimes].filter((key) => !starts.has(key));
  const lost = new Set(unanchored.filter((key) => !beginningRetained(state, segments.get(key))));
  const unshown = new Set(
    unanchored.filter((key) => !lost.has(key) && !closure.beginnings.has(key)),
  );
  const beginnings = firstSegmentLines(state, unshown, segments);
  // A held beginning whose first segment yields no line shows nothing a receiver can check.
  for (const key of unshown) if (!beginnings.has(key)) lost.add(key);
  return { starts, lost, beginnings, proofs: firstOperationLines(state, lost, LIFETIME_PROOF_OP) };
}

function lifetimeStart(evidence: LifetimeEvidence, key: string): SupportLifetimeStart {
  if (evidence.starts.has(key)) return "selected";
  return evidence.lost.has(key) ? "lost" : "absent";
}

/**
 * Each closure lifetime's own start names its runtime (Node version, platform, architecture). It is
 * required evidence, not optional context: it is charged to the selection's own budget wherever it
 * lies, never counted against the context cap and never dropped to fit optional context, because a
 * long-running process started far before any short window would otherwise lose that dimension.
 * Only `keiko ui` writes one (support-lifetime.ts); every lifetime's start is accounted for as
 * selected, absent or lost, with the evidence a receiver checks that account against. Lines the
 * closure already selected are never added twice; when the closure's bodies were released for the
 * budget, their bytes are still measured.
 */
function collectLifetimeAnchors(
  state: EngineState,
  closure: ClosureEvents,
  alreadySelected: (accepted: AcceptedLine) => boolean,
): ReadonlyMap<string, SupportLifetimeStart> {
  const evidence = lifetimeEvidence(state, closure);
  const { starts, beginnings, proofs } = evidence;
  for (const accepted of [...starts.values(), ...beginnings.values(), ...proofs.values()]) {
    if (!alreadySelected(accepted)) closure.collector.add(accepted, "context");
  }
  return new Map([...closure.lifetimes].map((key) => [key, lifetimeStart(evidence, key)]));
}

function lifetimeProvenance(
  starts: ReadonlyMap<string, SupportLifetimeStart>,
): readonly SupportLifetimeProvenance[] {
  return [...starts]
    .map(([key, start]) => {
      const [pid = "", instanceId = ""] = key.split(":");
      return { pid: Number(pid), instanceId, start };
    })
    .sort(compareLifetimes);
}

function contextScope(
  events: readonly SupportSelectedEvent[],
  selectedEvents: readonly SupportSelectedEvent[],
  contextMs: number,
): ContextScope | undefined {
  const lifetimes = new Set<string>();
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const key = lifetimeKey(event.parsed);
    if (key !== undefined) lifetimes.add(key);
    const ms = lineMs(event.parsed);
    first = Math.min(first, ms);
    last = Math.max(last, ms);
  }
  if (contextMs <= 0 || lifetimes.size === 0 || !Number.isFinite(first)) return undefined;
  const selected = new Set(selectedEvents.map((event) => eventKey(event.file, event.index)));
  const selectedTimes = [...new Set(events.map((event) => lineMs(event.parsed)))].sort(
    (a, b) => a - b,
  );
  return { fromMs: first - contextMs, toMs: last + contextMs, lifetimes, selected, selectedTimes };
}

function nearestSelectedTime(atMs: number, times: readonly number[]): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((times[middle] ?? Number.POSITIVE_INFINITY) < atMs) low = middle + 1;
    else high = middle;
  }
  return Math.min(
    Math.abs(atMs - (times[low] ?? Number.POSITIVE_INFINITY)),
    Math.abs(atMs - (times[low - 1] ?? Number.NEGATIVE_INFINITY)),
  );
}

function manifestMayHoldLifetimes(
  manifest: SegmentManifest,
  lifetimes: ReadonlySet<string>,
): boolean {
  if (!manifest.processes.complete) return true;
  return manifest.processes.entries.some((entry) =>
    lifetimes.has(`${String(entry.pid)}:${entry.instanceId}`),
  );
}

function isContextLine(
  accepted: AcceptedLine,
  scope: ContextScope,
  windows: readonly SupportQueryWindow[],
): boolean {
  if (
    knownCorrelation(accepted.parsed.correlationId) &&
    !isNonCausal(accepted.parsed) &&
    !(routineWindowActivity(accepted) && windows.some((window) => lineInWindow(window, accepted)))
  )
    return false;
  const key = lifetimeKey(accepted.parsed);
  if (key === undefined || !scope.lifetimes.has(key)) return false;
  const ms = lineMs(accepted.parsed);
  return (
    ms >= scope.fromMs &&
    ms <= scope.toMs &&
    !scope.selected.has(eventKey(accepted.line.file, accepted.line.index))
  );
}

// Optional context: the window is set by the closure's own events; required lines already
// selected (closure, window and lifetime anchors) are never selected twice.
function collectContext(
  state: EngineState,
  events: readonly SupportSelectedEvent[],
  selectedEvents: readonly SupportSelectedEvent[],
  budgetBytes: number,
  windows: readonly SupportQueryWindow[],
): ContextSelection {
  const { contextMs, maxContextEvents } = state.input.limits;
  const scope = contextScope(events, selectedEvents, contextMs);
  if (scope === undefined) return NO_CONTEXT;
  const files = candidateFiles(
    state,
    (loaded) =>
      manifestTimeOverlaps(loaded.manifest, scope.fromMs, scope.toMs) &&
      manifestMayHoldLifetimes(loaded.manifest, scope.lifetimes),
  );
  const recordBudget = Math.min(
    maxContextEvents,
    MAX_SUPPORT_REPORT_RECORDS - selectedEvents.length,
  );
  const collector = new ContextCollector(budgetBytes, recordBudget);
  for (const accepted of acceptedLines(state, files, true)) {
    if (!isContextLine(accepted, scope, windows)) continue;
    collector.add(accepted, nearestSelectedTime(lineMs(accepted.parsed), scope.selectedTimes));
  }
  const context = collector.events;
  const omitted = collector.candidateCount - context.length;
  return { events: context, omitted, truncated: omitted > 0 };
}

// ─── Event queries ─────────────────────────────────────────────────────────────────────────────

function hasCount(counts: SegmentManifest["ops"], name: string): boolean {
  return counts.some((entry) => entry.name === name);
}

// An absent filter member admits every segment; a present one must be listed by the manifest.
function listedOrUnfiltered(counts: SegmentManifest["ops"], wanted: string | undefined): boolean {
  return wanted === undefined || hasCount(counts, wanted);
}

function manifestMatchesTime(manifest: SegmentManifest, filter: SupportEventFilter): boolean {
  if (filter.fromMs === undefined && filter.toMs === undefined) return true;
  return manifestTimeOverlaps(
    manifest,
    filter.fromMs ?? Number.NEGATIVE_INFINITY,
    filter.toMs ?? Number.POSITIVE_INFINITY,
  );
}

function manifestMatchesParent(loaded: LoadedSegmentManifest, filter: SupportEventFilter): boolean {
  if (filter.parentCorrelationId === undefined) return true;
  return manifestMayContainAnyKey(loaded, [
    filterKeyHashes(parentCorrelationKey(filter.parentCorrelationId)),
  ]);
}

function manifestMatchesFilter(loaded: LoadedSegmentManifest, filter: SupportEventFilter): boolean {
  const { manifest } = loaded;
  return (
    listedOrUnfiltered(manifest.ops, filter.op) &&
    listedOrUnfiltered(manifest.errorKinds, filter.errorKind) &&
    listedOrUnfiltered(manifest.failureClasses, filter.failureClass) &&
    manifestMatchesTime(manifest, filter) &&
    manifestMatchesParent(loaded, filter)
  );
}

function lineMatchesTime(parsed: ParsedLine, filter: SupportEventFilter): boolean {
  const ms = lineMs(parsed);
  return (
    (filter.fromMs === undefined || ms >= filter.fromMs) &&
    (filter.toMs === undefined || ms <= filter.toMs)
  );
}

function equalOrUnfiltered(value: string | undefined, wanted: string | undefined): boolean {
  return wanted === undefined || value === wanted;
}

function lineMatchesFailureClass(op: string, failureClass: string | undefined): boolean {
  if (failureClass === undefined) return true;
  return activityLogOperationSchema(op)?.failureClasses.includes(failureClass) ?? false;
}

function lineMatchesFilter(parsed: ParsedLine, filter: SupportEventFilter): boolean {
  const { view } = parsed;
  return (
    equalOrUnfiltered(view.op, filter.op) &&
    equalOrUnfiltered(view.errorKind, filter.errorKind) &&
    equalOrUnfiltered(view.parentCorrelationId, filter.parentCorrelationId) &&
    lineMatchesFailureClass(view.op, filter.failureClass) &&
    lineMatchesTime(parsed, filter)
  );
}

function collectMatches(state: EngineState, filter: SupportEventFilter): EventCollector {
  const files = candidateFiles(state, (loaded) => manifestMatchesFilter(loaded, filter));
  const collector = new EventCollector(state.input.limits.maxResultBytes);
  for (const accepted of acceptedLines(state, files, true)) {
    if (lineMatchesFilter(accepted.parsed, filter)) collector.add(accepted, "match");
  }
  return collector;
}

// ─── Integrity and sufficiency ─────────────────────────────────────────────────────────────────

interface IntegrityAggregate {
  readonly summary: SupportQueryIntegrity;
  readonly input: ActivityLogSufficiencyIntegrity;
}

function addCounts(counts: MutableEvidenceCounts, manifest: SegmentManifest): void {
  const { evidence } = manifest;
  counts.supported += evidence.supportedLineCount;
  counts.legacy += evidence.legacyLineCount;
  counts.unsupported += evidence.unsupportedLineCount;
  counts.corrupt += evidence.corruptLineCount;
  counts.truncated += evidence.truncatedLineCount;
  counts.incomplete += evidence.incompleteLineCount;
}

function representativeAnomaly(kind: ProcessSequenceAnomaly["kind"]): ProcessSequenceAnomaly {
  return { kind, pid: 0, instanceId: "", fileIndex: 0, previousSeq: 0, seq: 0 };
}

function anomalyKinds(manifests: readonly SegmentManifest[]): readonly ProcessSequenceAnomaly[] {
  const kinds = new Set<ProcessSequenceAnomaly["kind"]>();
  for (const manifest of manifests) {
    const anomalies = manifest.evidence.sequenceAnomalies;
    for (const kind of ["gap", "duplicate", "decreasing", "reset"] as const) {
      if (anomalies[kind] > 0) kinds.add(kind);
    }
  }
  return [...kinds].map(representativeAnomaly);
}

function consultedManifests(state: EngineState): readonly SegmentManifest[] {
  const manifests: SegmentManifest[] = [];
  for (const file of state.input.files) {
    if (!state.consulted.has(file.name) || state.input.scanner.unreadable.has(file.name)) continue;
    const manifest =
      state.input.scanner.manifestOf(file) ?? state.input.manifests.get(file.name)?.manifest;
    if (manifest !== undefined) manifests.push(manifest);
  }
  return manifests;
}

// A manifest is deliberately self-contained (rebuildable from its own sealed segment alone), so its
// own `sequenceAnomalies` can only ever see anomalies WITHIN that one segment. A duplicate,
// decreasing, or reset `seq` for one (pid, instanceId) that lands exactly on a segment boundary —
// the segment that observed it ends, and the next one that continues its lifetime begins — is
// invisible to either manifest alone. Reconcile it here, across the manifests THIS query actually
// consulted, in their existing logical-log order, using only the boundary values every manifest
// already carries per process (`firstSeq`/`lastSeq`) — never reopening a segment body. A gap at a
// boundary stays tolerated, exactly as within one segment's own scan (an active segment is still
// growing, and `seq` is allocated process-wide, so a gap alone can be a write elsewhere).
type BoundaryAnomalyKind = Exclude<ProcessSequenceAnomaly["kind"], "gap">;

interface BoundaryAnomalies {
  readonly count: number;
  readonly kinds: ReadonlySet<BoundaryAnomalyKind>;
}

function processKey(pid: number, instanceId: string): string {
  return `${String(pid)}:${instanceId}`;
}

function boundaryAnomalyKinds(
  previousLastSeq: number,
  firstSeq: number,
): readonly BoundaryAnomalyKind[] {
  const kinds: BoundaryAnomalyKind[] = [];
  if (firstSeq === 1 && previousLastSeq > 1) kinds.push("reset");
  if (firstSeq < previousLastSeq) kinds.push("decreasing");
  if (firstSeq === previousLastSeq) kinds.push("duplicate");
  return kinds;
}

function processBoundaryAnomalies(manifests: readonly SegmentManifest[]): BoundaryAnomalies {
  const lastSeqByProcess = new Map<string, number>();
  const kinds = new Set<BoundaryAnomalyKind>();
  let count = 0;
  for (const manifest of manifests) {
    // An overflowed process list (more than the manifest's per-segment cap) carries no boundary
    // values at all: never guess continuity from an incomplete list.
    if (!manifest.processes.complete) continue;
    for (const process of manifest.processes.entries) {
      const key = processKey(process.pid, process.instanceId);
      const previousLastSeq = lastSeqByProcess.get(key);
      if (previousLastSeq !== undefined) {
        for (const kind of boundaryAnomalyKinds(previousLastSeq, process.firstSeq)) {
          kinds.add(kind);
          count += 1;
        }
      }
      lastSeqByProcess.set(key, process.lastSeq);
    }
  }
  return { count, kinds };
}

function aggregateIntegrity(state: EngineState): IntegrityAggregate {
  const manifests = consultedManifests(state);
  const counts = emptyEvidenceCounts();
  for (const manifest of manifests) addCounts(counts, manifest);
  const boundary = processBoundaryAnomalies(manifests);
  const anomalies = [...anomalyKinds(manifests), ...[...boundary.kinds].map(representativeAnomaly)];
  const classification = evidenceSummary(counts, anomalies).classification;
  const anomalyCount =
    manifests.reduce((sum, manifest) => {
      const { gap, duplicate, decreasing, reset } = manifest.evidence.sequenceAnomalies;
      return sum + gap + duplicate + decreasing + reset;
    }, 0) + boundary.count;
  return {
    summary: {
      classification,
      consultedFileCount: manifests.length,
      supportedLineCount: counts.supported,
      legacyLineCount: counts.legacy,
      unsupportedLineCount: counts.unsupported,
      corruptLineCount: counts.corrupt,
      truncatedLineCount: counts.truncated,
      incompleteLineCount: counts.incomplete,
      sequenceAnomalyCount: anomalyCount,
      ...ACTIVITY_LOG_EVIDENCE_INTEGRITY[classification],
    },
    input: {
      corruptLineCount: counts.corrupt,
      truncatedLineCount: counts.truncated,
      unsupportedLineCount: counts.unsupported,
      incompleteLineCount: counts.incomplete,
      sequenceAnomalies: anomalies,
    },
  };
}

function orderedReasons(
  reasons: Iterable<DiagnosticSufficiencyReason>,
): readonly DiagnosticSufficiencyReason[] {
  const present = new Set(reasons);
  return DIAGNOSTIC_SUFFICIENCY_REASONS.filter((reason) => present.has(reason));
}

function requiredClassList(
  required: SupportRequiredClasses,
  events: readonly SupportSelectedEvent[],
): readonly string[] | undefined {
  if (required.kind === "observed") return undefined;
  if (required.kind === "declared") return required.failureClasses;
  const failureOps = events
    .map((event) => event.parsed.view.op)
    .filter((op) => activityLogOperationSchema(op)?.lifecycle === "failure");
  return activityLogFailureClassesOf(failureOps);
}

interface SufficiencyOutcome {
  readonly diagnosticSufficiency: SupportQueryResult["diagnosticSufficiency"];
  readonly coverage: SupportQueryResult["coverage"];
}

function emptyCoverage(requiredClassCount: number): SupportQueryResult["coverage"] {
  return {
    requiredClassCount,
    presentClassCount: 0,
    completeClassCount: 0,
    degradedClassCount: 0,
    insufficientClassCount: 0,
  };
}

function selectionSufficiency(
  events: readonly SupportSelectedEvent[],
  integrity: ActivityLogSufficiencyIntegrity,
  required: SupportRequiredClasses,
  selectionReasons: readonly DiagnosticSufficiencyReason[],
): SufficiencyOutcome {
  const requiredClasses = requiredClassList(required, events);
  if (events.length === 0) {
    const reasons = orderedReasons(
      selectionReasons.length > 0 ? selectionReasons : ["no-registered-evidence"],
    );
    return {
      diagnosticSufficiency: { status: diagnosticSufficiencyStatus(reasons), reasons, classes: [] },
      coverage: emptyCoverage(requiredClasses?.length ?? 0),
    };
  }
  const projected = projectActivityLogSufficiency(
    events.map((event) => sufficiencyLine(event.parsed)),
    integrity,
  );
  const narrowed =
    requiredClasses === undefined
      ? projected
      : restrictActivityLogSufficiency(projected, requiredClasses);
  const reasons = orderedReasons([...narrowed.reasons, ...selectionReasons]);
  return {
    diagnosticSufficiency: {
      status: diagnosticSufficiencyStatus(reasons),
      reasons,
      classes: narrowed.classes,
    },
    coverage: {
      requiredClassCount: requiredClasses?.length ?? narrowed.coverage.observedClassCount,
      presentClassCount: narrowed.coverage.observedClassCount,
      completeClassCount: narrowed.coverage.completeClassCount,
      degradedClassCount: narrowed.coverage.degradedClassCount,
      insufficientClassCount: narrowed.coverage.insufficientClassCount,
    },
  };
}

// ─── Running a selection ───────────────────────────────────────────────────────────────────────

interface SelectionOutcome {
  readonly events: readonly SupportSelectedEvent[];
  readonly candidateEventCount: number;
  readonly requiredBytes: number;
  readonly requiredRecordCount: number;
  readonly omittedContextEventCount: number;
  readonly truncation: SupportQueryTruncation;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly required: SupportRequiredClasses;
  readonly closure: SupportQueryResult["closure"];
  readonly lifetimes: readonly SupportLifetimeProvenance[];
}

function closureSummary(
  closure: ClosureState,
  events: ClosureEvents | undefined,
  passCount: number,
): NonNullable<SupportQueryResult["closure"]> {
  const roles = [...closure.members.values()];
  const count = (role: ClosureRole): number => roles.filter((entry) => entry === role).length;
  const observed = events?.observed ?? new Set<string>();
  const edges = [...(events?.edges ?? new Set<string>())].sort(compareText).map((edge) => {
    const [parentCorrelationId = "", correlationId = ""] = edge.split("\u0000");
    return { parentCorrelationId, correlationId };
  });
  return {
    correlationCount: closure.members.size,
    rootCount: count("root"),
    ancestorCount: count("ancestor"),
    descendantCount: count("descendant"),
    missingCorrelationCount: [...closure.members.keys()].filter((id) => !observed.has(id)).length,
    passCount,
    edges,
  };
}

function missingClosureReasons(
  closure: ClosureState,
  observed: ReadonlySet<string>,
): readonly DiagnosticSufficiencyReason[] {
  const reasons: DiagnosticSufficiencyReason[] = [];
  for (const [id, role] of closure.members) {
    if (observed.has(id)) continue;
    reasons.push(role === "ancestor" ? "parent-correlation-missing" : "evidence-not-retained");
  }
  return reasons;
}

// A closure that streamed to completion still knows exactly which members it observed and which
// edges it found — only the event bodies were dropped for exceeding the byte budget. Passing that
// already-collected `ClosureEvents` keeps `closureSummary` from reporting a fully-resolved closure
// as if every correlation were missing (indistinguishable from real evidence loss). When nothing
// was collected yet (the closure itself exceeded the correlation bound before any event streaming
// ran), `collected` is omitted and the summary falls back to "nothing observed", which is accurate.
function budgetExceededOutcome(
  selection: SupportClosureSelection,
  closure: ClosureState,
  state: EngineState,
  requiredBytes: number,
  collected?: ClosureEvents,
): SelectionOutcome {
  return {
    events: [],
    candidateEventCount: collected?.collector.candidateCount ?? 0,
    requiredBytes,
    requiredRecordCount: collected?.collector.candidateCount ?? 0,
    omittedContextEventCount: 0,
    truncation: "budget-exceeded",
    reasons: ["report-budget-exceeded"],
    required: selection.requiredClasses,
    closure: closureSummary(closure, collected, state.passCount),
    lifetimes: [],
  };
}

// A closure is never partially selected. Its lifetimes are bounded like its correlations: beyond
// that bound the starts cannot all be measured, so the requirement is stated as unknown (0).
function closureOverflow(
  state: EngineState,
  selection: SupportClosureSelection,
  closure: ClosureState,
  collected: ClosureEvents,
): SelectionOutcome | undefined {
  if (collected.lifetimesExceeded)
    return budgetExceededOutcome(selection, closure, state, 0, collected);
  if (!collected.collector.exceeded) return undefined;
  const { requiredBytes } = collected.collector;
  return budgetExceededOutcome(selection, closure, state, requiredBytes, collected);
}

function runClosureSelection(
  state: EngineState,
  selection: SupportClosureSelection,
): SelectionOutcome {
  const windowed = windowRoots(state, selection.windows);
  const closure = computeClosure(state, [...new Set([...selection.roots, ...windowed.roots])]);
  if (closure.exceeded || windowed.exceeded)
    return budgetExceededOutcome(selection, closure, state, 0);
  const collected = collectClosureEvents(state, closure.members, selection.windows);
  const closureEvents = [...collected.collector.events];
  const starts = collected.lifetimesExceeded
    ? new Map<string, SupportLifetimeStart>()
    : collectLifetimeAnchors(
        state,
        collected,
        (accepted) => closureRole(accepted, closure.members, selection.windows) !== undefined,
      );
  const overflow = closureOverflow(state, selection, closure, collected);
  if (overflow !== undefined) return overflow;
  const remaining = state.input.limits.maxResultBytes - collected.collector.requiredBytes;
  const context = collectContext(
    state,
    closureEvents,
    collected.collector.events,
    remaining,
    selection.windows,
  );
  const reasons: DiagnosticSufficiencyReason[] = [
    ...missingClosureReasons(closure, collected.observed),
  ];
  if (selection.unresolved || [...starts.values()].includes("lost"))
    reasons.push("evidence-not-retained");
  if (context.truncated) reasons.push("context-truncated");
  const events = [...collected.collector.events, ...context.events].sort(
    (left, right) => left.file.order - right.file.order || left.index - right.index,
  );
  return {
    events,
    candidateEventCount:
      collected.collector.candidateCount + context.events.length + context.omitted,
    requiredBytes: collected.collector.requiredBytes,
    requiredRecordCount: collected.collector.candidateCount,
    omittedContextEventCount: context.omitted,
    truncation: context.truncated ? "context-truncated" : "none",
    reasons,
    required: selection.requiredClasses,
    closure: closureSummary(closure, collected, state.passCount),
    lifetimes: lifetimeProvenance(starts),
  };
}

function runEventSelection(state: EngineState, selection: SupportEventSelection): SelectionOutcome {
  const collector = collectMatches(state, selection.filter);
  return {
    events: collector.exceeded ? [] : collector.events,
    candidateEventCount: collector.candidateCount,
    requiredBytes: collector.requiredBytes,
    requiredRecordCount: collector.candidateCount,
    omittedContextEventCount: 0,
    truncation: collector.exceeded ? "budget-exceeded" : "none",
    reasons: collector.exceeded ? ["report-budget-exceeded"] : [],
    required: { kind: "observed" },
    closure: null,
    lifetimes: [],
  };
}

function segmentSummary(state: EngineState): SupportQueryResult["segments"] {
  const { files, manifestStats, scanner } = state.input;
  const unreadable = [...state.candidates].filter((name) => scanner.unreadable.has(name)).length;
  return {
    total: files.length,
    sealed: files.filter((file) => file.kind === "sealed").length,
    active: files.filter((file) => file.kind === "active").length,
    legacy: files.filter((file) => file.kind === "legacy-archive" || file.kind === "legacy-current")
      .length,
    candidate: state.candidates.size,
    pruned: files.length - state.candidates.size,
    opened: scanner.opened.size,
    unreadable,
    manifestsReused: manifestStats.reusedCount,
    manifestsBuilt: manifestStats.builtCount + manifestStats.replacedCount,
    manifestsRemoved: manifestStats.removedOrphanCount,
  };
}

function roleCount(events: readonly SupportSelectedEvent[], role: SupportQueryEventRole): number {
  return events.filter((event) => event.role === role).length;
}

function lossEventCount(events: readonly SupportSelectedEvent[]): number {
  return events.filter(
    (event) => activityLogOperationSchema(event.parsed.view.op)?.lifecycle === "loss",
  ).length;
}

function withUnreadable(
  state: EngineState,
  reasons: readonly DiagnosticSufficiencyReason[],
): readonly DiagnosticSufficiencyReason[] {
  const unreadable = [...state.candidates].some((name) => state.input.scanner.unreadable.has(name));
  return unreadable ? [...reasons, "segment-unreadable"] : reasons;
}

function queryTruncation(outcome: SelectionOutcome): SupportQueryResult["truncation"] {
  return {
    state: outcome.truncation,
    omittedContextEventCount: outcome.omittedContextEventCount,
    requiredBytes: outcome.requiredBytes,
    requiredRecordCount: outcome.requiredRecordCount,
  };
}

function queryResult(
  state: EngineState,
  outcome: SelectionOutcome,
  queryClass: SupportQueryClass,
): SupportQueryResult {
  const integrity = aggregateIntegrity(state);
  const sufficiency = selectionSufficiency(
    outcome.events,
    integrity.input,
    outcome.required,
    withUnreadable(state, outcome.reasons),
  );
  const selectedBytes = outcome.events.reduce((sum, event) => sum + event.bytes, 0);
  return {
    kind: SUPPORT_QUERY_KIND,
    schemaVersion: SUPPORT_QUERY_SCHEMA_VERSION,
    provenance: {
      productVersion: KEIKO_PRODUCT_VERSION,
      registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
      schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
      catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
      manifestSchemaVersion: SEGMENT_MANIFEST_SCHEMA_VERSION,
    },
    query: {
      class: queryClass,
      limits: { ...state.input.limits, maxResultRecords: MAX_SUPPORT_REPORT_RECORDS },
    },
    segments: segmentSummary(state),
    closure: outcome.closure,
    lifetimes: outcome.lifetimes,
    integrity: integrity.summary,
    loss: { state: integrity.summary.loss, lossEventCount: lossEventCount(outcome.events) },
    truncation: queryTruncation(outcome),
    coverage: sufficiency.coverage,
    diagnosticSufficiency: sufficiency.diagnosticSufficiency,
    metrics: {
      candidateEventCount: outcome.candidateEventCount,
      resultEventCount: outcome.events.length,
      closureEventCount: roleCount(outcome.events, "closure"),
      windowEventCount: roleCount(outcome.events, "window"),
      contextEventCount: roleCount(outcome.events, "context"),
      selectedBytes,
      scannedBytes: state.input.scanner.scannedBytes,
      scannedLineCount: state.input.scanner.scannedLines,
    },
    events: outcome.events,
  };
}

/** Runs one selection over the store. Pure over its inputs: every read goes through `scanner`. */
export function runSupportQuery(input: SupportQueryInput): SupportQueryResult {
  const state: EngineState = {
    input,
    candidates: new Set(),
    consulted: new Set(),
    passCount: 0,
  };
  const { selection } = input;
  const outcome =
    selection.kind === "closure"
      ? runClosureSelection(state, selection)
      : runEventSelection(state, selection);
  return queryResult(state, outcome, selection.queryClass);
}

// ─── Machine and human projections ─────────────────────────────────────────────────────────────

export interface SupportQueryJsonEvent {
  readonly role: SupportQueryEventRole;
  readonly file: string;
  readonly line: number;
  readonly record: unknown;
}

/** The versioned machine form. Every event is the persisted Activity Log record, parsed as-is. */
export function supportQueryJson(result: SupportQueryResult): unknown {
  const events: SupportQueryJsonEvent[] = result.events.map((event) => ({
    role: event.role,
    file: event.file.name,
    line: event.index,
    record: JSON.parse(event.text) as unknown,
  }));
  return { ...result, events };
}

function renderEvent(event: SupportSelectedEvent): string {
  const { view } = event.parsed;
  const seq = view.seq === undefined ? "-" : String(view.seq);
  const errorKind = view.errorKind === undefined ? "" : ` [${view.errorKind}]`;
  return `  ${view.ts} ${seq} ${view.level ?? "-"} ${view.category} ${view.op}${errorKind} (${event.role})`;
}

/** The human report, derived only from the machine result. */
export function renderSupportQuery(result: SupportQueryResult): string {
  const sufficiency = result.diagnosticSufficiency;
  const reasons = sufficiency.reasons.length === 0 ? "" : ` (${sufficiency.reasons.join(", ")})`;
  const { segments, integrity, metrics } = result;
  const lines = [
    `Query: ${result.query.class} (${result.kind} v${String(result.schemaVersion)})`,
    `Diagnostic sufficiency: ${sufficiency.status}${reasons}`,
    `Evidence: ${integrity.classification} (completeness ${integrity.completeness}, loss ${integrity.loss})`,
    `Segments: ${String(segments.total)} total, ${String(segments.candidate)} candidate, ` +
      `${String(segments.pruned)} pruned by manifest, ${String(segments.unreadable)} unreadable`,
  ];
  if (result.closure !== null) {
    lines.push(
      `Closure: ${String(result.closure.correlationCount)} correlation(s), ` +
        `${String(result.closure.missingCorrelationCount)} without retained events`,
    );
  }
  lines.push(
    `Events: ${String(metrics.resultEventCount)} (${String(metrics.selectedBytes)} bytes), ` +
      `truncation ${result.truncation.state}; required ${String(result.truncation.requiredRecordCount)} records ` +
      `(${String(result.truncation.requiredBytes)} bytes)`,
  );
  return `${[...lines, ...result.events.map(renderEvent)].join("\n")}\n`;
}
