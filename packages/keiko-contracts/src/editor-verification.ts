// Editor verification run/event envelope (Issue #2210, Epic #2092, ADR-0126 D1). This leaf wraps the
// existing, unmodified keiko-verification plan/run/report contracts with an editor-scoped run
// identity, a strongly typed lifecycle-event discriminated union, and a start-run request the route
// (Issue #2211) parses at its trust boundary. It composes the command-runner SSE TRANSPORT pattern
// (framing, ref-counted EventSource) while giving the payload a discriminated union instead of
// CommandRunnerEvent's Record<string, unknown> bag, per this repository's no-any / discriminated-union
// bar. Leaf-package rule (ADR-0019): no @oscharko-dev/keiko-* imports; pure types + guards only.
//
// Content-free lifecycle events (ADR-0126 D1): every non-terminal event carries only closed-shape,
// content-free fields; only the terminal run-completed event carries the already-redacted
// VerificationReport. A step event never embeds the full VerificationResult (which holds outputSummary).

import { COMMAND_TASK_TRUST_STATES, type CommandTaskTrustState } from "./command-runner.js";
import { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath } from "./editor-agent-path.js";
import type { VerificationKind, VerificationReport, VerificationStatus } from "./verification.js";

export const EDITOR_VERIFICATION_SCHEMA_VERSION = "1" as const;

// Bounds enforced at the request trust boundary. MAX_KINDS matches the closed VerificationKind set;
// no free-form argv or open-ended kind list is ever accepted (Epic #2092 Non-goals).
export const EDITOR_VERIFICATION_MAX_KINDS = 5;
export const EDITOR_VERIFICATION_MAX_REQUEST_ID_LENGTH = 128;
export const EDITOR_VERIFICATION_REASON_MAX_CHARS = 256;

const EDITOR_VERIFICATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const EDITOR_VERIFICATION_TEXT_ENCODER = new TextEncoder();

// Canonical runtime list of the closed kind set. `satisfies` keeps every member a real
// VerificationKind; the type layer owns the union, this owns its runtime witness (no array exists in
// verification.ts, which is pure types + frozen limits).
export const EDITOR_VERIFICATION_KINDS: readonly VerificationKind[] = Object.freeze([
  "test",
  "targeted-test",
  "typecheck",
  "lint",
  "build",
] as const satisfies readonly VerificationKind[]);

const EDITOR_VERIFICATION_STATUSES: readonly VerificationStatus[] = Object.freeze([
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
] as const satisfies readonly VerificationStatus[]);

// ─── Run identity + request ───────────────────────────────────────────────────────

export type EditorVerificationRunState =
  "pending" | "running" | "completed" | "cancelled" | "failed";

export const EDITOR_VERIFICATION_RUN_STATES: readonly EditorVerificationRunState[] = Object.freeze([
  "pending",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly EditorVerificationRunState[]);

// The client-supplied start-run body. `targetPath` applies to file-targeted kinds (targeted-test);
// `requestId` is an optional correlation token echoed on run-started, mirroring CommandTaskRunRequest.
export interface EditorVerificationRunRequest {
  readonly kinds: readonly VerificationKind[];
  readonly targetPath?: string | undefined;
  readonly requestId?: string | undefined;
}

// The registry-tracked run identity (Issue #2211's VerificationRunnerManager is the concrete producer).
export interface EditorVerificationRun {
  readonly runId: string;
  // Epic #2092 fix-up: which project root this run belongs to. Every run always has one — required,
  // not optional — so a multi-window client can scope run state per project instead of a single
  // process-wide singleton (the epic's Architecture Invariants require multi-window support).
  readonly projectId: string;
  readonly kinds: readonly VerificationKind[];
  readonly targetPath?: string | undefined;
  readonly state: EditorVerificationRunState;
  readonly startedAtMs: number;
  // Echoes EditorVerificationRunRequest.requestId when the caller supplied one (correlation only;
  // never used as authority). Mirrors CommandTaskRunRequest's requestIdPayload() convention.
  readonly requestId?: string | undefined;
}

// A content-free projection of the detected scripts for a project root (Issue #2211's catalog route,
// consumed by Issue #2212's run affordances). Per kind: whether it is runnable and its server-owned
// trust state. Script-backed kinds carry the workspace-trust decision; targeted-test is exempt.
// This reuses (not redeclares) `CommandTaskTrustState` (command-runner.ts, Issue #1387): both model
// the identical "server-owned trust decision for a discovered, executable script" concept, and an
// alias keeps the two forced to stay in sync instead of able to drift independently (ADR-0126 D1).
export type EditorVerificationTrustState = CommandTaskTrustState;

export interface EditorVerificationCatalogEntry {
  readonly kind: VerificationKind;
  readonly available: boolean;
  readonly trustState: EditorVerificationTrustState;
}

export interface EditorVerificationCatalog {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly kinds: readonly EditorVerificationCatalogEntry[];
}

// ─── Lifecycle events (discriminated union) ─────────────────────────────────────────

export type EditorVerificationEventKind =
  | "run-started"
  | "step-started"
  | "step-completed"
  | "run-completed"
  | "run-cancelled"
  | "run-failed";

export const EDITOR_VERIFICATION_EVENT_KINDS: readonly EditorVerificationEventKind[] =
  Object.freeze([
    "run-started",
    "step-started",
    "step-completed",
    "run-completed",
    "run-cancelled",
    "run-failed",
  ] as const satisfies readonly EditorVerificationEventKind[]);

export interface EditorVerificationRunStartedEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "run-started";
  readonly runId: string;
  // Epic #2092 fix-up: lets a multi-window client route this run's lifecycle (this event plus every
  // later step/terminal event correlated by runId) to the correct per-project state instead of one
  // process-wide singleton. Only run-started needs it on the wire — later events are looked up by
  // runId against the mapping this event established.
  readonly projectId: string;
  readonly kinds: readonly VerificationKind[];
  readonly targetPath?: string | undefined;
  readonly startedAtMs: number;
  // Echoes EditorVerificationRunRequest.requestId when the caller supplied one.
  readonly requestId?: string | undefined;
}

export interface EditorVerificationStepStartedEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "step-started";
  readonly runId: string;
  readonly stepKind: VerificationKind;
}

// Content-free: status + duration only, never the VerificationResult's outputSummary (ADR-0126 D1).
export interface EditorVerificationStepCompletedEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "step-completed";
  readonly runId: string;
  readonly stepKind: VerificationKind;
  readonly status: VerificationStatus;
  readonly durationMs: number;
}

// The one terminal event carrying the full, already-redacted report.
export interface EditorVerificationRunCompletedEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "run-completed";
  readonly runId: string;
  readonly report: VerificationReport;
}

export interface EditorVerificationRunCancelledEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "run-cancelled";
  readonly runId: string;
}

export interface EditorVerificationRunFailedEvent {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly kind: "run-failed";
  readonly runId: string;
  // Bounded, content-free failure reason code/message (never raw stdout/stderr).
  readonly reason: string;
}

export type EditorVerificationEvent =
  | EditorVerificationRunStartedEvent
  | EditorVerificationStepStartedEvent
  | EditorVerificationStepCompletedEvent
  | EditorVerificationRunCompletedEvent
  | EditorVerificationRunCancelledEvent
  | EditorVerificationRunFailedEvent;

// ─── Guards + parser (hand-rolled, throw-free, deterministic) ────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isVerificationKind(value: unknown): value is VerificationKind {
  return (
    typeof value === "string" && (EDITOR_VERIFICATION_KINDS as readonly string[]).includes(value)
  );
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    typeof value === "string" && (EDITOR_VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isEditorVerificationRunState(value: unknown): value is EditorVerificationRunState {
  return (
    typeof value === "string" &&
    (EDITOR_VERIFICATION_RUN_STATES as readonly string[]).includes(value)
  );
}

export function isEditorVerificationEventKind(
  value: unknown,
): value is EditorVerificationEventKind {
  return (
    typeof value === "string" &&
    (EDITOR_VERIFICATION_EVENT_KINDS as readonly string[]).includes(value)
  );
}

function isBoundedTargetPath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    EDITOR_VERIFICATION_TEXT_ENCODER.encode(value).length <= EDITOR_AGENT_TARGET_PATH_MAX_BYTES &&
    isContainedAgentPath(value)
  );
}

function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= EDITOR_VERIFICATION_MAX_REQUEST_ID_LENGTH &&
    EDITOR_VERIFICATION_REQUEST_ID_PATTERN.test(value)
  );
}

function isKindArray(value: unknown): value is readonly VerificationKind[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= EDITOR_VERIFICATION_MAX_KINDS &&
    value.every(isVerificationKind) &&
    new Set(value).size === value.length
  );
}

export interface EditorVerificationRunRequestParseOk {
  readonly ok: true;
  readonly value: EditorVerificationRunRequest;
}

export interface EditorVerificationRunRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type EditorVerificationRunRequestParse =
  EditorVerificationRunRequestParseOk | EditorVerificationRunRequestParseFail;

// Parses a start-run request at the trust boundary. Collects all field errors in a fixed order
// (deterministic strings for tests); never throws. Mirrors parseCommandTaskRunRequest.
export function parseEditorVerificationRunRequest(
  input: unknown,
): EditorVerificationRunRequestParse {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors: string[] = [];
  if (!isKindArray(input.kinds)) {
    errors.push(
      `kinds must be a unique, non-empty array of up to ${String(EDITOR_VERIFICATION_MAX_KINDS)} verification kinds`,
    );
  }
  if (input.targetPath !== undefined && !isBoundedTargetPath(input.targetPath)) {
    errors.push("targetPath must be a bounded, workspace-contained path when present");
  }
  if (input.requestId !== undefined && !isValidRequestId(input.requestId)) {
    errors.push(
      `requestId must be a token of 1-${String(EDITOR_VERIFICATION_MAX_REQUEST_ID_LENGTH)} characters when present`,
    );
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: canonicalRunRequest(input) };
}

function canonicalRunRequest(input: Record<string, unknown>): EditorVerificationRunRequest {
  const kinds = [...(input.kinds as readonly VerificationKind[])];
  return {
    kinds,
    ...(typeof input.targetPath === "string" ? { targetPath: input.targetPath } : {}),
    ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
  };
}

export function isEditorVerificationRun(value: unknown): value is EditorVerificationRun {
  if (!isRecord(value)) return false;
  return [
    isNonEmptyString(value.runId),
    isNonEmptyString(value.projectId),
    isKindArray(value.kinds),
    value.targetPath === undefined || isBoundedTargetPath(value.targetPath),
    isEditorVerificationRunState(value.state),
    isFiniteNonNegative(value.startedAtMs),
    value.requestId === undefined || isValidRequestId(value.requestId),
  ].every(Boolean);
}

function isCatalogEntry(value: unknown): value is EditorVerificationCatalogEntry {
  return (
    isRecord(value) &&
    isVerificationKind(value.kind) &&
    typeof value.available === "boolean" &&
    (COMMAND_TASK_TRUST_STATES as readonly string[]).includes(value.trustState as string)
  );
}

export function isEditorVerificationCatalog(value: unknown): value is EditorVerificationCatalog {
  return (
    isRecord(value) &&
    value.schemaVersion === EDITOR_VERIFICATION_SCHEMA_VERSION &&
    isNonEmptyString(value.projectId) &&
    Array.isArray(value.kinds) &&
    value.kinds.every(isCatalogEntry)
  );
}

// Light structural check on the terminal report envelope. Deep field validation stays with
// keiko-verification (the trusted producer); the guard rejects a malformed SSE frame at the boundary.
function isVerificationReportShape(value: unknown): value is VerificationReport {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspaceRoot) &&
    Array.isArray(value.results) &&
    typeof value.overallStatus === "string" &&
    isRecord(value.counts)
  );
}

function isRunStartedEvent(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.projectId) &&
    isKindArray(value.kinds) &&
    (value.targetPath === undefined || isBoundedTargetPath(value.targetPath)) &&
    isFiniteNonNegative(value.startedAtMs) &&
    (value.requestId === undefined || isValidRequestId(value.requestId))
  );
}

function isStepEvent(value: Record<string, unknown>, completed: boolean): boolean {
  if (!isNonEmptyString(value.runId) || !isVerificationKind(value.stepKind)) return false;
  if (!completed) return true;
  return isVerificationStatus(value.status) && isFiniteNonNegative(value.durationMs);
}

function isTerminalEvent(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case "run-completed":
      return isNonEmptyString(value.runId) && isVerificationReportShape(value.report);
    case "run-cancelled":
      return isNonEmptyString(value.runId);
    case "run-failed":
      return (
        isNonEmptyString(value.runId) &&
        typeof value.reason === "string" &&
        value.reason.length <= EDITOR_VERIFICATION_REASON_MAX_CHARS
      );
    default:
      return false;
  }
}

// Structural guard over the full lifecycle-event union. Validates the shared envelope
// (schemaVersion, kind) then the payload of each discriminant. Pure and throw-free.
export function isEditorVerificationEvent(value: unknown): value is EditorVerificationEvent {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== EDITOR_VERIFICATION_SCHEMA_VERSION) return false;
  switch (value.kind) {
    case "run-started":
      return isRunStartedEvent(value);
    case "step-started":
      return isStepEvent(value, false);
    case "step-completed":
      return isStepEvent(value, true);
    case "run-completed":
    case "run-cancelled":
    case "run-failed":
      return isTerminalEvent(value);
    default:
      return false;
  }
}
