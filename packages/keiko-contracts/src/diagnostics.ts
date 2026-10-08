// Wire contract for `POST /api/diagnostics/client` (Wave 5 of epic #3233, ADR-0173).
//
// The browser is untrusted input, so this shape — and its guard — live in the leaf contracts
// layer like every other request shape the server accepts from a client it does not control
// (ADR-0019). `correlationId` is the fatal-flaw fix all three design-panel judges independently
// flagged as missing: it is what lets an agent deterministically join a browser crash report to
// the specific failed server request it is reporting on, instead of fuzzy timestamp matching. It
// is DESIGNED to be populated from the same correlation id already threaded into every
// `ApiError`/SSE event (`packages/keiko-ui/src/lib/http.ts`), and is re-validated server-side with
// `isValidCorrelationId` before it is trusted. Generic crash reports retain their bounded-string
// compatibility shape; repository lifecycle events require the canonical Activity Log correlation
// guard so an attempt and its settlement cannot fall back to unrelated ingest identities.
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

import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "./workspace-contract-primitives.js";
import { CODING_WORKBENCH_TASK_INTENT_MAX_CHARS } from "./coding-workbench-runtime.js";
import {
  ACTIVITY_LOG_COMPLETENESS_STATES,
  ACTIVITY_LOG_LOSS_STATES,
  type ActivityLogCompletenessState,
  type ActivityLogLossState,
  isActivityLogCorrelationId,
  isActivityLogErrorKind,
  type ActivityLogErrorKind,
} from "./observability.js";
import {
  SUPPORT_REPORT_AVAILABILITY_REASONS,
  type SupportReportAvailabilityReason,
} from "./support-report-policy.js";
import { MAX_SUPPORT_REPORT_BYTES } from "./support-report.js";
import { isGitWireUnavailableReason, type GitWireUnavailableReason } from "./git-repository.js";

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
  "voice-dialogue",
  "voice-playback",
  "markdown-layout",
  "delivery-loss",
  "other",
] as const;
export type ClientDiagnosticKind = (typeof CLIENT_DIAGNOSTIC_KINDS)[number];

export const CLIENT_VOICE_DIALOGUE_STAGES = [
  "started",
  "preparation-failed",
  "turn-submitted",
  "queue-unavailable",
  "answer-ready",
  "delivery-failed",
  "delivery-cancelled",
  "delivery-rejected",
  "capture-bound-reached",
  "capture-renewed",
  "capture-renewal-failed",
  "playback-settled",
  "playback-fallback",
  "interrupted",
  "stopped",
] as const;
export type ClientVoiceDialogueStage = (typeof CLIENT_VOICE_DIALOGUE_STAGES)[number];

/** Shared failure classification for browser severity, rate admission and server persistence. */
export const CLIENT_VOICE_DIALOGUE_FAILURE_STAGES: ReadonlySet<ClientVoiceDialogueStage> = new Set([
  "preparation-failed",
  "queue-unavailable",
  "delivery-failed",
  "delivery-cancelled",
  "delivery-rejected",
  "capture-renewal-failed",
]);

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

export const CLIENT_CODING_HISTORY_REASONS = [
  "repository-mismatch",
  "workspace-mismatch",
  "activation-cancelled",
  "activation-superseded",
  "detail-cleared",
] as const;
export interface ClientDiagnosticCodingHistoryScope {
  readonly reason: (typeof CLIENT_CODING_HISTORY_REASONS)[number];
  readonly taskId: string;
  readonly requestedScopeId: string;
  readonly currentScopeId: string;
  readonly requestedWorkspaceId?: string | undefined;
  readonly currentWorkspaceId?: string | undefined;
  readonly targetWorkspaceId?: string | undefined;
}

const CODING_HISTORY_REASON_SET: ReadonlySet<unknown> = new Set(CLIENT_CODING_HISTORY_REASONS);
const CODING_HISTORY_SCOPE_IDS = new Set([
  "taskId",
  "requestedScopeId",
  "currentScopeId",
  "requestedWorkspaceId",
  "currentWorkspaceId",
  "targetWorkspaceId",
]);
function isCodingHistoryScope(value: unknown): value is ClientDiagnosticCodingHistoryScope {
  if (!isRecord(value)) return false;
  if (!CODING_HISTORY_REASON_SET.has(value.reason)) return false;
  for (const key of ["taskId", "requestedScopeId", "currentScopeId"]) {
    if (typeof value[key] !== "string") return false;
  }
  return Object.entries(value).every(
    ([key, id]) =>
      key === "reason" ||
      (CODING_HISTORY_SCOPE_IDS.has(key) &&
        (id === undefined || (typeof id === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(id)))),
  );
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
  "ChunkLoadError",
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
  if (
    error instanceof Error ||
    (typeof DOMException !== "undefined" && error instanceof DOMException)
  ) {
    return CLIENT_ERROR_CLASSES.has(error.name) ? error.name : "Error";
  }
  return typeof error;
}

const CORRELATION_ID_MAX_LENGTH = 128;
const ISO_INSTANT_MAX_LENGTH = 40;

const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

export const CLIENT_VOICE_CAPTURE_REASONS = [
  "vad-unavailable",
  "speech-observed",
  "renewal-unsupported",
  "replacement-create-failed",
  "replacement-start-failed",
  "previous-stop-failed",
  "replacement-stop-failed",
  "unknown-failure",
] as const;
export type ClientVoiceCaptureReason = (typeof CLIENT_VOICE_CAPTURE_REASONS)[number];
const VOICE_CAPTURE_REASON_SET: ReadonlySet<unknown> = new Set(CLIENT_VOICE_CAPTURE_REASONS);
function isClientVoiceCaptureReason(value: unknown): value is ClientVoiceCaptureReason {
  return VOICE_CAPTURE_REASON_SET.has(value);
}

export const CLIENT_VOICE_CAPTURE_ERRORS = [
  "type-error",
  "range-error",
  "invalid-state",
  "not-supported",
  "security",
  "not-readable",
  "other",
] as const;
export type ClientVoiceCaptureError = (typeof CLIENT_VOICE_CAPTURE_ERRORS)[number];
const VOICE_CAPTURE_ERROR_SET: ReadonlySet<unknown> = new Set(CLIENT_VOICE_CAPTURE_ERRORS);
function isClientVoiceCaptureError(value: unknown): value is ClientVoiceCaptureError {
  return VOICE_CAPTURE_ERROR_SET.has(value);
}

/** Production browser frames name only immutable shipped chunks, never an origin or source path. */
export function isClientDiagnosticFrame(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^dist\/ui\/static\/_next\/static\/chunks\/[a-z0-9_-]{8,32}\.js:\d{1,8}:\d{1,8}$/u.test(value)
  );
}

/** Persisted browser coordinates carry only the reducer's digest and bounded coordinates. */
export function isPersistedClientDiagnosticFrame(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^dist\/ui\/static\/_next\/static\/chunks\/sha256-[a-f0-9]{64}\.js:\d{1,8}:\d{1,8}$/u.test(
      value,
    )
  );
}

export interface ClientErrorEvidence {
  readonly errorClass: string;
  readonly frames: readonly string[];
  readonly causeChain: readonly string[];
}

function isClientErrorClass(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ERROR_CLASSES.has(value);
}

export function isClientErrorEvidence(value: unknown): value is ClientErrorEvidence {
  if (!isRecord(value) || !isClientErrorClass(value.errorClass)) return false;
  if (
    !Array.isArray(value.frames) ||
    value.frames.length > 8 ||
    !value.frames.every(isClientDiagnosticFrame)
  )
    return false;
  return (
    Array.isArray(value.causeChain) &&
    value.causeChain.length <= 5 &&
    value.causeChain.every(isClientErrorClass)
  );
}

export interface ClientMarkdownLayout {
  readonly messageId?: string | undefined;
  readonly listStart: number;
  readonly listIndex: number;
  readonly depth: number;
}

function isClientMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export function isClientMarkdownLayout(value: unknown): value is ClientMarkdownLayout {
  if (!isRecord(value)) return false;
  if (!isOptional(value.messageId, isClientMessageId)) return false;
  return [value.listStart, value.listIndex, value.depth].every(
    (item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= 999_999_999,
  );
}

export const CLIENT_COMPOSER_ACTIVITIES = [
  "initialized",
  "input-limit",
  "code-ready",
  "code-language-detected",
  "format-removed",
  "cursor-collision",
  "workspace-scroll-ready",
  "workspace-layout-locked",
  "workspace-layout-unlocked",
  "literal-input-preserved",
  "draft-resynchronized",
  "scope-refusal-restored",
  "scope-refusal-skipped-owner",
  "scope-refusal-skipped-draft",
  "scope-refusal-skipped-unproven",
  "equivalent-edit-ignored",
  "stale-draft-echo-ignored",
  "non-text-paste-ignored",
  "text-copied",
  "coding-task-submission",
  "coding-task-reset",
] as const;
export type ClientComposerActivity = (typeof CLIENT_COMPOSER_ACTIVITIES)[number];
export const CLIENT_COMPOSER_CODE_STAGES = [
  "module-load",
  "runtime",
  "language",
  "theme",
  "theme-tokens",
  "theme-register",
  "editor-mount",
  "editor-wiring",
] as const;
export type ClientComposerCodeStage = (typeof CLIENT_COMPOSER_CODE_STAGES)[number];
const COMPOSER_ACTIVITIES: ReadonlySet<unknown> = new Set(CLIENT_COMPOSER_ACTIVITIES);
const COMPOSER_CODE_STAGES: ReadonlySet<unknown> = new Set(CLIENT_COMPOSER_CODE_STAGES);

/** Captured native input and the immutable payload, never their text or a visibility claim. */
export interface ClientComposerSubmission {
  readonly kind: "start" | "follow-up";
  readonly outcome: "attempted";
  readonly normalization: "trim";
  readonly displayedDigest: string;
  readonly submittedDigest: string;
  readonly draftMatchesInput: boolean;
  readonly inputCharacterCount: number;
  readonly submittedCharacterCount: number;
}

const COMPOSER_SUBMISSION_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "outcome",
  "normalization",
  "displayedDigest",
  "submittedDigest",
  "draftMatchesInput",
  "inputCharacterCount",
  "submittedCharacterCount",
]);

function isTaskCharacterCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= CODING_WORKBENCH_TASK_INTENT_MAX_CHARS
  );
}

function isClientComposerSubmission(value: unknown): value is ClientComposerSubmission {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !COMPOSER_SUBMISSION_KEYS.has(key))) return false;
  return (
    (value.kind === "start" || value.kind === "follow-up") &&
    value.outcome === "attempted" &&
    value.normalization === "trim" &&
    isReportDigest(value.displayedDigest) &&
    isReportDigest(value.submittedDigest) &&
    typeof value.draftMatchesInput === "boolean" &&
    hasValidTaskCharacterCounts(value)
  );
}

function hasValidTaskCharacterCounts(value: Record<string, unknown>): boolean {
  return (
    isTaskCharacterCount(value.inputCharacterCount) &&
    isTaskCharacterCount(value.submittedCharacterCount) &&
    value.submittedCharacterCount <= value.inputCharacterCount
  );
}

function hasValidComposerSubmission(value: Record<string, unknown>): boolean {
  if (value.composerActivity !== "coding-task-submission")
    return value.composerSubmission === undefined;
  return isClientComposerSubmission(value.composerSubmission);
}

function hasValidComposerFocus(value: Record<string, unknown>): boolean {
  return (
    value.composerFocusIndicator === undefined ||
    (value.composerFocusIndicator === "keyboard" && value.composerActivity === "initialized")
  );
}

function hasValidComposerContext(value: Record<string, unknown>): boolean {
  if (!hasValidComposerSubmission(value) || !hasValidComposerFocus(value)) return false;
  if (!isOptional(value.composerCodeStage, (stage) => COMPOSER_CODE_STAGES.has(stage)))
    return false;
  if (value.composerActivity === undefined) return true;
  return (
    COMPOSER_ACTIVITIES.has(value.composerActivity) &&
    value.kind === undefined &&
    value.errorKind === undefined &&
    value.errorEvidence === undefined &&
    value.composerCodeStage === undefined
  );
}

export const HEALTH_DIAGNOSTICS_INVALID_REASONS = [
  "null-shape",
  "readiness-value",
  "snapshot-shape",
] as const;
export type HealthDiagnosticsInvalidReason = (typeof HEALTH_DIAGNOSTICS_INVALID_REASONS)[number];
const HEALTH_DIAGNOSTICS_INVALID_REASON_SET: ReadonlySet<unknown> = new Set(
  HEALTH_DIAGNOSTICS_INVALID_REASONS,
);

export const CLIENT_MODULE_LOAD_FAILURES = [
  "git-sync",
  "git-history",
  "git-read",
  "widget-locale",
] as const;
export type ClientModuleLoadFailure = (typeof CLIENT_MODULE_LOAD_FAILURES)[number];
const CLIENT_MODULE_LOAD_FAILURE_SET: ReadonlySet<unknown> = new Set(CLIENT_MODULE_LOAD_FAILURES);

export interface ClientDiagnosticIngestRequest {
  readonly message: string;
  readonly clientTs: string;
  readonly readyState?: ClientDiagnosticReadyState | undefined;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly kind?: ClientDiagnosticKind | undefined;
  // The closed class of the failure the page observed, when it classified one (a refused
  // connection is `unavailable`, never `unknown`); otherwise the server derives it from `kind`.
  readonly errorKind?: ActivityLogErrorKind | undefined;
  readonly voiceDialogueStage?: ClientVoiceDialogueStage | undefined;
  readonly voiceCaptureReason?: ClientVoiceCaptureReason | undefined;
  readonly voiceCaptureError?: ClientVoiceCaptureError | undefined;
  readonly markdownLayout?: ClientMarkdownLayout | undefined;
  readonly moduleLoadFailure?: ClientModuleLoadFailure | undefined;
  readonly healthDiagnosticsInvalidReason?: HealthDiagnosticsInvalidReason | undefined;
  readonly renderFailure?: "shell" | "window-body" | undefined;
  readonly errorEvidence?: ClientErrorEvidence | undefined;
  readonly gitChangeDescription?: ClientDiagnosticGitChangeDescription | undefined;
  readonly workspaceTrustBinding?: ClientDiagnosticWorkspaceTrustBinding | undefined;
  readonly gitClientOperation?: ClientDiagnosticGitClientOperation | undefined;
  readonly selectDismissal?: ClientDiagnosticSelectDismissal | undefined;
  readonly knowledgeCatalog?: ClientDiagnosticKnowledgeCatalog | undefined;
  readonly answerCopy?: ClientDiagnosticAnswerCopy | undefined;
  readonly answerSpeech?: ClientDiagnosticAnswerSpeech | undefined;
  readonly citationActivation?: ClientDiagnosticCitationActivation | undefined;
  readonly supportReportDelivery?: ClientSupportReportDelivery | undefined;
  readonly supportReportPreparation?: ClientSupportReportPreparation | undefined;
  readonly filesScopeDecision?: ClientFilesScopeDecision | undefined;
  readonly codingRunRestore?: ClientDiagnosticCodingRunRestore | undefined;
  readonly composerActivity?: ClientComposerActivity | undefined;
  readonly composerSubmission?: ClientComposerSubmission | undefined;
  readonly composerFocusIndicator?: "keyboard" | undefined;
  readonly composerCodeStage?: ClientComposerCodeStage | undefined;
  readonly codingIssueOutcome?: "multiple-issues" | undefined;
  readonly codingHistoryScope?: ClientDiagnosticCodingHistoryScope | undefined;
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
const CLIENT_VOICE_DIALOGUE_STAGE_SET: ReadonlySet<string> = new Set(CLIENT_VOICE_DIALOGUE_STAGES);

function isClientVoiceDialogueStage(value: unknown): value is ClientVoiceDialogueStage {
  return typeof value === "string" && CLIENT_VOICE_DIALOGUE_STAGE_SET.has(value);
}
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
// Local checkout bindings carry a server-derived SHA-256 identity after their namespace.
// Accept that exact grammar here without opening other diagnostic ids to arbitrary colon data.
const WORKSPACE_DIAGNOSTIC_ID_PATTERN = /^(?:[A-Za-z0-9._-]{1,128}|local:[a-f0-9]{64})$/u;
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
    WORKSPACE_DIAGNOSTIC_ID_PATTERN.test(value.workspaceId)
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

function isClientModuleLoadFailure(value: unknown): boolean {
  return CLIENT_MODULE_LOAD_FAILURE_SET.has(value);
}

function hasValidCodingContext(value: Record<string, unknown>): boolean {
  return (
    isOptional(value.codingHistoryScope, isCodingHistoryScope) &&
    isOptional(value.codingIssueOutcome, (outcome) => outcome === "multiple-issues")
  );
}

// The three Git-related structured fields, grouped only to keep the caller below under the
// complexity ceiling — each is independently optional and validated on its own (PR #3625 review).
function hasValidGitContext(value: Record<string, unknown>): boolean {
  const { gitChangeDescription, workspaceTrustBinding, gitClientOperation } = value;
  if (!isOptional(gitChangeDescription, isClientDiagnosticGitChangeDescription)) return false;
  if (!isOptional(workspaceTrustBinding, isClientDiagnosticWorkspaceTrustBinding)) return false;
  if (gitClientOperation === undefined) return true;
  if (!isClientDiagnosticGitClientOperation(gitClientOperation)) return false;
  return (
    !isRepositoryAdditionOperation(gitClientOperation.operation) ||
    isActivityLogCorrelationId(value.correlationId)
  );
}

function hasValidVoiceCaptureContext(value: Record<string, unknown>): boolean {
  return (
    isOptional(value.voiceCaptureReason, isClientVoiceCaptureReason) &&
    isOptional(value.voiceCaptureError, isClientVoiceCaptureError)
  );
}

const CLOSED_CLIENT_REPORT_KEYS = [
  "selectDismissal",
  "knowledgeCatalog",
  "answerCopy",
  "answerSpeech",
  "citationActivation",
  "supportReportDelivery",
  "supportReportPreparation",
  "filesScopeDecision",
  "codingRunRestore",
] as const;
const CLOSED_CLIENT_REPORT_ENVELOPE_KEYS = new Set([
  "message",
  "clientTs",
  "correlationId",
  "parentCorrelationId",
  "loss",
]);
function allowsClosedReportFailureField(value: Record<string, unknown>, key: string): boolean {
  return (
    isRecord(value.answerCopy) &&
    value.answerCopy.outcome === "failed" &&
    (key === "errorKind" || key === "errorEvidence")
  );
}
function allowsLegacySelectKind(value: Record<string, unknown>, key: string): boolean {
  // Existing select-menu producers label routine dismissal as neutral `other`, never a failure.
  return key === "kind" && value.kind === "other" && value.selectDismissal !== undefined;
}
function hasExclusiveClosedReportContext(value: Record<string, unknown>): boolean {
  const selected = CLOSED_CLIENT_REPORT_KEYS.filter((key) => value[key] !== undefined);
  if (selected.length === 0) return true;
  if (selected.length !== 1) return false;
  return Object.keys(value).every(
    (key) =>
      value[key] === undefined ||
      key === selected[0] ||
      CLOSED_CLIENT_REPORT_ENVELOPE_KEYS.has(key) ||
      allowsClosedReportFailureField(value, key) ||
      allowsLegacySelectKind(value, key),
  );
}

// The closed, routine report shapes that may ride a message report (select dismissal, catalog).
function hasValidClosedReportContext(value: Record<string, unknown>): boolean {
  return (
    isOptional(value.selectDismissal, isClientDiagnosticSelectDismissal) &&
    isOptional(value.knowledgeCatalog, isClientDiagnosticKnowledgeCatalog) &&
    isOptional(value.answerCopy, isClientDiagnosticAnswerCopy) &&
    isOptional(value.answerSpeech, isClientDiagnosticAnswerSpeech) &&
    hasExclusiveClosedReportContext(value) &&
    hasValidCitationActivationContext(value) &&
    isOptional(value.supportReportDelivery, isClientSupportReportDelivery) &&
    isOptional(value.supportReportPreparation, isClientSupportReportPreparation) &&
    isOptional(value.codingRunRestore, isClientDiagnosticCodingRunRestore) &&
    hasValidFilesScopeDecisionContext(value)
  );
}

function hasValidRenderFailure(value: Record<string, unknown>): boolean {
  if (value.renderFailure === undefined) return true;
  return (
    value.kind === "boundary" &&
    (value.renderFailure === "shell" || value.renderFailure === "window-body")
  );
}

function hasValidHealthDiagnostic(value: Record<string, unknown>): boolean {
  if (value.healthDiagnosticsInvalidReason === undefined) return true;
  return (
    HEALTH_DIAGNOSTICS_INVALID_REASON_SET.has(value.healthDiagnosticsInvalidReason) &&
    value.errorKind === "validation-failed" &&
    value.kind === undefined &&
    value.errorEvidence === undefined
  );
}

function hasValidOperationalContext(value: Record<string, unknown>): boolean {
  return (
    hasValidVoiceCaptureContext(value) &&
    hasValidGitContext(value) &&
    hasValidHealthDiagnostic(value)
  );
}

function hasValidClientDiagnosticContext(value: Record<string, unknown>): boolean {
  const { errorKind, loss, parentCorrelationId } = value;
  if (!isOptional(errorKind, isActivityLogErrorKind)) return false;
  if (!isOptional(parentCorrelationId, isCorrelationIdShape)) return false;
  if (!isOptional(value.markdownLayout, isClientMarkdownLayout)) return false;
  if (!isOptional(value.moduleLoadFailure, isClientModuleLoadFailure)) return false;
  if (!hasValidRenderFailure(value)) return false;
  if (!hasValidOperationalContext(value)) return false;
  if (!hasValidClosedReportContext(value)) return false;
  return (
    hasValidComposerContext(value) &&
    hasValidCodingContext(value) &&
    hasValidClientLoss(value.kind, loss)
  );
}

function hasValidClientLoss(kind: unknown, loss: unknown): boolean {
  return kind === "delivery-loss"
    ? isClientDiagnosticLossCounts(loss)
    : isOptional(loss, isClientDiagnosticLossCounts);
}

export function isClientDiagnosticIngestRequest(
  value: unknown,
): value is ClientDiagnosticIngestRequest {
  if (!isRecord(value)) return false;
  if (!isOptional(value.errorEvidence, isClientErrorEvidence)) return false;
  const { message, clientTs, readyState, correlationId, kind, voiceDialogueStage } = value;
  if (!isBoundedString(message, CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)) return false;
  if (!isIsoInstant(clientTs)) return false;
  if (!isOptional(readyState, isClientDiagnosticReadyState)) return false;
  if (!isOptional(correlationId, isCorrelationIdShape)) return false;
  if (!isOptional(kind, isClientDiagnosticKind)) return false;
  if (!isOptional(voiceDialogueStage, isClientVoiceDialogueStage)) return false;
  if ((kind === "voice-dialogue") !== (voiceDialogueStage !== undefined)) return false;
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
  "command palette",
  "chat history deletion",
  "files directory load",
  "files source preview",
  "files source reveal",
  "files directory navigation",
  "files project selection",
  "editor project selection",
  "gateway catalog adoption",
  "gateway profile refresh",
  "model selection availability",
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

export interface ClientChatHistoryDeletionCounts {
  readonly requestedCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
}

// One correlation id per mounted stage (#3557 review): `started` and `settled` carry the same id, so
// the pair joins in the log even when another tab reuses the same stage and ordinal.
export interface ClientStageStartedIngestRequest {
  readonly kind: "stage";
  readonly stage: ClientStageId;
  readonly phase: "started";
  readonly ordinal: number;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly deletion?: ClientChatHistoryDeletionCounts | undefined;
}

export interface ClientSourcePreviewCounts {
  readonly previewKind: "text" | "image" | "binary";
  /** Raw bytes supplied to the decoder, excluding duplicate classification reads and lookahead. */
  readonly sourceTextBytesRead: number;
  readonly canEdit: boolean;
  readonly binaryReason?: "too-large" | "unsupported" | undefined;
}

export interface ClientModelCatalogEvidence {
  readonly surface: "chat" | "coding-workbench";
  readonly source: "bootstrap" | "foreground" | "background" | "workbench";
  readonly outcome:
    "unchanged" | "changed" | "adopted" | "held" | "restored" | "fallback" | "refused";
  readonly configuredModelCount: number;
  readonly usableModelCount: number;
  readonly selectionProvenance?: "human" | "elected" | undefined;
  readonly selectionDigest?: string | undefined;
}

export interface ClientGatewayProfileRefreshEvidence {
  readonly outcome: "adopted" | "unavailable" | "failed" | "superseded";
  readonly catalogReread: "requested" | "skipped" | "none";
}

export interface ClientStageSettledIngestRequest {
  readonly kind: "stage";
  readonly stage: ClientStageId;
  readonly phase: "settled";
  readonly ordinal: number;
  readonly durationMs: number;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly deletion?: ClientChatHistoryDeletionCounts | undefined;
  readonly navigationOutcome?: ClientNavigationOutcome | undefined;
  readonly preview?: ClientSourcePreviewCounts | undefined;
  readonly modelCatalog?: ClientModelCatalogEvidence | undefined;
  readonly gatewayProfile?: ClientGatewayProfileRefreshEvidence | undefined;
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
  "correlationId",
  "parentCorrelationId",
  "deletion",
  "navigationOutcome",
  "preview",
  "modelCatalog",
  "gatewayProfile",
]);

export const CLIENT_NAVIGATION_OUTCOMES = [
  "applied",
  "unavailable",
  "failed",
  "dropped",
  "stale",
  "cancelled",
  "deferred",
] as const;
export type ClientNavigationOutcome = (typeof CLIENT_NAVIGATION_OUTCOMES)[number];
const NAVIGATION_OUTCOMES: ReadonlySet<string> = new Set(CLIENT_NAVIGATION_OUTCOMES);
const NAVIGATION_OUTCOME_STAGES: ReadonlySet<string> = new Set([
  "editor project selection",
  "files directory load",
  "files source preview",
  "files source reveal",
  "files directory navigation",
  "files project selection",
]);

function hasValidNavigationOutcome(value: Record<string, unknown>): boolean {
  if (value.navigationOutcome === undefined) return true;
  return (
    value.phase === "settled" &&
    typeof value.stage === "string" &&
    NAVIGATION_OUTCOME_STAGES.has(value.stage) &&
    typeof value.navigationOutcome === "string" &&
    NAVIGATION_OUTCOMES.has(value.navigationOutcome)
  );
}

const CHAT_HISTORY_DELETION_COUNT_KEYS: ReadonlySet<string> = new Set([
  "requestedCount",
  "deletedCount",
  "failedCount",
]);

function hasValidStageDeletion(value: Record<string, unknown>): boolean {
  if (value.stage !== "chat history deletion") return value.deletion === undefined;
  const counts = value.deletion;
  if (!isRecord(counts)) return false;
  if (Object.keys(counts).some((key) => !CHAT_HISTORY_DELETION_COUNT_KEYS.has(key))) return false;
  if (!isBoundedPositiveInteger(counts.requestedCount, CLIENT_STAGE_ORDINAL_MAX)) return false;
  if (!isBoundedNonNegativeInteger(counts.deletedCount, CLIENT_STAGE_ORDINAL_MAX)) return false;
  if (!isBoundedNonNegativeInteger(counts.failedCount, CLIENT_STAGE_ORDINAL_MAX)) return false;
  if (value.phase === "started") return counts.deletedCount === 0 && counts.failedCount === 0;
  return counts.deletedCount + counts.failedCount === counts.requestedCount;
}

const SOURCE_PREVIEW_COUNT_KEYS: ReadonlySet<string> = new Set([
  "previewKind",
  "sourceTextBytesRead",
  "canEdit",
  "binaryReason",
]);

function hasValidBinaryPreviewReason(value: Record<string, unknown>): boolean {
  if (value.binaryReason === undefined) return true;
  return (
    value.previewKind === "binary" &&
    (value.binaryReason === "too-large" || value.binaryReason === "unsupported")
  );
}

function isSourcePreviewKind(value: unknown): value is ClientSourcePreviewCounts["previewKind"] {
  return value === "text" || value === "image" || value === "binary";
}

function isSourcePreviewCounts(value: unknown): value is ClientSourcePreviewCounts {
  if (!isRecord(value) || Object.keys(value).some((key) => !SOURCE_PREVIEW_COUNT_KEYS.has(key)))
    return false;
  if (!isSourcePreviewKind(value.previewKind)) return false;
  if (
    typeof value.canEdit !== "boolean" ||
    !isBoundedNonNegativeInteger(value.sourceTextBytesRead, MAX_RECURSIVE_TEXT_FILE_BYTES)
  )
    return false;
  return (
    hasValidBinaryPreviewReason(value) &&
    (value.previewKind === "text" || (value.sourceTextBytesRead === 0 && !value.canEdit))
  );
}

function hasValidSourcePreview(value: Record<string, unknown>): boolean {
  return (
    value.preview === undefined ||
    (value.stage === "files source preview" &&
      value.phase === "settled" &&
      isSourcePreviewCounts(value.preview))
  );
}

const MODEL_CATALOG_KEYS = new Set([
  "surface",
  "source",
  "outcome",
  "configuredModelCount",
  "usableModelCount",
  "selectionProvenance",
  "selectionDigest",
]);
const MODEL_CATALOG_STAGES = new Set(["gateway catalog adoption", "model selection availability"]);

function hasValidModelCatalogCounts(value: Record<string, unknown>): boolean {
  return (
    isBoundedNonNegativeInteger(value.configuredModelCount, CLIENT_STAGE_ORDINAL_MAX) &&
    isBoundedNonNegativeInteger(value.usableModelCount, CLIENT_STAGE_ORDINAL_MAX) &&
    value.usableModelCount <= value.configuredModelCount
  );
}

function hasValidModelCatalogOutcome(stage: unknown, value: Record<string, unknown>): boolean {
  if (stage === "model selection availability")
    return (
      isOneOf(value.outcome, ["held", "restored", "fallback", "refused"]) &&
      isOneOf(value.selectionProvenance, ["human", "elected"])
    );
  return (
    isOneOf(value.outcome, ["unchanged", "changed", "adopted"]) &&
    value.selectionProvenance === undefined &&
    value.selectionDigest === undefined
  );
}

function hasValidModelCatalogStage(value: Record<string, unknown>): boolean {
  const isModelStage = typeof value.stage === "string" && MODEL_CATALOG_STAGES.has(value.stage);
  if (value.modelCatalog === undefined) return !isModelStage || value.phase !== "settled";
  if (!isModelStage || value.phase !== "settled" || !isRecord(value.modelCatalog)) return false;
  return hasValidModelCatalogEvidence(value.stage, value.modelCatalog);
}

function hasValidModelCatalogEvidence(stage: unknown, evidence: Record<string, unknown>): boolean {
  return (
    Object.keys(evidence).every((key) => MODEL_CATALOG_KEYS.has(key)) &&
    isOneOf(evidence.surface, ["chat", "coding-workbench"]) &&
    isOneOf(evidence.source, ["bootstrap", "foreground", "background", "workbench"]) &&
    hasValidModelCatalogCounts(evidence) &&
    hasValidModelCatalogOutcome(stage, evidence) &&
    isOptional(evidence.selectionDigest, isReportDigest)
  );
}

function hasValidGatewayProfileStage(value: Record<string, unknown>): boolean {
  const applies = value.stage === "gateway profile refresh" && value.phase === "settled";
  if (value.gatewayProfile === undefined) return !applies;
  if (!applies || !isRecord(value.gatewayProfile)) return false;
  const evidence = value.gatewayProfile;
  if (Object.keys(evidence).some((key) => key !== "outcome" && key !== "catalogReread"))
    return false;
  if (!isOneOf(evidence.outcome, ["adopted", "unavailable", "failed", "superseded"])) return false;
  return evidence.outcome === "failed" || evidence.outcome === "superseded"
    ? evidence.catalogReread === "none"
    : isOneOf(evidence.catalogReread, ["requested", "skipped"]);
}

function hasValidStageContext(value: Record<string, unknown>): boolean {
  return (
    hasValidStageDeletion(value) &&
    hasValidNavigationOutcome(value) &&
    hasValidSourcePreview(value) &&
    hasValidModelCatalogStage(value) &&
    hasValidGatewayProfileStage(value) &&
    isOptional(value.parentCorrelationId, isActivityLogCorrelationId)
  );
}

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
  if (!isOptional(value.correlationId, isCorrelationIdShape)) return false;
  if (!hasValidStageContext(value)) return false;
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

// `candidates-offered`: a window whose chat id persistence redacted without a fingerprint listed the
// chats it may have shown, for the person to choose from (#3557 review). `choice-kept` and
// `choice-withdrawn`: the person kept the chat they chose for such a window, or withdrew it and
// returned the window to the chats it may have shown.
export const CLIENT_BINDING_OUTCOMES = [
  "resolved",
  "target-missing",
  "candidates-offered",
  "choice-kept",
  "choice-withdrawn",
] as const;
export type ClientBindingOutcome = (typeof CLIENT_BINDING_OUTCOMES)[number];
// The binding outcomes that report a failure; every other one is routine evidence. The browser and
// the server budget binding reports by this one rule, so routine offers and decisions never spend
// the capacity a failure report needs (#3557 review).
export const CLIENT_BINDING_FAILURE_OUTCOMES: ReadonlySet<ClientBindingOutcome> = new Set([
  "target-missing",
]);

// `redacted`: persisted as the redaction marker; `uuid`: a server-issued version-4 UUID;
// `opaque`: any other opaque reference; `fingerprint`: persisted as the redaction marker plus the
// id's one-way fingerprint, through which the window found its chat again; `user-selected`:
// persisted as the redaction marker without a fingerprint, and bound to the chat the person chose
// among the ones it may have shown.
export const CLIENT_BINDING_REFERENCE_SHAPES = [
  "uuid",
  "opaque",
  "redacted",
  "fingerprint",
  "user-selected",
] as const;
export type ClientBindingReferenceShape = (typeof CLIENT_BINDING_REFERENCE_SHAPES)[number];

// A legacy binding (no persisted project) is decided by a scan over every project's list; the report
// names each list load it depended on beyond `correlationId`, up to this bound, and states how many
// loads decided it in total. Any deciding load the report cannot name is recorded as classified
// loss on a partial line, never silently cut (#3557 review).
export const CLIENT_BINDING_RELATED_CORRELATIONS_MAX = 63;
export const CLIENT_BINDING_DECIDING_LOADS_MAX = 10_000;
// The window's own persisted id, which workspace persistence bounds to this safe shape (a
// restored window with any other id is dropped). The server logs only its digest, and no
// truncation ever happens, so two windows can never share one (#3557 review). `~` stays out: it
// joins two window ids into a connection id.
export const CLIENT_BINDING_WINDOW_REF_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
// How many chats one offer may report.
export const CLIENT_BINDING_CANDIDATES_MAX = 10_000;
// The one-way SHA-256 fingerprint a chat window records for a chat id persistence redacts; a binding
// names the chat it was restored to only in this form, never by its id.
export const CLIENT_BINDING_TARGET_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export interface ClientBindingIngestRequest {
  readonly kind: "binding";
  readonly surface: ClientBindingSurface;
  readonly outcome: ClientBindingOutcome;
  readonly referenceShape: ClientBindingReferenceShape;
  // The persisted reference is a server-issued UUID whose hyphenated form the shared secret
  // heuristic reads as a card number: it survived persistence only through its compact stored form.
  readonly heuristicFlagged: boolean;
  readonly windowRef: string;
  // The request whose answer decided the outcome (the target list load), when the client knows it.
  readonly correlationId?: string | undefined;
  readonly relatedCorrelationIds?: readonly string[] | undefined;
  // How many list loads decided the outcome in total; any the report does not name is loss.
  readonly decidingLoadCount?: number | undefined;
  // `candidates-offered` only, and always there: how many chats the window offered, zero included.
  readonly candidateCount?: number | undefined;
  // `candidates-offered` only, and always there: how many of those offers read alike and show a
  // reference from their chat's fingerprint, zero included.
  readonly disambiguatedCount?: number | undefined;
  // A binding found again after redaction (`fingerprint`, `user-selected`), resolved or found gone,
  // and always a person's decision about a chosen chat: the fingerprint of that chat, never its id.
  readonly targetFingerprint?: string | undefined;
}

const CLIENT_BINDING_INGEST_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "surface",
  "outcome",
  "referenceShape",
  "heuristicFlagged",
  "windowRef",
  "correlationId",
  "relatedCorrelationIds",
  "decidingLoadCount",
  "candidateCount",
  "disambiguatedCount",
  "targetFingerprint",
]);

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

// Only a server-issued UUID (raw, found again through its fingerprint, or chosen by the person) can
// be flagged by the heuristic, and a redaction marker can never have resolved to a live target;
// every other impossible combination is refused as well.
const HEURISTIC_FLAGGABLE_REFERENCE_SHAPES: ReadonlySet<ClientBindingReferenceShape> = new Set([
  "uuid",
  "fingerprint",
  "user-selected",
]);

function hasConsistentBindingReference(value: Record<string, unknown>): boolean {
  if (!isOneOf(value.outcome, CLIENT_BINDING_OUTCOMES)) return false;
  if (!isOneOf(value.referenceShape, CLIENT_BINDING_REFERENCE_SHAPES)) return false;
  if (typeof value.heuristicFlagged !== "boolean") return false;
  if (value.outcome === "resolved" && value.referenceShape === "redacted") return false;
  return !value.heuristicFlagged || HEURISTIC_FLAGGABLE_REFERENCE_SHAPES.has(value.referenceShape);
}

const RESTORED_REFERENCE_SHAPES: ReadonlySet<ClientBindingReferenceShape> = new Set([
  "fingerprint",
  "user-selected",
]);

const CLIENT_BINDING_CHOICE_DECISIONS: ReadonlySet<unknown> = new Set([
  "choice-kept",
  "choice-withdrawn",
]);

function isCandidateCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= CLIENT_BINDING_CANDIDATES_MAX
  );
}

// An offer always states its count and how many of its offers read alike, and nothing else does;
// only a redaction marker offers.
function hasConsistentOffer(value: Record<string, unknown>): boolean {
  const { candidateCount, disambiguatedCount } = value;
  if (value.outcome !== "candidates-offered") {
    return candidateCount === undefined && disambiguatedCount === undefined;
  }
  return (
    value.referenceShape === "redacted" &&
    isCandidateCount(candidateCount) &&
    isCandidateCount(disambiguatedCount) &&
    disambiguatedCount <= candidateCount
  );
}

// A binding found again after redaction may name the chat it bound to, or the chat its fingerprint
// no longer finds, and a person's decision about a chosen chat always does; each only by the chat's
// fingerprint.
function hasConsistentTargetFingerprint(value: Record<string, unknown>): boolean {
  const { targetFingerprint } = value;
  const decision = CLIENT_BINDING_CHOICE_DECISIONS.has(value.outcome);
  if (targetFingerprint === undefined) return !decision;
  if (
    typeof targetFingerprint !== "string" ||
    !CLIENT_BINDING_TARGET_FINGERPRINT_PATTERN.test(targetFingerprint)
  ) {
    return false;
  }
  return (
    (decision || value.outcome === "resolved" || value.outcome === "target-missing") &&
    isOneOf(value.referenceShape, CLIENT_BINDING_REFERENCE_SHAPES) &&
    RESTORED_REFERENCE_SHAPES.has(value.referenceShape)
  );
}

function isDecidingLoadCount(value: unknown): boolean {
  return isBoundedPositiveInteger(value, CLIENT_BINDING_DECIDING_LOADS_MAX);
}

function hasBindingCorrelations(value: Record<string, unknown>): boolean {
  if (!isOptional(value.correlationId, isCorrelationIdShape)) return false;
  if (!isOptional(value.decidingLoadCount, isDecidingLoadCount)) return false;
  const related = value.relatedCorrelationIds;
  if (related === undefined) return true;
  return (
    Array.isArray(related) &&
    related.length <= CLIENT_BINDING_RELATED_CORRELATIONS_MAX &&
    related.every(isCorrelationIdShape)
  );
}

/**
 * True for a closed binding report. An unknown surface, outcome or reference shape, an impossible
 * outcome/reference combination, a missing or oversized window reference, a malformed correlation
 * id, or any undeclared field refuses the whole report, with the same fail-closed discipline as the
 * message and stage shapes.
 */
export function isClientBindingIngestRequest(value: unknown): value is ClientBindingIngestRequest {
  if (!isRecord(value) || value.kind !== "binding") return false;
  if (Object.keys(value).some((key) => !CLIENT_BINDING_INGEST_REQUEST_KEYS.has(key))) return false;
  if (!isOneOf(value.surface, CLIENT_BINDING_SURFACES)) return false;
  if (
    typeof value.windowRef !== "string" ||
    !CLIENT_BINDING_WINDOW_REF_PATTERN.test(value.windowRef)
  ) {
    return false;
  }
  return (
    hasConsistentBindingReference(value) &&
    hasConsistentOffer(value) &&
    hasConsistentTargetFingerprint(value) &&
    hasBindingCorrelations(value)
  );
}

// ─── Stale-session repair evidence (#3557) ───────────────────────────────────────
//
// keiko-ui repairs a read that a restarted BFF denied with 403 DENIED (a local-session request) and
// replays it once. The denied request, the repair and the replay are separate requests; this report
// links them under the denied request's correlation id, which the replay reuses, and names the
// outcome, so a self-healed refusal and one that stayed denied are both reconstructable. A stream
// (EventSource) repair reports under its failure streak's id instead, with the closed stream name:
// an EventSource carries no request correlation the page can read. The local-session endpoint
// acknowledges whether or not it issued a cookie, so a stream reports an acknowledged repair
// (`repair-acknowledged`) at once and its recovery (`stream-repaired`) only when it opens again.

export const CLIENT_SESSION_REPAIR_OUTCOMES = [
  "replayed",
  "stream-repaired",
  "repair-acknowledged",
  "replay-failed",
  "replay-skipped",
  "repair-failed",
] as const;
export const CLIENT_SESSION_REPAIR_STREAMS = ["run-events", "shared-event-source"] as const;
export type ClientSessionRepairStream = (typeof CLIENT_SESSION_REPAIR_STREAMS)[number];
export type ClientSessionRepairOutcome = (typeof CLIENT_SESSION_REPAIR_OUTCOMES)[number];
// A replayed read, a reopened stream and an acknowledged repair are routine evidence; the browser
// and the server budget repair reports by this one rule.
export const CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES: ReadonlySet<ClientSessionRepairOutcome> =
  new Set(["replayed", "stream-repaired", "repair-acknowledged"]);

export interface ClientSessionRepairIngestRequest {
  readonly kind: "session-repair";
  readonly outcome: ClientSessionRepairOutcome;
  // The denied request, which the replay reuses.
  readonly correlationId: string;
  // The local-session repair request. Every outcome follows a repair attempt, whose id the page
  // mints before it sends the request, so a report without it cannot be linked and is refused.
  readonly repairCorrelationId: string;
  // The closed class of the step that failed (the repair request or the replay), so a 502 or a
  // transport failure is never recorded as an authority denial.
  readonly errorKind?: ActivityLogErrorKind | undefined;
  // The stream whose failure streak asked for the repair.
  readonly stream?: ClientSessionRepairStream | undefined;
}

const CLIENT_SESSION_REPAIR_INGEST_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "outcome",
  "correlationId",
  "repairCorrelationId",
  "errorKind",
  "stream",
]);

// Only a repair's own outcome can name a stream (a stream is never replayed), and a stream-only
// outcome always names one.
const STREAM_REPAIR_OUTCOMES: ReadonlySet<ClientSessionRepairOutcome> = new Set([
  "stream-repaired",
  "repair-acknowledged",
  "repair-failed",
]);
const STREAM_ONLY_REPAIR_OUTCOMES: ReadonlySet<ClientSessionRepairOutcome> = new Set([
  "stream-repaired",
  "repair-acknowledged",
]);

function hasConsistentRepairStream(outcome: ClientSessionRepairOutcome, stream: unknown): boolean {
  if (stream === undefined) return !STREAM_ONLY_REPAIR_OUTCOMES.has(outcome);
  return isOneOf(stream, CLIENT_SESSION_REPAIR_STREAMS) && STREAM_REPAIR_OUTCOMES.has(outcome);
}

export function isClientSessionRepairIngestRequest(
  value: unknown,
): value is ClientSessionRepairIngestRequest {
  if (!isRecord(value) || value.kind !== "session-repair") return false;
  if (Object.keys(value).some((key) => !CLIENT_SESSION_REPAIR_INGEST_REQUEST_KEYS.has(key))) {
    return false;
  }
  if (!isOneOf(value.outcome, CLIENT_SESSION_REPAIR_OUTCOMES)) return false;
  if (!isOptional(value.errorKind, isActivityLogErrorKind)) return false;
  if (!hasConsistentRepairStream(value.outcome, value.stream)) return false;
  return (
    isCorrelationIdShape(value.correlationId) && isCorrelationIdShape(value.repairCorrelationId)
  );
}

// ─── Git-client operation settlement (PR #3625 review) ──────────────────────────
//
// A Git-client dialog or manual retry can settle after the surface that asked for it is already
// gone: the Add-repository dialog can be closed while its clone/register request is still in
// flight, and a manual retry of the status/branches/summary reads can recover or fail after its own
// panel unmounted. Reporting only a generic failure-shaped message collapses every one of these
// into one indistinguishable warn-level digest — it cannot show that a repository was created but
// deliberately not activated, tell a discarded clone from a discarded register, or tell a recovered
// retry from one that failed again. This closed pair of fields, always reported together, makes
// each case reconstructable without ever naming the repository, path or URL involved.

export const CLIENT_GIT_CLIENT_OPERATION_KINDS = [
  "repository-clone",
  "repository-register",
  "checkout-selection",
  "status-read",
  "branches-read",
  "summary-read",
] as const;
export type ClientGitClientOperationKind = (typeof CLIENT_GIT_CLIENT_OPERATION_KINDS)[number];

export const CLIENT_GIT_CLIENT_OPERATION_OUTCOMES = [
  "discarded-succeeded",
  "discarded-failed",
  "retry-recovered",
  "retry-failed",
  // A manual retry whose response arrived after a newer read (a redemption, a mutation's revision
  // bump) had already superseded it: neither a recovery nor a failure of the read itself, just
  // discarded evidence (PR #3625 review, GitClientWindow.tsx finding).
  "retry-superseded",
  "started",
  "succeeded",
  "failed",
] as const;
export type ClientGitClientOperationOutcome = (typeof CLIENT_GIT_CLIENT_OPERATION_OUTCOMES)[number];

// The two families never mix: a discarded settlement always names the clone/register operation it
// discarded, a retry settlement always names the status/branches/summary read it retried.
// `isClientDiagnosticGitClientOperation` enforces the pairing rather than trusting the browser to
// send a matching pair.
const GIT_CLIENT_DISCARD_OPERATIONS: ReadonlySet<ClientGitClientOperationKind> = new Set([
  "repository-clone",
  "repository-register",
  "checkout-selection",
]);
const GIT_CLIENT_DISCARD_OUTCOMES: ReadonlySet<ClientGitClientOperationOutcome> = new Set([
  "discarded-succeeded",
  "discarded-failed",
]);
const GIT_CLIENT_ADDITION_OUTCOMES: ReadonlySet<ClientGitClientOperationOutcome> = new Set([
  "started",
  "succeeded",
  "failed",
]);

// The outcomes that represent an actual failure, shared by the client-side POST throttle
// (install-client-diagnostics.ts) and the server's rate-limit budget (client-diagnostics-routes.ts)
// so the two budgets can never drift — exactly like the binding and session-repair outcome sets
// above.
export const CLIENT_GIT_CLIENT_OPERATION_FAILURE_OUTCOMES: ReadonlySet<ClientGitClientOperationOutcome> =
  new Set(["discarded-failed", "retry-failed", "failed"]);

export interface ClientDiagnosticGitClientOperation {
  readonly operation: ClientGitClientOperationKind;
  readonly outcome: ClientGitClientOperationOutcome;
  // Only ever alongside `retry-failed`: the closed reason a resolved (HTTP 200) unavailable
  // response gave for the read that failed, so a git-error retry failure is distinguishable from a
  // thrown/rejected one without the report ever carrying a message (PR #3625 review,
  // GitClientWindow.tsx finding). Never present on a discard, a recovery, or a superseded retry.
  readonly reason?: GitWireUnavailableReason | undefined;
}

function isRepositoryAdditionOperation(operation: string): boolean {
  return operation === "repository-clone" || operation === "repository-register";
}

/**
 * True for a closed, body-free git-client operation settlement: a known operation paired with a
 * known outcome from the SAME family (a discarded add-repository result names a discarded outcome,
 * a retried read names a retry outcome — never the other family's outcome, and never an unknown
 * value on either side), and — only for a retry that failed — an optional closed unavailable
 * reason.
 */
export function isClientDiagnosticGitClientOperation(
  value: unknown,
): value is ClientDiagnosticGitClientOperation {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.operation, CLIENT_GIT_CLIENT_OPERATION_KINDS)) return false;
  if (!isOneOf(value.outcome, CLIENT_GIT_CLIENT_OPERATION_OUTCOMES)) return false;
  // Repository additions report their live lifecycle as well as post-dismissal settlements.
  // Keep the existing retry/discard pairings closed for every other operation.
  if (GIT_CLIENT_ADDITION_OUTCOMES.has(value.outcome)) {
    return isRepositoryAdditionOperation(value.operation) && value.reason === undefined;
  }
  if (
    GIT_CLIENT_DISCARD_OPERATIONS.has(value.operation) !==
    GIT_CLIENT_DISCARD_OUTCOMES.has(value.outcome)
  ) {
    return false;
  }
  if (!isOptional(value.reason, isGitWireUnavailableReason)) return false;
  return value.reason === undefined || value.outcome === "retry-failed";
}

// ─── Git-client manual retry attempt (PR #3625 review) ──────────────────────────
//
// A manual Retry can be superseded by an automatic refetch before it settles (a session redemption
// or a mutation's revision bump starting a newer read first): the settlement callback then simply
// returned without reporting anything, leaving no trace that the operator ever retried or why its
// result was discarded. This minimal report is sent the moment Retry starts, carrying a correlation
// id GitClientWindow.tsx mints before the request goes out; the settlement — `client.git-operation.
// settled` on a recovery or a supersession, `client.diagnostic` on a genuine failure — carries the
// SAME id, so the pair joins on one timeline exactly like `client.stage.started`/`.settled`
// (KEIKO-3557) join theirs.

// Narrower than `ClientGitClientOperationKind`: only the three reads a manual Retry control ever
// attempts (an add-repository clone/register has no retry concept). Typing the field itself this
// way — rather than the full 5-value kind and a runtime-only restriction — keeps a consumer that
// narrows on `isClientGitRetryAttemptIngestRequest` assignable directly into a registration whose
// own field is declared over just these three values, with no further cast.
export type ClientGitRetryOperation = Exclude<
  ClientGitClientOperationKind,
  "repository-clone" | "repository-register" | "checkout-selection"
>;

// Listed, not derived with a module-level `.filter()` of the kinds above: a bundler cannot prove that
// call pure, so it kept the call and the discard set it reads in the browser's first-load chunk,
// which imports this module for unrelated constants (PR #3625, measured against the first-load
// ceiling). diagnostics.test.ts pins this set against every `ClientGitRetryOperation`.
const GIT_RETRY_OPERATIONS: ReadonlySet<string> = new Set<ClientGitRetryOperation>([
  "status-read",
  "branches-read",
  "summary-read",
]);

export interface ClientGitRetryAttemptIngestRequest {
  readonly kind: "git-retry-attempt";
  readonly operation: ClientGitRetryOperation;
  readonly correlationId: string;
}

const CLIENT_GIT_RETRY_ATTEMPT_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "operation",
  "correlationId",
]);

/**
 * True for a closed, minimal retry-attempt report: one of the three retriable reads, paired with a
 * well-formed client-minted correlation id, and no undeclared field.
 */
export function isClientGitRetryAttemptIngestRequest(
  value: unknown,
): value is ClientGitRetryAttemptIngestRequest {
  if (!isRecord(value) || value.kind !== "git-retry-attempt") return false;
  if (Object.keys(value).some((key) => !CLIENT_GIT_RETRY_ATTEMPT_KEYS.has(key))) return false;
  if (!isSetMember(value.operation, GIT_RETRY_OPERATIONS)) return false;
  return isCorrelationIdShape(value.correlationId);
}

// ─── Select menu dismissal evidence (PR #3625 review) ───────────────────────────
//
// An open `KeikoSelect` menu consumes Escape wherever focus sits — the trigger, the search box, or
// an option — instead of leaving it to the workspace's own Escape shortcut, which otherwise would
// have cleared the window selection while the menu stayed open (KeikoSelect.tsx, `consumeEscape`).
// Which surface an operator's Escape dismisses is a changed product runtime behaviour with no other
// trace: the log cannot otherwise distinguish "the menu was closed by this Escape" from "the menu
// was never opened". This closed, body-free pair rides the message shape's `kind: "other"` exactly
// like `gitClientOperation` above; only a closed reason and the closed location focus sat in are
// admitted — never a label, a value, or any option text the select showed.

export const CLIENT_SELECT_DISMISSAL_REASONS = ["escape"] as const;
export type ClientSelectDismissalReason = (typeof CLIENT_SELECT_DISMISSAL_REASONS)[number];

export const CLIENT_SELECT_DISMISSAL_FOCUS_LOCATIONS = [
  "trigger",
  "search",
  "option",
  "menu",
] as const;
export type ClientSelectDismissalFocus = (typeof CLIENT_SELECT_DISMISSAL_FOCUS_LOCATIONS)[number];

export interface ClientDiagnosticSelectDismissal {
  readonly reason: ClientSelectDismissalReason;
  readonly focus: ClientSelectDismissalFocus;
}

const SELECT_DISMISSAL_REASON_SET: ReadonlySet<string> = new Set(CLIENT_SELECT_DISMISSAL_REASONS);
const SELECT_DISMISSAL_FOCUS_SET: ReadonlySet<string> = new Set(
  CLIENT_SELECT_DISMISSAL_FOCUS_LOCATIONS,
);

/**
 * True for a closed, body-free select dismissal: a known reason paired with a known focus location,
 * never an unknown value on either side and never an undeclared field.
 */
export function isClientDiagnosticSelectDismissal(
  value: unknown,
): value is ClientDiagnosticSelectDismissal {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== "reason" && key !== "focus")) return false;
  return (
    isSetMember(value.reason, SELECT_DISMISSAL_REASON_SET) &&
    isSetMember(value.focus, SELECT_DISMISSAL_FOCUS_SET)
  );
}

// ─── Knowledge Pod catalog availability (PR #3678 review) ─────────────────────────
//
// The chat's Knowledge Pod picker offered no usable pod: every bound pod is missing or not ready,
// or no pod is ready at all. Counts only — never a pod name, path or id — so the Activity Log can
// tell a missing bound pod from one that is still indexing without a free-text message.

export const CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX = 100_000;

export interface ClientDiagnosticKnowledgeCatalog {
  readonly podCount: number;
  readonly readyPodCount: number;
  readonly setCount: number;
  readonly boundCount: number;
  readonly missingCount: number;
  readonly notReadyCount: number;
}

const KNOWLEDGE_CATALOG_COUNT_KEYS: ReadonlySet<string> = new Set([
  "podCount",
  "readyPodCount",
  "setCount",
  "boundCount",
  "missingCount",
  "notReadyCount",
]);

/** True for exactly the six bounded, non-negative catalog counts and no other field. */
export function isClientDiagnosticKnowledgeCatalog(
  value: unknown,
): value is ClientDiagnosticKnowledgeCatalog {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== KNOWLEDGE_CATALOG_COUNT_KEYS.size) return false;
  return keys.every(
    (key) =>
      KNOWLEDGE_CATALOG_COUNT_KEYS.has(key) &&
      isBoundedNonNegativeInteger(value[key], CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX),
  );
}

// ─── Chat answer copy (PR #3678 review) ─────────────────────────────────────────
//
// The copy button removes a grounded answer's in-range citation markers and keeps every other
// bracket (code, an ordinary answer, an index beyond the references). Counts only — never the
// copied text — so the log shows that the path ran, what it removed and kept, and a failure.

export const CLIENT_ANSWER_COPY_OUTCOMES = ["copied", "failed"] as const;
export type ClientAnswerCopyOutcome = (typeof CLIENT_ANSWER_COPY_OUTCOMES)[number];

export interface ClientDiagnosticAnswerCopy {
  readonly outcome: ClientAnswerCopyOutcome;
  readonly grounded: boolean;
  /** Citation marker groups removed from the copied text. */
  readonly strippedGroupCount: number;
  /** Numeric bracket groups outside code kept as content. */
  readonly keptGroupCount: number;
}

const ANSWER_COPY_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_ANSWER_COPY_OUTCOMES);
const ANSWER_COPY_KEYS: ReadonlySet<string> = new Set([
  "outcome",
  "grounded",
  "strippedGroupCount",
  "keptGroupCount",
]);

/** True for exactly the closed copy outcome, the grounded flag and the two bounded counts. */
export function isClientDiagnosticAnswerCopy(value: unknown): value is ClientDiagnosticAnswerCopy {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ANSWER_COPY_KEYS.size || keys.some((key) => !ANSWER_COPY_KEYS.has(key))) {
    return false;
  }
  return (
    isSetMember(value.outcome, ANSWER_COPY_OUTCOME_SET) &&
    typeof value.grounded === "boolean" &&
    isBoundedNonNegativeInteger(value.strippedGroupCount, CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX) &&
    isBoundedNonNegativeInteger(value.keptGroupCount, CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX)
  );
}

// ─── Chat answer read aloud (PR #3678 review) ───────────────────────────────────
//
// The voice dialogue reads an answer aloud without its grounded citation markers and keeps every
// other bracket, a repository path included. Counts only — never the spoken text — reported under
// the correlation the synthesis request carries, so the spoken turn and its preparation join.

export interface ClientDiagnosticAnswerSpeech {
  readonly grounded: boolean;
  /** Citation marker groups removed from the spoken text. */
  readonly strippedGroupCount: number;
  /** Numeric bracket groups outside code kept as spoken content. */
  readonly keptGroupCount: number;
}

const ANSWER_SPEECH_KEYS: ReadonlySet<string> = new Set([
  "grounded",
  "strippedGroupCount",
  "keptGroupCount",
]);

/** True for exactly the grounded flag and the two bounded counts. */
export function isClientDiagnosticAnswerSpeech(
  value: unknown,
): value is ClientDiagnosticAnswerSpeech {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ANSWER_SPEECH_KEYS.size || keys.some((key) => !ANSWER_SPEECH_KEYS.has(key))) {
    return false;
  }
  return (
    typeof value.grounded === "boolean" &&
    isBoundedNonNegativeInteger(value.strippedGroupCount, CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX) &&
    isBoundedNonNegativeInteger(value.keptGroupCount, CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX)
  );
}

// ─── Restored coding run (#3876 review) ──────────────────────────────────────────
//
// After a reload the Coding Workbench rebuilds a settled run's conversation from Coding History and
// shows the newest part of it in the timeline, within the safe-activity contract's own bounds. What
// the feed cannot carry stays in the transcript above it, so the only text shown nowhere is a
// message cut to the per-message bound and what Coding History itself never listed — and those two
// alone make the page say the activity is truncated. Counts only — never a message, a path or a
// run name — so the log tells where every message of the run went and whether the page said so.

/** Bounds the message and turn counts: Coding History lists at most 200 messages per task. */
export const CLIENT_CODING_RUN_RESTORE_COUNT_MAX = 100_000;
/**
 * Bounds the sizes: the feed's bytes, and the transcript's characters — 200 messages of 65,536
 * characters each, counted by length without reading the text.
 */
export const CLIENT_CODING_RUN_RESTORE_SIZE_MAX = 67_108_864;

export interface ClientDiagnosticCodingRunRestore {
  /** Messages of the run the timeline carries, cut ones included. */
  readonly timelineCount: number;
  /** Messages older than the timeline's first: the transcript carries them instead, whole. */
  readonly transcriptCount: number;
  /** Timeline messages whose text was cut to the per-message bound: the rest is shown nowhere. */
  readonly cutCount: number;
  /** Turns of the restored feed. */
  readonly turnCount: number;
  /** UTF-8 bytes of the restored feed, measured the way the contract measures its budgets. */
  readonly feedBytes: number;
  /** Characters (UTF-16 code units) of the messages the transcript carries instead. */
  readonly transcriptChars: number;
  /** Coding History cut the task's stored messages: older ones are shown nowhere. */
  readonly historyTruncated: boolean;
}

const CODING_RUN_RESTORE_KEYS: ReadonlySet<string> = new Set([
  "timelineCount",
  "transcriptCount",
  "cutCount",
  "turnCount",
  "feedBytes",
  "transcriptChars",
  "historyTruncated",
]);

function isCodingRunRestoreCount(value: unknown): value is number {
  return isBoundedNonNegativeInteger(value, CLIENT_CODING_RUN_RESTORE_COUNT_MAX);
}

function isCodingRunRestoreSize(value: unknown): value is number {
  return isBoundedNonNegativeInteger(value, CLIENT_CODING_RUN_RESTORE_SIZE_MAX);
}

// The counts must describe one restoration: a turn holds a message, a cut message is a carried
// one, and the transcript holds characters exactly when it holds messages.
function coherentCodingRunRestore(value: ClientDiagnosticCodingRunRestore): boolean {
  return (
    value.cutCount <= value.timelineCount &&
    value.turnCount <= value.timelineCount &&
    (value.turnCount === 0) === (value.timelineCount === 0) &&
    (value.transcriptCount === 0) === (value.transcriptChars === 0) &&
    value.transcriptChars >= value.transcriptCount &&
    value.feedBytes > 0
  );
}

function codingRunRestoreOf(
  value: Record<string, unknown>,
): ClientDiagnosticCodingRunRestore | undefined {
  const { timelineCount, transcriptCount, cutCount, turnCount } = value;
  const { feedBytes, transcriptChars, historyTruncated } = value;
  if (
    !isCodingRunRestoreCount(timelineCount) ||
    !isCodingRunRestoreCount(transcriptCount) ||
    !isCodingRunRestoreCount(cutCount) ||
    !isCodingRunRestoreCount(turnCount)
  ) {
    return undefined;
  }
  if (
    !isCodingRunRestoreSize(feedBytes) ||
    !isCodingRunRestoreSize(transcriptChars) ||
    typeof historyTruncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    timelineCount,
    transcriptCount,
    cutCount,
    turnCount,
    feedBytes,
    transcriptChars,
    historyTruncated,
  };
}

/** True for exactly the four bounded counts, the two bounded sizes and the history flag. */
function isClientDiagnosticCodingRunRestore(
  value: unknown,
): value is ClientDiagnosticCodingRunRestore {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== CODING_RUN_RESTORE_KEYS.size ||
    keys.some((key) => !CODING_RUN_RESTORE_KEYS.has(key))
  ) {
    return false;
  }
  const restore = codingRunRestoreOf(value);
  return restore !== undefined && coherentCodingRunRestore(restore);
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
  /** @deprecated Accepted for wire compatibility only; current servers never produce this count. */
  readonly retainedDiagnosticCount?: number | undefined;
  /** @deprecated Accepted for wire compatibility only; readiness does not measure store capacity. */
  readonly diagnosticCapacity?: number | undefined;
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

function hasCoherentDiagnosticCapacity(value: Record<string, unknown>): boolean {
  const count = value.retainedDiagnosticCount;
  const capacity = value.diagnosticCapacity;
  if (count === undefined && capacity === undefined) return true;
  return (
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count >= 0 &&
    typeof capacity === "number" &&
    Number.isSafeInteger(capacity) &&
    capacity > 0
  );
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
    value.lostEvents >= 0 &&
    hasCoherentDiagnosticCapacity(value)
  );
}

/** Classifies metadata already refused by isActivityLogReadinessSnapshot; never infers version skew. */
export function classifyInvalidActivityLogReadiness(
  value: unknown,
): HealthDiagnosticsInvalidReason {
  if (value === null) return "null-shape";
  if (
    isRecord(value) &&
    typeof value.readiness === "string" &&
    !READINESS_STATE_SET.has(value.readiness)
  )
    return "readiness-value";
  return "snapshot-shape";
}

/** A browser initiation, never acknowledgement that the operating system saved a file. */
export type ClientSupportReportDelivery =
  | "automatic"
  | "manual"
  | {
      readonly mode: "manual";
      readonly source: "server" | "browser";
      readonly evidenceScope: "server" | "client-only";
      readonly reportDigest?: string | undefined;
    };
function isReportDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
const SUPPORT_REPORT_DELIVERY_SCOPES = new Set(["server", "client-only"]);
const SUPPORT_REPORT_DELIVERY_KEYS = new Set(["mode", "source", "evidenceScope", "reportDigest"]);
function hasCoherentSupportReportDeliverySource(value: Record<string, unknown>): boolean {
  if (value.source === "browser") return value.evidenceScope === "client-only";
  return (
    value.source === "server" && isSetMember(value.evidenceScope, SUPPORT_REPORT_DELIVERY_SCOPES)
  );
}
export function isClientSupportReportDelivery(
  value: unknown,
): value is ClientSupportReportDelivery {
  // Legacy strings remain accepted from already-open tabs; current producers supply provenance.
  if (value === "automatic" || value === "manual") return true;
  if (!isRecord(value) || Object.keys(value).some((key) => !SUPPORT_REPORT_DELIVERY_KEYS.has(key)))
    return false;
  return (
    value.mode === "manual" &&
    hasCoherentSupportReportDeliverySource(value) &&
    isOptional(value.reportDigest, isReportDigest)
  );
}

/** Successful browser fallback preparation; no report content or claim of an OS save. */
interface ClientSupportReportPrepared {
  readonly reportBytes: number;
  readonly evidenceScope: "server" | "client-only";
  readonly completeness: ActivityLogCompletenessState;
  readonly loss: ActivityLogLossState;
  readonly availabilityReason?: SupportReportAvailabilityReason | undefined;
}
export type ClientSupportReportPreparation =
  | ClientSupportReportPrepared
  | {
      readonly outcome: "failed";
      readonly errorKind: ActivityLogErrorKind;
      readonly durationMs: number;
      readonly originalErrorKind?: ActivityLogErrorKind | undefined;
      readonly errorEvidence?: ClientErrorEvidence | undefined;
    };
const SUPPORT_REPORT_PREPARATION_FAILURE_KEYS = new Set([
  "outcome",
  "errorKind",
  "durationMs",
  "originalErrorKind",
  "errorEvidence",
]);

const SUPPORT_REPORT_PREPARATION_KEYS = new Set([
  "reportBytes",
  "evidenceScope",
  "completeness",
  "loss",
  "availabilityReason",
]);
const REPORT_AVAILABILITY = new Set<string>(SUPPORT_REPORT_AVAILABILITY_REASONS);
// Initialized after module evaluation to avoid the existing observability/report import cycle.
let supportPreparationStates:
  { completeness: ReadonlySet<string>; loss: ReadonlySet<string> } | undefined;
function supportReportStateSets(): {
  completeness: ReadonlySet<string>;
  loss: ReadonlySet<string>;
} {
  supportPreparationStates ??= {
    completeness: new Set(ACTIVITY_LOG_COMPLETENESS_STATES),
    loss: new Set(ACTIVITY_LOG_LOSS_STATES),
  };
  return supportPreparationStates;
}

function isSupportReportPreparationBytes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SUPPORT_REPORT_BYTES
  );
}
function isFailedSupportReportPreparation(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).every((key) => SUPPORT_REPORT_PREPARATION_FAILURE_KEYS.has(key)) &&
    isActivityLogErrorKind(value.errorKind) &&
    isOptional(value.originalErrorKind, isActivityLogErrorKind) &&
    isOptional(value.errorEvidence, isClientErrorEvidence) &&
    isBoundedNonNegativeInteger(value.durationMs, CLIENT_STAGE_DURATION_MS_MAX)
  );
}
export function isClientSupportReportPreparation(
  value: unknown,
): value is ClientSupportReportPreparation {
  if (!isRecord(value)) return false;
  if (value.outcome === "failed") return isFailedSupportReportPreparation(value);
  if (Object.keys(value).some((key) => !SUPPORT_REPORT_PREPARATION_KEYS.has(key))) return false;
  return (
    isSupportReportPreparationBytes(value.reportBytes) &&
    (value.evidenceScope === "server" || value.evidenceScope === "client-only") &&
    isSetMember(value.completeness, supportReportStateSets().completeness) &&
    isSetMember(value.loss, supportReportStateSets().loss) &&
    coherentReportPreparationScope(value)
  );
}

function coherentReportPreparationScope(value: Record<string, unknown>): boolean {
  if (value.evidenceScope === "server") return !("availabilityReason" in value);
  return (
    value.completeness === "complete" &&
    value.loss === "none" &&
    isSetMember(value.availabilityReason, REPORT_AVAILABILITY)
  );
}

/** Closed source ownership and shared grounding-queue decisions; no references or source content. */
export const CLIENT_FILES_SCOPE_DECISIONS = [
  "restored",
  "owned-elsewhere",
  "released",
  "blocked-ambiguous",
  "fingerprint-absent",
  "conflict-retried",
  "ack-missing",
  "acknowledged",
  "ack-invalidated",
  "automatic-suppressed",
  "timeout-blocked",
  "timeout-recovered",
  "timeout-rejected",
  "request-superseded",
] as const;
export interface ClientFilesScopeDecision {
  readonly decision: (typeof CLIENT_FILES_SCOPE_DECISIONS)[number];
  readonly sourceCount?: number | undefined;
  readonly candidateCount?: number | undefined;
  readonly bindingFingerprint?: string | undefined;
  readonly mutationSurface?: (typeof CLIENT_GROUNDING_MUTATION_SURFACES)[number] | undefined;
  readonly rejectionCount?: number | undefined;
}
const FILES_SCOPE_DECISIONS: ReadonlySet<unknown> = new Set(CLIENT_FILES_SCOPE_DECISIONS);
export const CLIENT_GROUNDING_MUTATION_SURFACES = [
  "files",
  "local-knowledge",
  "git-change",
] as const;
const GROUNDING_MUTATION_SURFACES: ReadonlySet<unknown> = new Set(
  CLIENT_GROUNDING_MUTATION_SURFACES,
);
const FILES_SCOPE_DECISION_KEYS = new Set([
  "decision",
  "sourceCount",
  "candidateCount",
  "bindingFingerprint",
  "mutationSurface",
  "rejectionCount",
]);
const SCOPE_OWNERSHIP_DECISIONS: ReadonlySet<unknown> = new Set([
  "restored",
  "released",
  "blocked-ambiguous",
  "fingerprint-absent",
  "acknowledged",
]);
const SCOPE_MUTATION_DECISIONS: ReadonlySet<unknown> = new Set([
  "conflict-retried",
  "timeout-blocked",
  "timeout-recovered",
  "timeout-rejected",
  "request-superseded",
]);
function isScopeDecisionCount(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}
function hasCoherentScopeDecisionFields(value: Record<string, unknown>): boolean {
  const ownership = SCOPE_OWNERSHIP_DECISIONS.has(value.decision);
  const candidate = ownership || value.decision === "ack-invalidated";
  return (
    (value.sourceCount === undefined || ownership) &&
    (value.candidateCount === undefined || candidate) &&
    (value.bindingFingerprint === undefined || candidate) &&
    (value.mutationSurface === undefined || SCOPE_MUTATION_DECISIONS.has(value.decision))
  );
}
function hasValidScopeArrayCounts(value: Record<string, unknown>): boolean {
  // These producers count JS arrays of connected scopes, whose length cannot exceed uint32.
  // This is an evidence representation constraint, not a recursive-search file-count limit.
  const arrayLengthMax = 4_294_967_295;
  return (
    (value.sourceCount === undefined ||
      isBoundedNonNegativeInteger(value.sourceCount, arrayLengthMax)) &&
    (value.candidateCount === undefined ||
      isBoundedNonNegativeInteger(value.candidateCount, arrayLengthMax)) &&
    (typeof value.sourceCount !== "number" ||
      typeof value.candidateCount !== "number" ||
      value.candidateCount <= value.sourceCount)
  );
}
function isClientFilesScopeDecision(value: unknown): value is ClientFilesScopeDecision {
  if (!isRecord(value) || Object.keys(value).some((key) => !FILES_SCOPE_DECISION_KEYS.has(key)))
    return false;
  return (
    FILES_SCOPE_DECISIONS.has(value.decision) &&
    (value.mutationSurface === undefined ||
      GROUNDING_MUTATION_SURFACES.has(value.mutationSurface)) &&
    hasValidScopeArrayCounts(value) &&
    hasCoherentScopeDecisionFields(value) &&
    hasValidScopeRejectionCount(value) &&
    isOptional(value.bindingFingerprint, isScopeBindingFingerprint)
  );
}

function isScopeBindingFingerprint(value: unknown): value is string {
  return typeof value === "string" && CLIENT_BINDING_TARGET_FINGERPRINT_PATTERN.test(value);
}

function hasValidScopeRejectionCount(value: Record<string, unknown>): boolean {
  return (
    value.rejectionCount === undefined ||
    (value.decision === "timeout-recovered" && isScopeDecisionCount(value.rejectionCount))
  );
}
function hasValidFilesScopeDecisionContext(value: Record<string, unknown>): boolean {
  if (value.filesScopeDecision === undefined) return true;
  return (
    isClientFilesScopeDecision(value.filesScopeDecision) &&
    isActivityLogCorrelationId(value.correlationId)
  );
}

/** Citation attribution and the actual navigation decision, without paths or fingerprints. */
export interface ClientDiagnosticCitationActivation {
  readonly reason: "matched" | "unmatched" | "absent" | "malformed" | "ambiguous";
  readonly outcome: "opened" | "open-refused" | "picker-opened" | "picker-dismissed" | "refused";
  readonly rootCount: number;
  readonly matchCount: number;
}
const CITATION_ACTIVATION_REASONS: ReadonlySet<unknown> = new Set([
  "matched",
  "unmatched",
  "absent",
  "malformed",
  "ambiguous",
]);
const CITATION_ACTIVATION_OUTCOMES: ReadonlySet<unknown> = new Set([
  "opened",
  "open-refused",
  "picker-opened",
  "picker-dismissed",
  "refused",
]);
const CITATION_ACTIVATION_KEYS = new Set(["reason", "outcome", "rootCount", "matchCount"]);

function coherentCitationMatchCount(value: Record<string, unknown>): boolean {
  if (value.reason === "matched") return value.matchCount === 1;
  if (value.reason === "ambiguous")
    return typeof value.matchCount === "number" && value.matchCount > 1;
  return value.matchCount === 0;
}

function coherentCitationOutcome(value: Record<string, unknown>): boolean {
  return (
    value.outcome === "refused" || (typeof value.rootCount === "number" && value.rootCount > 0)
  );
}

function isClientDiagnosticCitationActivation(
  value: unknown,
): value is ClientDiagnosticCitationActivation {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== CITATION_ACTIVATION_KEYS.size ||
    keys.some((key) => !CITATION_ACTIVATION_KEYS.has(key))
  )
    return false;
  return (
    CITATION_ACTIVATION_REASONS.has(value.reason) &&
    CITATION_ACTIVATION_OUTCOMES.has(value.outcome) &&
    isBoundedNonNegativeInteger(value.rootCount, CLIENT_KNOWLEDGE_CATALOG_COUNT_MAX) &&
    isBoundedNonNegativeInteger(value.matchCount, value.rootCount) &&
    coherentCitationMatchCount(value) &&
    coherentCitationOutcome(value)
  );
}

function hasValidCitationActivationContext(value: Record<string, unknown>): boolean {
  if (value.citationActivation === undefined) return true;
  return (
    isActivityLogCorrelationId(value.correlationId) &&
    isClientDiagnosticCitationActivation(value.citationActivation)
  );
}
