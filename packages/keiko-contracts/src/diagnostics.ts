// Wire contract for `POST /api/diagnostics/client` (Wave 5 of epic #3233, ADR-0173).
//
// The browser is untrusted input, so this shape — and its guard — live in the leaf contracts
// layer like every other request shape the server accepts from a client it does not control
// (ADR-0019). `correlationId` is the fatal-flaw fix all three design-panel judges independently
// flagged as missing: it is what lets an agent deterministically join a browser crash report to
// the specific failed server request it is reporting on, instead of fuzzy timestamp matching. It
// is DESIGNED to be populated from the same correlation id already threaded into every
// `ApiError`/SSE event (`packages/keiko-ui/src/lib/http.ts`), and is re-validated server-side with
// `isValidCorrelationId` before it is trusted — this guard only admits its general SHAPE (a short,
// bounded string), never the full correlation-id policy, which is server plumbing
// (`packages/keiko-server/src/correlation.ts`), not a wire concern.
//
// `install-client-diagnostics.ts` is the only place a `ClientDiagnosticIngestRequest` is built.
// `reportClientDiagnostic` (client-diagnostics.ts) takes optional structured metadata: the
// originating correlation id and, for Git-change description responses, a closed body-free
// response identity. Every call site that catches an `ApiError` (which
// `bffFetchJson`, keiko-ui's http.ts, stamps a `.correlationId` on for every non-2xx and every
// contract-validation failure) passes it through via `correlationIdOf(error)`
// (client-error-summary.ts). `install-client-diagnostics.ts` re-validates the shape client-side
// before putting it on the wire. It stays genuinely absent for the four SSE `onerror` call sites
// (sharedEventSource.ts, useSSE.ts, coding-workbench-event-retention.ts,
// useRelationshipActivityStream.ts): the native `EventSource` API exposes no response headers to
// page script, so there is no id to recover there — a hard platform limit, not a wiring gap.
//
// This guard is a promise about SHAPE only, never about the CONTENT of `message`. The browser-side
// sink's own doc comment promises an already-redacted string, but that promise is a library
// contract on the browser side — never a trust boundary the server may rely on. The server treats
// `message` as hostile regardless, and writes it under `extra.clientNote`, never `extra.message`
// (`"message"` is on `log-redaction.ts`'s `DENIED_FIELD_NAMES` and would collapse to
// `[redacted:key]` even though the value is already length-bounded here); the existing log-value
// guards (length/secret/personal/prose/path) do the actual content safety work on `clientNote`.

// EventSource.readyState at the moment the browser observed the failure: CONNECTING (0), OPEN (1)
// or CLOSED (2). A closed vocabulary, not a raw number, so a future EventSource-shaped value can
// never smuggle an out-of-range number onto the wire.
export const CLIENT_DIAGNOSTIC_READY_STATES = [0, 1, 2] as const;
export type ClientDiagnosticReadyState = (typeof CLIENT_DIAGNOSTIC_READY_STATES)[number];

// Closed, body-free failure vocabulary shared by the Linux gateway launcher and the server log
// adapter (#3422, ADR-0043 D12). This crosses a package boundary, so the leaf contracts layer owns
// both the wire values and the guard; neither producer nor consumer may widen it independently.
export const LINUX_GATEWAY_DIAGNOSTIC_KINDS = [
  "cleanup-failed",
  "host-relay-failed",
  "internal-failure",
  "invalid-backend",
  "invalid-command",
  "invalid-cwd",
  "invalid-gateway-host",
  "invalid-gateway-port",
  "invalid-mode",
  "loopback-setup-failed",
  "loopback-tool-unavailable",
  "namespace-relay-failed",
  "unsupported-platform",
] as const;
export type LinuxGatewayDiagnosticKind = (typeof LINUX_GATEWAY_DIAGNOSTIC_KINDS)[number];

// What raised the diagnostic: a caught render-boundary error, an unhandled promise rejection, an
// uncaught `window` error event, an SSE transport failure, or anything else a call site does not
// further classify.
export const CLIENT_DIAGNOSTIC_KINDS = [
  "boundary",
  "unhandled-rejection",
  "window-error",
  "sse-error",
  "other",
] as const;
export type ClientDiagnosticKind = (typeof CLIENT_DIAGNOSTIC_KINDS)[number];

// Browser-side delivery loss the page counted since its previous accepted report (#3532). Each
// value is a bounded non-negative count, never content: the pre-transport buffer evicting its
// oldest record, the client-side POST throttle dropping a report, a POST that failed, and
// unhandled rejections or `window` errors beyond the per-session reporting cap. The server adds
// them to its bounded loss ledger and records them on the `client.diagnostic` line, so a report
// that arrives after a storm also says how much of that storm never reached the Activity Log.
export const CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS = [
  "bufferEvicted",
  "postsThrottled",
  "postsFailed",
  "rejectionsSuppressed",
  "errorsSuppressed",
] as const;
export type ClientDiagnosticLossCountKey = (typeof CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS)[number];

// A count above this ceiling is clamped by the sender and refused by the guard, so a hostile page
// cannot inflate the server's loss ledger with an arbitrary number.
export const CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX = 1_000_000;

export type ClientDiagnosticLossCounts = Readonly<
  Partial<Record<ClientDiagnosticLossCountKey, number | undefined>>
>;

export const CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_ACTIONS = [
  "review",
  "approve",
  "apply",
] as const;
export type ClientDiagnosticGitChangeDescriptionAction =
  (typeof CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_ACTIONS)[number];

export const CLIENT_DIAGNOSTIC_RESPONSE_DISPOSITIONS = ["accepted", "discarded"] as const;
export type ClientDiagnosticResponseDisposition =
  (typeof CLIENT_DIAGNOSTIC_RESPONSE_DISPOSITIONS)[number];

export const CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_OUTCOMES = [
  "preview",
  "approved",
  "observed",
  "blocked",
] as const;
export type ClientDiagnosticGitChangeDescriptionOutcome =
  (typeof CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_OUTCOMES)[number];

export interface ClientDiagnosticGitChangeDescription {
  readonly action: ClientDiagnosticGitChangeDescriptionAction;
  readonly disposition: ClientDiagnosticResponseDisposition;
  readonly relationshipId: string;
  readonly snapshotDigest: string;
  readonly proposalId: string;
  readonly outcome: ClientDiagnosticGitChangeDescriptionOutcome;
}

/** Body-free identity of the server-validated task-workspace repository selected for trust. */
export interface ClientDiagnosticWorkspaceTrustBinding {
  readonly repositoryId: string;
  readonly workspaceId: string;
}

// The browser-side sink already bounds a diagnostic message to this length (client-diagnostics.ts,
// `reportClientDiagnostic`); the server enforces the SAME bound independently rather than trusting
// the browser's own promise, per this module's header.
export const CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 200;

// The longest client note the activity log keeps verbatim (keiko-server log-redaction.ts,
// `MAX_LOG_STRING_LENGTH`). A longer note is redacted whole, so a producer that wants its note read
// stays within it (review on PR #3452).
export const CLIENT_NOTE_MAX_LENGTH = 160;

// The only error classes a client note may name (review on PR #3452): the JavaScript built-ins, the
// errors the browser platform raises, the classes Keiko's own browser code throws, and the `typeof`
// of a thrown non-Error. A name is text the error chose, so any other name travels as "Error": a
// hostile or accidental name can never carry content into the activity log.
export const CLIENT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AbortError",
  "ChunkLoadError",
  "DataCloneError",
  "InvalidStateError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OverconstrainedError",
  "QuotaExceededError",
  "SecurityError",
  "TimeoutError",
  "ApiError",
  "ChatLookupFailure",
  "DebugRequestError",
  "DictationRecorderError",
  "EditorModelOwnershipError",
  "OverlappingPatchEditError",
  "PollAbortError",
  "RelationshipApiError",
  "StreamingUnavailableError",
  "TaskWorkspaceProvisionError",
  "TaskWorkspaceRepairOperatorRequiredError",
  "TaskWorkspaceRestoreVerificationError",
  "VoiceControlError",
  "VoiceLiveDictationControlError",
  "VoiceRtcError",
  "WorkspaceShortcutConflictError",
  "WorkspaceShortcutReservedError",
  "bigint",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

/**
 * An error's class for a client note: its name when the closed vocabulary holds it, "Error" for
 * any other Error, and `typeof` for a thrown non-Error. Never the message, never the stack.
 */
export function clientErrorClass(error: unknown): string {
  if (error instanceof Error) return CLIENT_ERROR_CLASSES.has(error.name) ? error.name : "Error";
  return typeof error;
}

const CORRELATION_ID_MAX_LENGTH = 128;
const ISO_INSTANT_MAX_LENGTH = 40;

// Deliberately less strict than `correlation.ts`'s SAFE_CORRELATION_ID: this file only asserts the
// wire SHAPE (a short, non-empty string) so the leaf never has to import server plumbing. The
// server re-validates with `isValidCorrelationId` before trusting the value for anything.
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

export interface ClientDiagnosticIngestRequest {
  readonly message: string;
  readonly clientTs: string;
  readonly readyState?: ClientDiagnosticReadyState | undefined;
  readonly correlationId?: string | undefined;
  readonly kind?: ClientDiagnosticKind | undefined;
  readonly gitChangeDescription?: ClientDiagnosticGitChangeDescription | undefined;
  readonly workspaceTrustBinding?: ClientDiagnosticWorkspaceTrustBinding | undefined;
  readonly loss?: ClientDiagnosticLossCounts | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

// UTC component getters in the same order the capture groups appear in `ISO_INSTANT_PATTERN`
// (year, month, day, hour, minute, second) — `getUTCMonth()` is 0-based, so it is adjusted to match
// the 1-based literal the input wrote.
const ISO_INSTANT_UTC_GETTERS: readonly ((date: Date) => number)[] = [
  (date): number => date.getUTCFullYear(),
  (date): number => date.getUTCMonth() + 1,
  (date): number => date.getUTCDate(),
  (date): number => date.getUTCHours(),
  (date): number => date.getUTCMinutes(),
  (date): number => date.getUTCSeconds(),
];

// `Date.parse` silently normalizes a calendar-invalid instant instead of rejecting it (e.g.
// `2026-02-30T10:00:00.000Z` becomes `2026-03-02T10:00:00.000Z`), so a regex-shape match plus a
// non-NaN parse is not enough on its own: reparse the accepted ms value and require every UTC
// component the input literally said to still be there. All six capture groups in
// `ISO_INSTANT_PATTERN` are mandatory (only the milliseconds fraction is optional, and it is
// non-capturing), so `match[1..6]` is always populated once `match` itself is non-null.
function isCalendarValidInstant(match: RegExpExecArray, parsedMs: number): boolean {
  const components = match.slice(1, 7);
  const parsed = new Date(parsedMs);
  return ISO_INSTANT_UTC_GETTERS.every(
    (getUtcComponent, index) => getUtcComponent(parsed) === Number(components[index]),
  );
}

function isIsoInstant(value: unknown): value is string {
  if (!isBoundedString(value, ISO_INSTANT_MAX_LENGTH)) return false;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const parsedMs = Date.parse(value);
  return !Number.isNaN(parsedMs) && isCalendarValidInstant(match, parsedMs);
}

const CLIENT_DIAGNOSTIC_READY_STATE_SET: ReadonlySet<number> = new Set(
  CLIENT_DIAGNOSTIC_READY_STATES,
);

function isClientDiagnosticReadyState(value: unknown): value is ClientDiagnosticReadyState {
  return typeof value === "number" && CLIENT_DIAGNOSTIC_READY_STATE_SET.has(value);
}

const CLIENT_DIAGNOSTIC_KIND_SET: ReadonlySet<string> = new Set(CLIENT_DIAGNOSTIC_KINDS);
const LINUX_GATEWAY_DIAGNOSTIC_KIND_SET: ReadonlySet<string> = new Set(
  LINUX_GATEWAY_DIAGNOSTIC_KINDS,
);

export function isClientDiagnosticKind(value: unknown): value is ClientDiagnosticKind {
  return typeof value === "string" && CLIENT_DIAGNOSTIC_KIND_SET.has(value);
}

export function isLinuxGatewayDiagnosticKind(value: unknown): value is LinuxGatewayDiagnosticKind {
  return typeof value === "string" && LINUX_GATEWAY_DIAGNOSTIC_KIND_SET.has(value);
}

const GIT_CHANGE_DESCRIPTION_ACTION_SET: ReadonlySet<string> = new Set(
  CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_ACTIONS,
);
const RESPONSE_DISPOSITION_SET: ReadonlySet<string> = new Set(
  CLIENT_DIAGNOSTIC_RESPONSE_DISPOSITIONS,
);
const GIT_CHANGE_DESCRIPTION_OUTCOME_SET: ReadonlySet<string> = new Set(
  CLIENT_DIAGNOSTIC_GIT_CHANGE_DESCRIPTION_OUTCOMES,
);
const BODY_FREE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isSetMember(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === "string" && values.has(value);
}

function isClientDiagnosticGitChangeDescription(
  value: unknown,
): value is ClientDiagnosticGitChangeDescription {
  if (!isRecord(value)) return false;
  return (
    isSetMember(value.action, GIT_CHANGE_DESCRIPTION_ACTION_SET) &&
    isSetMember(value.disposition, RESPONSE_DISPOSITION_SET) &&
    typeof value.relationshipId === "string" &&
    BODY_FREE_ID_PATTERN.test(value.relationshipId) &&
    typeof value.snapshotDigest === "string" &&
    SHA256_PATTERN.test(value.snapshotDigest) &&
    typeof value.proposalId === "string" &&
    BODY_FREE_ID_PATTERN.test(value.proposalId) &&
    isSetMember(value.outcome, GIT_CHANGE_DESCRIPTION_OUTCOME_SET)
  );
}

function isClientDiagnosticWorkspaceTrustBinding(
  value: unknown,
): value is ClientDiagnosticWorkspaceTrustBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.repositoryId === "string" &&
    BODY_FREE_ID_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === "string" &&
    BODY_FREE_ID_PATTERN.test(value.workspaceId)
  );
}

function isCorrelationIdShape(value: unknown): value is string {
  return isBoundedString(value, CORRELATION_ID_MAX_LENGTH);
}

// A value present under an optional key must still conform to `guard`; absent is always accepted.
function isOptional(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

const CLIENT_DIAGNOSTIC_LOSS_COUNT_KEY_SET: ReadonlySet<string> = new Set(
  CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS,
);

export function isClientDiagnosticLossCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX
  );
}

// Closed on both axes: an unknown key or an out-of-range count refuses the whole report, so the
// server never has to decide which part of a malformed loss block to believe.
function isClientDiagnosticLossCounts(value: unknown): value is ClientDiagnosticLossCounts {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, count]) =>
      CLIENT_DIAGNOSTIC_LOSS_COUNT_KEY_SET.has(key) &&
      isOptional(count, isClientDiagnosticLossCount),
  );
}

function hasValidClientDiagnosticContext(value: Record<string, unknown>): boolean {
  const { gitChangeDescription, workspaceTrustBinding, loss } = value;
  if (!isOptional(gitChangeDescription, isClientDiagnosticGitChangeDescription)) return false;
  if (!isOptional(workspaceTrustBinding, isClientDiagnosticWorkspaceTrustBinding)) return false;
  return isOptional(loss, isClientDiagnosticLossCounts);
}

export function isClientDiagnosticIngestRequest(
  value: unknown,
): value is ClientDiagnosticIngestRequest {
  if (!isRecord(value)) return false;
  const { message, clientTs, readyState, correlationId, kind } = value;
  if (!isBoundedString(message, CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)) return false;
  if (!isIsoInstant(clientTs)) return false;
  if (!isOptional(readyState, isClientDiagnosticReadyState)) return false;
  if (!isOptional(correlationId, isCorrelationIdShape)) return false;
  if (!isOptional(kind, isClientDiagnosticKind)) return false;
  return hasValidClientDiagnosticContext(value);
}

// ─── UI stage evidence (KEIKO-3557) ──────────────────────────────────────────────
//
// `useWindowStageEvidence` (keiko-ui) reports routine desktop-window lifecycle evidence — a
// placeholder stage mounting and later unmounting — through this same ingest route. That evidence
// is not a failure (a stage that starts and settles is the ordinary case), so it must never share
// `ClientDiagnosticIngestRequest`'s failure-shaped `message`/`kind` wire shape: a live log showed
// 416 of 449 `client.diagnostic` lines were exactly this routine evidence, all persisted as
// warn/unknown and burying the rare real failures. This closed, bounded, free-text-free shape is
// the alternative the server registers and logs as its own lifecycle operation instead
// (`client-diagnostics-routes.ts`'s `client.stage.started`/`client.stage.settled`).

// Exactly the stage ids `useWindowStageEvidence` (keiko-ui) reports — never a free-form label.
export const CLIENT_STAGE_IDS = [
  "window chunk",
  "chat window chunk",
  "editor widget chunk",
  "files widget chunk",
  "chat bind",
] as const;
export type ClientStageId = (typeof CLIENT_STAGE_IDS)[number];

export const CLIENT_STAGE_PHASES = ["started", "settled"] as const;
export type ClientStagePhase = (typeof CLIENT_STAGE_PHASES)[number];

// `useWindowStageEvidence`'s per-tab mount sequence number. Generous relative to any plausible
// number of desktop-window mounts in one page lifetime; a report beyond it is refused outright
// rather than silently truncated.
export const CLIENT_STAGE_ORDINAL_MAX = 1_000_000;

// A settle reported more than a day after its stage started is not timing evidence for that stage
// anymore (a hung tab, not a slow one) — cap it instead of carrying an unbounded number on the wire.
export const CLIENT_STAGE_DURATION_MS_MAX = 86_400_000;

export interface ClientStageStartedIngestRequest {
  readonly kind: "stage";
  readonly stage: ClientStageId;
  readonly phase: "started";
  readonly ordinal: number;
}

export interface ClientStageSettledIngestRequest {
  readonly kind: "stage";
  readonly stage: ClientStageId;
  readonly phase: "settled";
  readonly ordinal: number;
  readonly durationMs: number;
}

/** The wire shape `useWindowStageEvidence` sends instead of a free-text diagnostic message. */
export type ClientStageIngestRequest =
  ClientStageStartedIngestRequest | ClientStageSettledIngestRequest;

const CLIENT_STAGE_ID_SET: ReadonlySet<string> = new Set(CLIENT_STAGE_IDS);
const CLIENT_STAGE_INGEST_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "stage",
  "phase",
  "ordinal",
  "durationMs",
]);

function isClientStageId(value: unknown): value is ClientStageId {
  return typeof value === "string" && CLIENT_STAGE_ID_SET.has(value);
}

// `ordinal` is a 1-based mount counter (never 0); `durationMs` is a genuine elapsed time and a
// same-tick settle (React StrictMode's double-invoke, or a truly instant bind) is legitimately 0.
function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isBoundedNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/**
 * True for a closed, bounded stage report. An unknown `stage`/`phase`, an out-of-range `ordinal` or
 * `durationMs`, a `durationMs` on a "started" report, a missing `durationMs` on a "settled" report,
 * or any field this shape does not declare refuses the whole report rather than admitting part of
 * it — the same fail-closed discipline `isClientDiagnosticIngestRequest` applies to the message
 * shape.
 */
export function isClientStageIngestRequest(value: unknown): value is ClientStageIngestRequest {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !CLIENT_STAGE_INGEST_REQUEST_KEYS.has(key))) return false;
  if (value.kind !== "stage") return false;
  if (!isClientStageId(value.stage)) return false;
  if (!isBoundedPositiveInteger(value.ordinal, CLIENT_STAGE_ORDINAL_MAX)) return false;
  if (value.phase === "started") return value.durationMs === undefined;
  if (value.phase === "settled") {
    return isBoundedNonNegativeInteger(value.durationMs, CLIENT_STAGE_DURATION_MS_MAX);
  }
  return false;
}

// ─── Restored window binding evidence (#3557) ────────────────────────────────────
//
// A desktop window restored from the persisted workspace binds a server-issued reference (a chat
// window: its chat id). Whether that binding resolved, and what shape the persisted reference had,
// is what tells a reference lost at persistence (stored as the redaction marker) from a target that
// is really gone. A message-only report reduced every case to one opaque digest with an unknown
// error kind (review on #3557). This closed shape carries closed values only, never the reference.

export const CLIENT_BINDING_SURFACES = ["chat-window"] as const;
export type ClientBindingSurface = (typeof CLIENT_BINDING_SURFACES)[number];

export const CLIENT_BINDING_OUTCOMES = ["resolved", "target-missing"] as const;
export type ClientBindingOutcome = (typeof CLIENT_BINDING_OUTCOMES)[number];

// `redacted`: persisted as the redaction marker; `uuid`: a server-issued version-4 UUID;
// `opaque`: any other opaque reference.
export const CLIENT_BINDING_REFERENCE_SHAPES = ["uuid", "opaque", "redacted"] as const;
export type ClientBindingReferenceShape = (typeof CLIENT_BINDING_REFERENCE_SHAPES)[number];

export interface ClientBindingIngestRequest {
  readonly kind: "binding";
  readonly surface: ClientBindingSurface;
  readonly outcome: ClientBindingOutcome;
  readonly referenceShape: ClientBindingReferenceShape;
  // The persisted reference is a server-issued UUID that the shared secret heuristic reads as a
  // card number: it survived persistence only through the reference-field exemption.
  readonly heuristicExempt: boolean;
  // The request whose answer decided the outcome (the target list load), when the client knows it.
  readonly correlationId?: string | undefined;
}

const CLIENT_BINDING_INGEST_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "surface",
  "outcome",
  "referenceShape",
  "heuristicExempt",
  "correlationId",
]);

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

// Only a server-issued UUID can be exempt from the heuristic; any other combination is refused.
function hasConsistentBindingReference(value: Record<string, unknown>): boolean {
  if (!isOneOf(value.referenceShape, CLIENT_BINDING_REFERENCE_SHAPES)) return false;
  if (typeof value.heuristicExempt !== "boolean") return false;
  return !value.heuristicExempt || value.referenceShape === "uuid";
}

/**
 * True for a closed binding report. An unknown surface, outcome or reference shape, an exemption
 * claimed for anything but a UUID, a malformed correlation id, or any undeclared field refuses the
 * whole report, with the same fail-closed discipline as the message and stage shapes.
 */
export function isClientBindingIngestRequest(value: unknown): value is ClientBindingIngestRequest {
  if (!isRecord(value) || value.kind !== "binding") return false;
  if (Object.keys(value).some((key) => !CLIENT_BINDING_INGEST_REQUEST_KEYS.has(key))) return false;
  if (!isOneOf(value.surface, CLIENT_BINDING_SURFACES)) return false;
  if (!isOneOf(value.outcome, CLIENT_BINDING_OUTCOMES)) return false;
  return (
    hasConsistentBindingReference(value) && isOptional(value.correlationId, isCorrelationIdShape)
  );
}

// ─── Activity Log diagnostic readiness (#3532) ──────────────────────────────────
//
// Whether this process can currently produce machine-reconstruction evidence. `ready` holds only
// when the registry/catalog identity is coherent, the production sink accepted a real write, the
// storage is inside its budget and free-space floor, every required port is wired, and the
// configured level does not silence the log. Any failed check names a closed reason; nothing here
// ever carries a path, an error message, or a count of anything but lost events.
export const ACTIVITY_LOG_READINESS_STATES = ["ready", "degraded", "unavailable"] as const;
export type ActivityLogReadinessState = (typeof ACTIVITY_LOG_READINESS_STATES)[number];

export const ACTIVITY_LOG_READINESS_REASONS = [
  "catalog-mismatch",
  "sink-unwritable",
  "storage-pressure",
  "budget-exceeded",
  "port-unwired",
  "level-silent",
  // The storage could not be inspected at all (an unlistable log directory, a descriptor limit).
  "storage-check-failed",
] as const;
export type ActivityLogReadinessReason = (typeof ACTIVITY_LOG_READINESS_REASONS)[number];

// Which writer serves the process: the real file-backed Activity Log, an explicitly injected test
// writer (never reachable in a production process), or none at all.
export const ACTIVITY_LOG_WRITER_KINDS = [
  "production-file",
  "test-injected",
  "unavailable",
] as const;
export type ActivityLogWriterKind = (typeof ACTIVITY_LOG_WRITER_KINDS)[number];

export interface ActivityLogReadinessSnapshot {
  readonly readiness: ActivityLogReadinessState;
  readonly reasons: readonly ActivityLogReadinessReason[];
  readonly writer: ActivityLogWriterKind;
  // Events this process counted as lost since it started (bounded, see the loss ledger).
  readonly lostEvents: number;
}

/** The `GET /api/health` body. `diagnostics` is additive; `status`/`version` keep their meaning. */
export interface HealthResponse {
  readonly status: "ok";
  readonly version: string;
  readonly diagnostics: ActivityLogReadinessSnapshot;
}

const READINESS_STATE_SET: ReadonlySet<string> = new Set(ACTIVITY_LOG_READINESS_STATES);
const READINESS_REASON_SET: ReadonlySet<string> = new Set(ACTIVITY_LOG_READINESS_REASONS);
const WRITER_KIND_SET: ReadonlySet<string> = new Set(ACTIVITY_LOG_WRITER_KINDS);

function isReadinessReasonList(value: unknown): value is readonly ActivityLogReadinessReason[] {
  return (
    Array.isArray(value) &&
    value.length <= ACTIVITY_LOG_READINESS_REASONS.length &&
    value.every((reason) => isSetMember(reason, READINESS_REASON_SET)) &&
    new Set(value).size === value.length
  );
}

// A failed check always names its reason and a ready process names none, so a snapshot whose state
// and reasons disagree is refused instead of shown to an operator.
function hasCoherentReasons(
  readiness: unknown,
  reasons: readonly ActivityLogReadinessReason[],
): boolean {
  return (readiness === "ready") === (reasons.length === 0);
}

export function isActivityLogReadinessSnapshot(
  value: unknown,
): value is ActivityLogReadinessSnapshot {
  if (!isRecord(value)) return false;
  return (
    isSetMember(value.readiness, READINESS_STATE_SET) &&
    isReadinessReasonList(value.reasons) &&
    hasCoherentReasons(value.readiness, value.reasons) &&
    isSetMember(value.writer, WRITER_KIND_SET) &&
    typeof value.lostEvents === "number" &&
    Number.isSafeInteger(value.lostEvents) &&
    value.lostEvents >= 0
  );
}
