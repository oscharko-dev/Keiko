import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_OPERATOR_DECISIONS,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuxiliaryStatus,
  type CodingWorkbenchContentTrust,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchOperatorDecision,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
  type CodingWorkbenchVerificationSummary,
  type CodingWorkbenchNativeRetry,
} from "./coding-workbench.js";
import { validateCodingWorkbenchPermissionRequest } from "./coding-workbench-validation.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  sseEventKeys,
  validateSafeId,
  validateSseEventFields,
  validateStrictUtcInstant,
} from "./coding-workbench-runtime-api-validation.js";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  type CodingWorkbenchIssueBinding,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStateName,
} from "./coding-workbench-runtime.js";
import type {
  CodingWorkbenchGatewayEventKind,
  CodingWorkbenchTurnFailureCode,
} from "./coding-workbench-runtime-constants.js";
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from "./gateway.js";
export {
  CODING_WORKBENCH_GATEWAY_EVENT_KINDS,
  type CodingWorkbenchGatewayEventKind,
  type CodingWorkbenchTurnFailureCode,
} from "./coding-workbench-runtime-constants.js";
import { validateCodingWorkbenchIssueBinding } from "./coding-workbench-issue-binding.js";
export { CODING_WORKBENCH_ISSUE_NUMBER_MAX } from "./coding-workbench-issue-binding.js";
import { GITHUB_ISSUE_REFERENCE_MAX_CHARS } from "./github-issue-reference.js";
import { isVerifiedCommitResult, type VerifiedCommitResult } from "./verified-commit.js";
import { isDraftDeliveryRecord, type DraftDeliveryRecord } from "./draft-delivery.js";
import { isReadinessSnapshot, type ReadinessSnapshot } from "./git-ci-readiness.js";
import {
  isWorkbenchDescriptionStatus,
  type WorkbenchDescriptionStatus,
} from "./workbench-description-status.js";

/** Browser-level preference, deliberately not an adapter, model, profile, or endpoint selector. */
export type CodingWorkbenchRuntimePreference = "managed-gateway" | "codex-subscription";

export const CODING_WORKBENCH_RUNTIME_PREFERENCES: readonly CodingWorkbenchRuntimePreference[] =
  Object.freeze(["managed-gateway", "codex-subscription"] as const);

export const CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS = 128;
export const CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS = 200;
export const CODING_WORKBENCH_RUNTIME_SSE_CURSOR_MAX_CHARS = 128;

export interface CodingWorkbenchRuntimeReadinessRequest {
  readonly requestedMode: CodingWorkbenchMode;
}

/**
 * Closed, content-free reason vocabulary for `runtimeAvailable: false`. Codes name the first
 * failed activation prerequisite; they never carry paths, digests, or environment values.
 */
export type CodingWorkbenchRuntimeUnavailableReason =
  | "runtime-disabled"
  | "platform-unqualified"
  | "dev-lane-refused"
  | "payload-missing"
  | "payload-unapproved"
  | "payload-tampered"
  | "secure-read-unavailable"
  | "loopback-unavailable"
  | "runtime-unqualified";

export const CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS: readonly CodingWorkbenchRuntimeUnavailableReason[] =
  Object.freeze([
    "runtime-disabled",
    "platform-unqualified",
    "dev-lane-refused",
    "payload-missing",
    "payload-unapproved",
    "payload-tampered",
    "secure-read-unavailable",
    "loopback-unavailable",
    "runtime-unqualified",
  ] as const);

/**
 * How much evidence backs an AVAILABLE runtime. `platform-qualified` is the release-signed,
 * notarized/Authenticode-attested packaged artifact. `functional-not-platform-qualified` covers
 * every runtime whose integrity is proven by recomputed digests alone and that carries no platform
 * signature chain — the supported dev lane (ADR-0140) and the packaged evaluation lane (ADR-0163 D9).
 */
export type CodingWorkbenchRuntimeEvidenceClass =
  "platform-qualified" | "functional-not-platform-qualified";

export const CODING_WORKBENCH_RUNTIME_EVIDENCE_CLASSES: readonly CodingWorkbenchRuntimeEvidenceClass[] =
  Object.freeze(["platform-qualified", "functional-not-platform-qualified"] as const);

/** Content-free server authority and runtime-composition projection used before Start is enabled. */
export interface CodingWorkbenchRuntimeReadiness {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeAvailable: boolean;
  /** Present exactly when `runtimeAvailable` is false; names the first failed prerequisite. */
  readonly runtimeUnavailableReason?: CodingWorkbenchRuntimeUnavailableReason | undefined;
  /**
   * Present exactly when `runtimeAvailable` is true. An available runtime must always say how
   * strong its evidence is: an absent field that read as "verified" would be a fail-open default
   * and would reproduce the green-readiness-over-an-unverified-runtime class (audit F-01).
   */
  readonly runtimeEvidenceClass?: CodingWorkbenchRuntimeEvidenceClass | undefined;
}

export interface CodingWorkbenchRuntimeProjectMemoryRequest {
  readonly enabled: boolean;
}

export interface CodingWorkbenchRuntimeStartRequest {
  readonly requestId: string;
  /** Transient model input; no response, snapshot, SSE projection, or evidence may retain it. */
  readonly taskIntent: string;
  /** Durable conversation identity; never grants execution authority. */
  readonly conversationId?: string | undefined;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference?: CodingWorkbenchRuntimePreference | undefined;
  readonly modelId?: string | undefined;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
  /**
   * The GitHub issue the run must be bound to (#3385): the raw text the user pasted — an issue URL,
   * `owner/repo#n` or `#n` — never a structured repository/number pair the browser could author.
   * The server resolves it against the ACTIVE workspace's own repository into a content-free
   * `CodingWorkbenchIssueBinding` before any run is minted; a deployment without that resolver
   * refuses the field outright, so supplying it can never silently start a generic run. Transient
   * intent like `taskIntent`: it is parsed, never persisted.
   */
  readonly issueRef?: string | undefined;
  /** Optimistic precondition from the accepted preview; never authority. */
  readonly expectedIssueBindingDigest?: string | undefined;
  /** A prompt link supplies context; only an explicit delivery request binds the run to delivery. */
  readonly issuePurpose?: "context" | "delivery" | undefined;
  /**
   * Operator preference only. The browser can turn project memory context on/off for this run, but
   * it cannot choose scopes, paths, user memory, or credentials. The server derives those from the
   * active workspace binding and defaults an omitted field to enabled for older clients.
   */
  readonly projectMemory?: CodingWorkbenchRuntimeProjectMemoryRequest | undefined;
}

/** The retry route has the same fresh, transient intent shape as start. */
export type CodingWorkbenchRuntimeRetryRequest = CodingWorkbenchRuntimeStartRequest;

export interface CodingWorkbenchRuntimeStopRequest {
  readonly requestId: string;
}

export interface CodingWorkbenchRuntimeResumeRequest {
  readonly requestId: string;
  /** Omitted means retain the run's current mode; supplied values may only narrow it. */
  readonly requestedMode?: CodingWorkbenchMode | undefined;
}

export interface CodingWorkbenchRuntimeTakeoverRequest {
  readonly requestId: string;
}

export type CodingWorkbenchRuntimeApprovalDecision = "approved" | "denied";

export const CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS: readonly CodingWorkbenchRuntimeApprovalDecision[] =
  Object.freeze(["approved", "denied"] as const);

/**
 * The bounded, content-free permission fact required to bind an approval decision to a snapshot.
 * This deliberately reuses the existing validated public permission vocabulary.
 */
export type CodingWorkbenchRuntimePendingPermission = Pick<
  CodingWorkbenchPermissionRequest,
  | "requestId"
  | "kind"
  | "actionClass"
  | "reasonCode"
  | "actionKind"
  | "scopeLabel"
  | "risk"
  | "policyReason"
  | "connectorScopes"
  | "commandLabel"
  | "expiresAt"
>;

export interface CodingWorkbenchRuntimeApprovalDecisionRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly decision: CodingWorkbenchRuntimeApprovalDecision;
  readonly grantScope?: "once" | "task" | undefined;
  readonly commandTemplateId?: string | undefined;
  readonly safeArgumentClasses?: readonly string[] | undefined;
}

// Body for POST /runs/:runId/research/revoke (#2387). Bound to the observed revision and the exact
// grant id so a stale or forged revoke fails closed; the server drops the grant for the parent AND
// every child and answers with the revision-bumped, grant-absent snapshot.
export interface CodingWorkbenchRuntimeResearchRevokeRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly grantId: string;
}

export interface CodingWorkbenchRuntimeRecoveryAcknowledgementRequest {
  readonly requestId: string;
  readonly acknowledged: true;
}

export type CodingWorkbenchRuntimeResultStatus = "cancelled" | "failed" | "signalled" | "succeeded";

export interface CodingWorkbenchRuntimeProcessSummary {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface CodingWorkbenchRuntimeResult {
  readonly status: CodingWorkbenchRuntimeResultStatus;
  readonly exitCode: number | null;
  readonly output: CodingWorkbenchRuntimeProcessSummary;
  readonly error: CodingWorkbenchRuntimeProcessSummary;
}

export type CodingWorkbenchContextUsageSource = "estimated" | "provider-reported";

/** Optional measured attribution. Omitted categories were not reported and must not be inferred. */
export interface CodingWorkbenchContextUsageBreakdown {
  readonly conversationMessagesTokens?: number | undefined;
  readonly systemContextTokens?: number | undefined;
  readonly toolDefinitionTokens?: number | undefined;
  readonly providerAccountingAdjustmentTokens?: number | undefined;
}

export interface CodingWorkbenchContextCompaction {
  readonly count: number;
  readonly lastCompactedAt?: string | undefined;
  readonly thresholdTokens?: number | undefined;
}

export type CodingWorkbenchContextUsage =
  | {
      readonly state: "unavailable";
      readonly updatedAt: string;
    }
  | {
      readonly state: "available";
      readonly source: CodingWorkbenchContextUsageSource;
      readonly capacityTokens: number;
      readonly usedInputTokens: number;
      readonly reservedOutputTokens: number;
      readonly freeTokens: number;
      readonly breakdown?: CodingWorkbenchContextUsageBreakdown | undefined;
      readonly cumulativePromptTokens: number;
      readonly runPromptBudgetTokens?: number | undefined;
      readonly compaction?: CodingWorkbenchContextCompaction | undefined;
      readonly updatedAt: string;
    };

/**
 * Content-free status projection. `runId` is intentionally optional for unbound availability
 * states; task/workspace/authority/process/model content never crosses this boundary.
 */
export interface CodingWorkbenchRuntimeSnapshot {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runId?: string | undefined;
  /** Original start/retry intent; never rewritten by a narrower resume. */
  readonly requestedMode?: CodingWorkbenchMode | undefined;
  /** Server-confirmed live authority after ceiling and resume narrowing. */
  readonly effectiveMode?: CodingWorkbenchMode | undefined;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  /** Honest runtime/provider accounting; unavailable never implies a guessed model limit. */
  readonly contextUsage?: CodingWorkbenchContextUsage | undefined;
  /** Present only when durable server truth records acknowledgement for a recovery-required run. */
  readonly recoveryAcknowledged?: true | undefined;
  /** Present exactly while the runtime is awaiting an operator decision. */
  readonly pendingPermission?: CodingWorkbenchRuntimePendingPermission | undefined;
  /**
   * Why the run is `paused`. Absent means an operator paused it from the Workbench, which is what
   * `paused` used to mean unconditionally. A value names a decision only a local human can make and
   * a governed tool is waiting in place for; the run resumes itself once that decision lands, so
   * the operator's action is the decision, not a Resume click.
   */
  readonly pauseReason?: CodingWorkbenchOperatorDecision | undefined;
  /** Terminal, body-free process outcome; never contains stdout or stderr content. */
  readonly result?: CodingWorkbenchRuntimeResult | undefined;
  /**
   * Present exactly when the run was started from an accepted GitHub issue (#3385). Digests, a
   * number and a branch name only — the issue's text never crosses this boundary.
   */
  readonly issueBinding?: CodingWorkbenchIssueBinding | undefined;
  /** Latest durable commit receipt; no message, paths, command or approval token. */
  readonly verifiedCommitResult?: VerifiedCommitResult | undefined;
  /** Durable repository delivery facts; no authored text, command, credentials or approval grant. */
  readonly draftDelivery?: DraftDeliveryRecord | undefined;
  /** Last bounded CI observation. Its timestamp and head binding confer no execution authority. */
  readonly ciReadiness?: ReadinessSnapshot | undefined;
  /**
   * Present exactly when a stable succeeded head has an automatic description-draft attempt
   * (#3401). No title, body, diff or model text ever crosses this boundary — see
   * `WorkbenchDescriptionStatus`. Generation grants no remote-write authority: applying the draft
   * still uses #3399's existing PR preview, policy and one-use approval.
   */
  readonly descriptionStatus?: WorkbenchDescriptionStatus | undefined;
  readonly conversationId?: string | undefined;
}

export type CodingWorkbenchRuntimeStatus = CodingWorkbenchRuntimeSnapshot;

export type CodingWorkbenchRuntimeSseEventKind = "status" | "runtime-event";

export const CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS: readonly CodingWorkbenchRuntimeSseEventKind[] =
  Object.freeze(["status", "runtime-event"] as const);

/**
 * Bounded SSE projection. It reports only the lifecycle vocabulary, a monotonic revision, and a
 * safe cursor; raw prompt/model/process/workspace content remains on the server's transient path.
 */
export type CodingWorkbenchRuntimeSseEvent =
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly cursor: string;
      readonly sequence: number;
      readonly occurredAt: string;
      readonly kind: "status";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
    }
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly cursor: string;
      readonly sequence: number;
      readonly occurredAt: string;
      readonly kind: "runtime-event";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      // An adapter event kind, or one of the SSE-only gateway facts (#3873 review).
      readonly eventKind: CodingWorkbenchRuntimeEventKind | CodingWorkbenchGatewayEventKind;
      readonly failureCode?:
        CodingWorkbenchRuntimeFailureCode | CodingWorkbenchTurnFailureCode | undefined;
      /**
       * The normalized #2387 outcome for a research-performed / skill-invoked / child-run-* frame.
       * `limit-reached` and `stopped` stay distinct from `denied` so the timeline never mislabels an
       * exhausted budget or a cascaded stop as a failure. Absent for every other event kind.
       */
      readonly auxiliaryOutcome?: CodingWorkbenchAuxiliaryStatus | undefined;
      /**
       * #2637: present as `untrusted` on an accepted `research-performed` frame, so the timeline can
       * tell the operator that the page text the run just took in is quarantined third-party data.
       * A constant marker — it names the channel's trust, never a byte of the page. Absent on every
       * other frame.
       */
      readonly contentTrust?: CodingWorkbenchContentTrust | undefined;
      /** Optional measured check metadata on verification-summarized events only. */
      readonly verificationSummary?: CodingWorkbenchVerificationSummary | undefined;
      /** Required only on native-retry-changed; null reports the native producer's clear. */
      readonly nativeRetry?: CodingWorkbenchNativeRetry | null | undefined;
    };

function checkStartRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeStartRequest {
  const request = validateRequestId(value.requestId, errors);
  const intent = validateTaskIntent(value.taskIntent, errors);
  const conversation =
    value.conversationId === undefined ||
    validateSafeId(value.conversationId, "conversationId", errors, 128);
  const mode = isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!mode) errors.push("requestedMode is invalid");
  const preference = validateRuntimePreference(value.runtimePreference, errors);
  const model = validateRuntimeModelId(value.modelId, errors);
  const reasoning = validateReasoningEffort(value.reasoningEffort, errors);
  const issue = validateIssueRef(value.issueRef, errors);
  const purpose = validateIssuePurpose(value.issuePurpose, value.issueRef, errors);
  const memory = validateProjectMemoryRequest(value.projectMemory, errors);
  const digest = validateExpectedIssueDigest(value, errors);
  return [
    request,
    intent,
    conversation,
    mode,
    preference,
    model,
    reasoning,
    issue,
    purpose,
    memory,
    digest,
  ].every(Boolean);
}

function validateExpectedIssueDigest(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.expectedIssueBindingDigest === undefined) return true;
  if (value.issueRef === undefined || typeof value.expectedIssueBindingDigest !== "string") {
    errors.push("expectedIssueBindingDigest requires an issue reference and sha256 digest");
    return false;
  }
  const digest: unknown = value.expectedIssueBindingDigest;
  const admitted = typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest);
  if (!admitted)
    errors.push("expectedIssueBindingDigest requires an issue reference and sha256 digest");
  return admitted;
}

function checkReadinessRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeReadinessRequest {
  const admitted = isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!admitted) errors.push("requestedMode is invalid");
  return admitted;
}

function checkResumeRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeResumeRequest {
  const request = validateRequestId(value.requestId, errors);
  const mode =
    value.requestedMode === undefined || isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!mode) errors.push("requestedMode is invalid");
  return request && mode;
}

function validateExpectedRevision(value: Record<string, unknown>, errors: string[]): boolean {
  if (!Number.isSafeInteger(value.expectedRevision)) {
    errors.push("expectedRevision must be a non-negative safe integer");
    return false;
  }
  const revision: unknown = value.expectedRevision;
  const admitted = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  if (!admitted) errors.push("expectedRevision must be a non-negative safe integer");
  return admitted;
}

function checkResearchRevokeRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeResearchRevokeRequest {
  const request = validateRequestId(value.requestId, errors);
  const revision = validateExpectedRevision(value, errors);
  const grant = validateSafeId(
    value.grantId,
    "grantId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  return request && revision && grant;
}

function checkRecoveryAcknowledgementRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeRecoveryAcknowledgementRequest {
  const request = validateRequestId(value.requestId, errors);
  const acknowledged = value.acknowledged === true;
  if (!acknowledged) errors.push("acknowledged must be true");
  return request && acknowledged;
}

function checkRequestIdOnly(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeStopRequest {
  return validateRequestId(value.requestId, errors);
}

function validateTaskIntent(value: unknown, errors: string[]): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 65_536) {
    errors.push("taskIntent must be a bounded non-empty string");
    return false;
  }
  return true;
}
function validateRuntimePreference(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimePreference | undefined {
  if (value !== undefined && !isOneOf(value, CODING_WORKBENCH_RUNTIME_PREFERENCES)) {
    errors.push("runtimePreference is invalid");
    return false;
  }
  return true;
}
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function validateRuntimeModelId(value: unknown, errors: string[]): value is string | undefined {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS ||
    containsControlCharacter(value)
  ) {
    errors.push("modelId must be bounded safe text");
    return false;
  }
  return true;
}
function validateReasoningEffort(
  value: unknown,
  errors: string[],
): value is ModelReasoningEffort | undefined {
  if (value !== undefined && !isOneOf(value, MODEL_REASONING_EFFORTS)) {
    errors.push("reasoningEffort is invalid");
    return false;
  }
  return true;
}
// Transport shape only: one bounded, control-character-free string, sharing the parser's own
// length bound so a reference the contract admits is never one the parser refuses for size. What
// the text MEANS is decided by the server-side resolver against the active repository.
function validateIssueRef(value: unknown, errors: string[]): value is string | undefined {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > GITHUB_ISSUE_REFERENCE_MAX_CHARS ||
    containsControlCharacter(value)
  ) {
    errors.push("issueRef must be bounded safe text");
    return false;
  }
  return true;
}
function validateIssuePurpose(
  value: unknown,
  issueRef: unknown,
  errors: string[],
): value is "context" | "delivery" | undefined {
  if (value === undefined) return true;
  if (issueRef === undefined || (value !== "context" && value !== "delivery")) {
    errors.push("issuePurpose requires an issue reference and a supported purpose");
    return false;
  }
  return true;
}
function validateProjectMemoryRequest(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeProjectMemoryRequest | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("projectMemory must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["enabled"], "projectMemory"));
  const enabled = typeof value.enabled === "boolean";
  if (!enabled) errors.push("projectMemory.enabled must be boolean");
  return enabled;
}
export function parseCodingWorkbenchRuntimeStartRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStartRequest> {
  if (!isRecord(value)) return invalid("start request must be an object");
  const errors = exactKeys(
    value,
    [
      "requestId",
      "taskIntent",
      "conversationId",
      "requestedMode",
      "runtimePreference",
      "modelId",
      "reasoningEffort",
      "issueRef",
      "expectedIssueBindingDigest",
      "issuePurpose",
      "projectMemory",
    ],
    "startRequest",
  );
  const admitted = checkStartRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

// A retry uses the identical request shape as the initial start; the distinct name documents the
// retry call site's intent to readers without duplicating the validation logic.
export function parseCodingWorkbenchRuntimeRetryRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStartRequest> {
  return parseCodingWorkbenchRuntimeStartRequest(value);
}

export function parseCodingWorkbenchRuntimeReadinessRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeReadinessRequest> {
  if (!isRecord(value)) return invalid("runtime readiness request must be an object");
  const errors = exactKeys(value, ["requestedMode"], "runtimeReadinessRequest");
  const admitted = checkReadinessRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeStopRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStopRequest> {
  return parseRequestIdOnly(value, "stopRequest");
}

export function parseCodingWorkbenchRuntimeResumeRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResumeRequest> {
  if (!isRecord(value)) return invalid("runtime resume request must be an object");
  const errors = exactKeys(value, ["requestId", "requestedMode"], "runtimeResume");
  const admitted = checkResumeRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeTakeoverRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeTakeoverRequest> {
  return parseRequestIdOnly(value, "takeoverRequest");
}

export function parseCodingWorkbenchRuntimeApprovalDecisionRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeApprovalDecisionRequest> {
  if (!isRecord(value)) return invalid("approval decision must be an object");
  const errors = exactKeys(
    value,
    [
      "requestId",
      "expectedRevision",
      "decision",
      "grantScope",
      "commandTemplateId",
      "safeArgumentClasses",
    ],
    "approvalDecision",
  );
  const admitted = checkApprovalRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkApprovalRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeApprovalDecisionRequest {
  const request = validateRequestId(value.requestId, errors);
  const revision = validateExpectedRevision(value, errors);
  const decision = isOneOf(value.decision, CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS);
  if (!decision) errors.push("decision is invalid");
  const grants = validateApprovalGrantFields(value, errors);
  return request && revision && decision && grants;
}

function validateApprovalGrantFields(value: Record<string, unknown>, errors: string[]): boolean {
  const scope =
    value.grantScope === undefined || value.grantScope === "once" || value.grantScope === "task";
  if (!scope) errors.push("grantScope is invalid");
  const command =
    value.commandTemplateId === undefined ||
    validateSafeId(
      value.commandTemplateId,
      "commandTemplateId",
      errors,
      CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    );
  const args = validateSafeArgumentClasses(value.safeArgumentClasses, errors);
  if (
    value.decision !== "approved" &&
    (value.grantScope !== undefined ||
      value.commandTemplateId !== undefined ||
      value.safeArgumentClasses !== undefined)
  )
    errors.push("denied decisions cannot carry grant fields");
  return [scope, command, args].every(Boolean);
}
function validateSafeArgumentClasses(
  value: unknown,
  errors: string[],
): value is readonly string[] | undefined {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push("safeArgumentClasses must be an array");
    return value === undefined;
  }
  if (value.length > 16) {
    errors.push("safeArgumentClasses exceeds 16 entries");
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = value[index];
    const valid = validateSafeId(
      entry,
      `safeArgumentClasses[${String(index)}]`,
      errors,
      CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    );
    if (!(index in value)) return false;
    admitted = valid && admitted;
  }
  return admitted;
}
export function parseCodingWorkbenchRuntimeResearchRevokeRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchRevokeRequest> {
  if (!isRecord(value)) return invalid("research revoke request must be an object");
  const errors = exactKeys(value, ["requestId", "expectedRevision", "grantId"], "researchRevoke");
  const admitted = checkResearchRevokeRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeRecoveryAcknowledgementRequest> {
  if (!isRecord(value)) return invalid("recovery acknowledgement must be an object");
  const errors = exactKeys(value, ["requestId", "acknowledged"], "recoveryAcknowledgement");
  const admitted = checkRecoveryAcknowledgementRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function validateCodingWorkbenchRuntimeSnapshot(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSnapshot> {
  if (!isRecord(value)) return invalid("runtime snapshot must be an object");
  const errors = exactKeys(
    value,
    [
      "schemaVersion",
      "state",
      "revision",
      "updatedAt",
      "runId",
      "requestedMode",
      "effectiveMode",
      "runtimeSource",
      "modelSource",
      "failureCode",
      "contextUsage",
      "recoveryAcknowledged",
      "pendingPermission",
      "pauseReason",
      "result",
      "issueBinding",
      "verifiedCommitResult",
      "draftDelivery",
      "ciReadiness",
      "descriptionStatus",
      "conversationId",
    ],
    "runtimeSnapshot",
  );
  const admitted = checkSnapshot(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkSnapshot(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeSnapshot {
  const fields = validateSnapshotFields(value, errors);
  const conversation =
    value.conversationId === undefined ||
    validateSafeId(value.conversationId, "conversationId", errors, 128);
  const context = validateContextUsage(value.contextUsage, errors);
  const issue = validateIssueBinding(value.issueBinding, errors);
  const verified = validateSnapshotVerifiedCommit(value, errors);
  const delivery = validateSnapshotDraftDelivery(value, errors);
  const ci = validateSnapshotCiReadiness(value, errors);
  const description = validateSnapshotDescriptionStatus(value, errors);
  const outcome = validateRuntimeResult(value.result, errors);
  if (
    value.result !== undefined &&
    !["succeeded", "failed", "cancelled", "taken-over"].includes(String(value.state))
  )
    errors.push("result is permitted only on a terminal snapshot");
  return [fields, conversation, context, issue, verified, delivery, ci, description, outcome].every(
    Boolean,
  );
}

function validateContextUsage(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchContextUsage | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage must be an object");
    return false;
  }
  if (value.state === "unavailable") {
    errors.push(...exactKeys(value, ["state", "updatedAt"], "contextUsage"));
    return validateStrictUtcInstant(value.updatedAt, "contextUsage.updatedAt", errors);
  }
  return validateAvailableContextUsage(value, errors);
}
function validateAvailableContextUsage(value: Record<string, unknown>, errors: string[]): boolean {
  errors.push(
    ...exactKeys(
      value,
      [
        "state",
        "source",
        "capacityTokens",
        "usedInputTokens",
        "reservedOutputTokens",
        "freeTokens",
        "breakdown",
        "cumulativePromptTokens",
        "runPromptBudgetTokens",
        "compaction",
        "updatedAt",
      ],
      "contextUsage",
    ),
  );
  const state = value.state === "available";
  if (!state) errors.push("contextUsage.state is invalid");
  const source = value.source === "estimated" || value.source === "provider-reported";
  if (!source) errors.push("contextUsage.source is invalid");
  const counts = validateContextCounts(value, errors);
  const breakdownValue: unknown = value.breakdown;
  const used: unknown = value.usedInputTokens;
  const usedNumber = Number(used);
  const breakdown = validateContextBreakdown(breakdownValue, usedNumber, errors);
  const usedCount = validateObservedContextCount(used, "usedInputTokens", errors);
  const compaction = validateContextCompaction(value.compaction, errors);
  const updated = validateStrictUtcInstant(value.updatedAt, "contextUsage.updatedAt", errors);
  return [state, source, counts, breakdown, usedCount, compaction, updated].every(Boolean);
}

function validateContextCounts(value: Record<string, unknown>, errors: string[]): boolean {
  const fields = [
    "capacityTokens",
    "usedInputTokens",
    "reservedOutputTokens",
    "freeTokens",
    "cumulativePromptTokens",
  ] as const;
  let admitted = true;
  for (const field of fields) {
    const count = validBoundedCount(value[field], Number.MAX_SAFE_INTEGER);
    if (!count) {
      errors.push(`contextUsage.${field} is invalid`);
    }
    admitted = count && admitted;
  }
  const geometryCounts = validateGeometryCounts(value, fields, errors);
  const arithmetic = !geometryCounts || validateContextArithmetic(value, errors);
  const budget = validateRunPromptBudget(value, errors);
  return admitted && geometryCounts && arithmetic && budget;
}

function validateGeometryCounts(
  value: Record<string, unknown>,
  fields: readonly string[],
  errors: string[],
): boolean {
  for (const field of fields) {
    if (!validBoundedCount(value[field], Number.MAX_SAFE_INTEGER)) {
      const diagnostic = `contextUsage.${field} is invalid`;
      if (!errors.includes(diagnostic)) errors.push(diagnostic);
      return false;
    }
  }
  return true;
}

function validateContextArithmetic(value: Record<string, unknown>, errors: string[]): boolean {
  const capacity: unknown = value.capacityTokens;
  const capacityNumber = Number(capacity);
  const used: unknown = value.usedInputTokens;
  const usedNumber = Number(used);
  const reserved: unknown = value.reservedOutputTokens;
  const reservedNumber = Number(reserved);
  const free: unknown = value.freeTokens;
  const freeNumber = Number(free);
  if (capacityNumber !== usedNumber + reservedNumber + freeNumber) {
    errors.push("contextUsage token geometry is inconsistent");
  }
  const operands: readonly (readonly [string, unknown])[] = [
    ["capacityTokens", capacity],
    ["usedInputTokens", used],
    ["reservedOutputTokens", reserved],
    ["freeTokens", free],
  ];
  let admitted = true;
  for (const [field, observed] of operands) {
    const valid = validBoundedCount(observed, Number.MAX_SAFE_INTEGER);
    if (!valid) {
      const diagnostic = `contextUsage.${field} is invalid`;
      if (!errors.includes(diagnostic)) errors.push(diagnostic);
    }
    admitted = valid && admitted;
  }
  return admitted;
}

function validateRunPromptBudget(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.runPromptBudgetTokens === undefined) return true;
  if (!validBoundedCount(value.runPromptBudgetTokens, Number.MAX_SAFE_INTEGER)) {
    errors.push("contextUsage.runPromptBudgetTokens is invalid");
    return false;
  }
  const budget: unknown = value.runPromptBudgetTokens;
  const budgetNumber = Number(budget);
  const cumulative: unknown = value.cumulativePromptTokens;
  const cumulativeNumber = Number(cumulative);
  const exceedsBudget = budgetNumber < cumulativeNumber;
  const admitted = validBoundedCount(budget, Number.MAX_SAFE_INTEGER) && !exceedsBudget;
  if (!admitted) errors.push("contextUsage.runPromptBudgetTokens is invalid");
  const cumulativeCount = validateObservedContextCount(
    cumulative,
    "cumulativePromptTokens",
    errors,
  );
  return admitted && cumulativeCount;
}

function validateObservedContextCount(value: unknown, field: string, errors: string[]): boolean {
  const admitted = validBoundedCount(value, Number.MAX_SAFE_INTEGER);
  if (!admitted) {
    const diagnostic = `contextUsage.${field} is invalid`;
    if (!errors.includes(diagnostic)) errors.push(diagnostic);
  }
  return admitted;
}

function validateContextBreakdown(
  value: unknown,
  usedTokens: number,
  errors: string[],
): value is CodingWorkbenchContextUsageBreakdown | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage.breakdown must be an object");
    return false;
  }
  const fields = [
    "conversationMessagesTokens",
    "systemContextTokens",
    "toolDefinitionTokens",
    "providerAccountingAdjustmentTokens",
  ] as const;
  errors.push(...exactKeys(value, fields, "contextUsage.breakdown"));
  const reported: unknown[] = fields.flatMap((field) =>
    value[field] === undefined ? [] : [value[field]],
  );
  const admitted = reported.every((count) => validBoundedCount(count, Number.MAX_SAFE_INTEGER));
  if (!admitted) {
    errors.push("contextUsage.breakdown contains an invalid count");
  } else if (reported.reduce<number>((sum, count) => sum + count, 0) > usedTokens) {
    errors.push("contextUsage.breakdown exceeds usedInputTokens");
  }
  return admitted;
}
function validateContextCompaction(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchContextCompaction | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage.compaction must be an object");
    return false;
  }
  errors.push(
    ...exactKeys(value, ["count", "lastCompactedAt", "thresholdTokens"], "contextUsage.compaction"),
  );
  const count = validBoundedCount(value.count, Number.MAX_SAFE_INTEGER);
  if (!count) errors.push("contextUsage.compaction.count is invalid");
  const compacted =
    value.lastCompactedAt === undefined ||
    validateStrictUtcInstant(
      value.lastCompactedAt,
      "contextUsage.compaction.lastCompactedAt",
      errors,
    );
  const threshold =
    value.thresholdTokens === undefined ||
    validBoundedCount(value.thresholdTokens, Number.MAX_SAFE_INTEGER);
  if (!threshold) errors.push("contextUsage.compaction.thresholdTokens is invalid");
  return count && compacted && threshold;
}
function validateIssueBinding(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchIssueBinding | undefined {
  if (value === undefined) return true;
  const validated = validateCodingWorkbenchIssueBinding(value);
  if (!validated.ok) errors.push(...validated.errors);
  return validated.ok;
}
function validateSnapshotVerifiedCommit(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const receipt = snapshot.verifiedCommitResult;
  if (receipt === undefined) return true;
  if (!isVerifiedCommitResult(receipt)) {
    errors.push("verifiedCommitResult must be a closed verified commit receipt");
    return false;
  }
  const issue = snapshot.issueBinding;
  const issueDigest = isRecord(issue) ? issue.bindingDigest : undefined;
  if (receipt.runId !== snapshot.runId || receipt.issueBindingDigest !== issueDigest) {
    errors.push("verifiedCommitResult must match the snapshot run and issue binding");
  }
  return true;
}
function validateSnapshotDraftDelivery(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const delivery = snapshot.draftDelivery;
  if (delivery === undefined) return true;
  if (!isDraftDeliveryRecord(delivery)) {
    errors.push("draftDelivery must be a closed durable delivery record");
    return false;
  }
  const issue = snapshot.issueBinding;
  const target = delivery.binding;
  if (
    !isRecord(issue) ||
    ![
      target.runId === snapshot.runId,
      target.issueBindingDigest === issue.bindingDigest,
      target.remoteDigest === issue.remoteDigest,
      target.issueIdDigest === issue.issueIdDigest,
      target.issueNumber === issue.issueNumber,
      target.baseRef === issue.defaultBaseRef,
    ].every(Boolean)
  ) {
    errors.push("draftDelivery must match the snapshot run and frozen issue binding");
  }
  return true;
}
function validateSnapshotCiReadiness(snapshot: Record<string, unknown>, errors: string[]): boolean {
  const readiness = snapshot.ciReadiness;
  if (readiness === undefined) return true;
  const draft = snapshot.draftDelivery;
  if (!isReadinessSnapshot(readiness) || !isDraftDeliveryRecord(draft)) {
    errors.push("ciReadiness must be a closed observation of a confirmed delivery");
    return false;
  }
  if (
    ![
      readiness.runId === snapshot.runId,
      readiness.remoteDigest === draft.binding.remoteDigest,
      readiness.repository.toLowerCase() === draft.binding.repository.toLowerCase(),
      readiness.prNumber === draft.pullRequest?.number,
      readiness.headRef === draft.binding.headRef,
      readiness.headSha === draft.binding.headSha,
      readiness.baseRef === draft.binding.baseRef,
    ].every(Boolean)
  )
    errors.push("ciReadiness must match the snapshot run and confirmed delivery target");
  return true;
}
// The status can outlive the LATEST `verifiedCommitResult` shown on the snapshot (that field
// reflects the most recent proposal attempt, which may be a later failed/blocked one, while the
// description job binds the last SUCCESSFUL head — codingRuntimeVerifiedCommitAuthorityStore.ts /
// epic #3384 correction 5), so only the run identity is cross-checked here.
function validateSnapshotDescriptionStatus(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const status = snapshot.descriptionStatus;
  if (status === undefined) return true;
  if (!isWorkbenchDescriptionStatus(status)) {
    errors.push("descriptionStatus must be a closed durable description status");
    return false;
  }
  if (status.runId !== snapshot.runId) {
    errors.push("descriptionStatus must match the snapshot run");
  }
  return true;
}
function validateRuntimeResult(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeResult | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["status", "exitCode", "output", "error"], "result"));
  const status = isOneOf(value.status, ["cancelled", "failed", "signalled", "succeeded"]);
  if (!status) errors.push("result.status is invalid");
  const exit = validateResultExitCode(value, errors);
  const output = validateProcessSummary(value.output, "result.output", errors);
  const error = validateProcessSummary(value.error, "result.error", errors);
  return status && exit && output && error;
}
function validateResultExitCode(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.exitCode === null) return true;
  if (!Number.isSafeInteger(value.exitCode)) {
    errors.push("result.exitCode is invalid");
    return false;
  }
  const lower: unknown = value.exitCode;
  if (typeof lower !== "number" || !Number.isSafeInteger(lower) || lower < 0) {
    errors.push("result.exitCode is invalid");
    return false;
  }
  const upper: unknown = value.exitCode;
  const admitted = validBoundedCount(upper, 255);
  if (!admitted) errors.push("result.exitCode is invalid");
  return admitted;
}

function validateProcessSummary(
  value: unknown,
  path: string,
  errors: string[],
): value is CodingWorkbenchRuntimeProcessSummary {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["byteCount", "lineCount", "sha256", "truncated"], path));
  const bytes = validBoundedCount(value.byteCount, 1_073_741_824);
  if (!bytes) errors.push(`${path}.byteCount is invalid`);
  const lines = validBoundedCount(value.lineCount, 1_000_000);
  if (!lines) errors.push(`${path}.lineCount is invalid`);
  const digest = validProcessSummaryDigest(value);
  if (!digest) errors.push(`${path}.sha256 is invalid`);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated is invalid`);
  return bytes && lines && digest && truncated;
}
function validProcessSummaryDigest(value: Record<string, unknown>): boolean {
  if (typeof value.sha256 !== "string") return false;
  const digest: unknown = value.sha256;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest);
}

function validBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
// A status read validates the identical snapshot shape; the distinct name documents the read call
// site's intent to readers without duplicating the validation logic.
export function validateCodingWorkbenchRuntimeStatus(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSnapshot> {
  return validateCodingWorkbenchRuntimeSnapshot(value);
}

export function validateCodingWorkbenchRuntimeReadiness(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeReadiness> {
  if (!isRecord(value)) return invalid("runtime readiness must be an object");
  const errors = exactKeys(
    value,
    [
      "schemaVersion",
      "requestedMode",
      "deploymentCeiling",
      "effectiveMode",
      "runtimeAvailable",
      "runtimeUnavailableReason",
      "runtimeEvidenceClass",
    ],
    "runtimeReadiness",
  );
  const admitted = checkRuntimeReadiness(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkRuntimeReadiness(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeReadiness {
  const version = value.schemaVersion === CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  if (!version) {
    errors.push("schemaVersion is invalid");
  }
  let modes = true;
  for (const field of ["requestedMode", "deploymentCeiling", "effectiveMode"] as const) {
    const valid = isOneOf(value[field], CODING_WORKBENCH_MODES);
    if (!valid) errors.push(`${field} is invalid`);
    modes = valid && modes;
  }
  const reason = validateRuntimeUnavailableReason(value, errors);
  const evidence = validateRuntimeEvidenceClass(value, errors);
  // The server may confirm a NARROWER effective mode than the plain request/ceiling clamp (the
  // #2386 mode-change gate anchors it to the live run), but never a wider one: widening past the
  // clamp is the fail-closed contract boundary.
  if (
    isOneOf(value.requestedMode, CODING_WORKBENCH_MODES) &&
    isOneOf(value.deploymentCeiling, CODING_WORKBENCH_MODES) &&
    isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) &&
    isCodingWorkbenchModeWidening(
      resolveEffectiveCodingWorkbenchMode(value.requestedMode, value.deploymentCeiling),
      value.effectiveMode,
    )
  ) {
    errors.push("effectiveMode must not widen past requestedMode and deploymentCeiling");
  }
  const available = typeof value.runtimeAvailable === "boolean";
  if (!available) errors.push("runtimeAvailable is invalid");
  return [version, modes, reason, evidence, available].every(Boolean);
}

/**
 * The unavailable reason is bound to the availability boolean in both directions: an available
 * runtime must not carry a reason, and an unavailable runtime must name one — a bare `false`
 * would reintroduce the unexplained-unavailability posture this field exists to end.
 */
function validateRuntimeUnavailableReason(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  const reason = value.runtimeUnavailableReason;
  if (reason !== undefined && !isOneOf(reason, CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS)) {
    errors.push("runtimeUnavailableReason is invalid");
    return false;
  }
  if (value.runtimeAvailable === true && reason !== undefined) {
    errors.push("runtimeUnavailableReason must be absent when the runtime is available");
  }
  if (value.runtimeAvailable === false && reason === undefined) {
    errors.push("runtimeUnavailableReason is required when the runtime is unavailable");
  }
  return true;
}
/**
 * The exact mirror of the unavailable reason, bound to the AVAILABLE branch. Requiring it there is
 * the load-bearing half: an optional field whose absence reads as "verified" would let an
 * unverified runtime render as plain green.
 */
function validateRuntimeEvidenceClass(value: Record<string, unknown>, errors: string[]): boolean {
  const evidenceClass = value.runtimeEvidenceClass;
  if (
    evidenceClass !== undefined &&
    !isOneOf(evidenceClass, CODING_WORKBENCH_RUNTIME_EVIDENCE_CLASSES)
  ) {
    errors.push("runtimeEvidenceClass is invalid");
    return false;
  }
  if (value.runtimeAvailable === true && evidenceClass === undefined) {
    errors.push("runtimeEvidenceClass is required when the runtime is available");
  }
  if (value.runtimeAvailable === false && evidenceClass !== undefined) {
    errors.push("runtimeEvidenceClass must be absent when the runtime is unavailable");
  }
  return true;
}
export function validateCodingWorkbenchRuntimeSseEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSseEvent> {
  if (!isRecord(value)) return invalid("runtime SSE event must be an object");
  const errors = exactKeys(value, sseEventKeys(value.kind), "runtimeSseEvent");
  const admitted = checkSseEvent(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkSseEvent(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeSseEvent {
  return validateSseEventFields(
    value,
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  );
}

function parseRequestIdOnly(
  value: unknown,
  path: string,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStopRequest> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);
  const errors = exactKeys(value, ["requestId"], path);
  const admitted = checkRequestIdOnly(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
function validateSnapshotFields(value: Record<string, unknown>, errors: string[]): boolean {
  const version = value.schemaVersion === CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  if (!version) errors.push("schemaVersion is invalid");
  const state = isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES);
  if (!state) errors.push("state is invalid");
  const revision = validateSnapshotRevision(value, errors);
  const updated = validateStrictUtcInstant(value.updatedAt, "updatedAt", errors);
  const optional = validateOptionalSnapshotFields(value, errors);
  const failure = validateFailureCode(value.failureCode, errors);
  const recovery = validateRecoveryAcknowledgement(value, errors);
  const pending = validatePendingPermission(value, errors);
  const pause = validatePauseReason(value, errors);
  return [version, state, revision, updated, optional, failure, recovery, pending, pause].every(
    Boolean,
  );
}

function validateSnapshotRevision(value: Record<string, unknown>, errors: string[]): boolean {
  if (!Number.isSafeInteger(value.revision)) {
    errors.push("revision must be a non-negative safe integer");
    return false;
  }
  const revision: unknown = value.revision;
  const admitted = validBoundedCount(revision, Number.MAX_SAFE_INTEGER);
  if (!admitted) errors.push("revision must be a non-negative safe integer");
  return admitted;
}

// A pause reason outside `paused` would describe a state the run is not in. The converse is
// deliberately permitted: an operator-initiated pause carries no reason, which is what `paused`
// meant before a governed tool could ask for a decision.
function validatePauseReason(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.pauseReason === undefined) return true;
  if (!isOneOf(value.pauseReason, CODING_WORKBENCH_OPERATOR_DECISIONS)) {
    errors.push("pauseReason is invalid");
    return false;
  }
  if (value.state !== "paused") errors.push("pauseReason is only allowed when state is paused");
  return true;
}
function validateRecoveryAcknowledgement(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  if (value.recoveryAcknowledged === undefined) return true;
  const acknowledged = value.recoveryAcknowledged === true;
  if (!acknowledged) errors.push("recoveryAcknowledged must be true");
  if (value.state !== "recovery-required")
    errors.push("recoveryAcknowledged is only allowed when state is recovery-required");
  return acknowledged;
}
function validateOptionalSnapshotFields(value: Record<string, unknown>, errors: string[]): boolean {
  const run =
    value.runId === undefined ||
    validateSafeId(value.runId, "runId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
  const requested = validateOptionalEnum(
    value.requestedMode,
    CODING_WORKBENCH_MODES,
    "requestedMode",
    errors,
  );
  const effective = validateOptionalEnum(
    value.effectiveMode,
    CODING_WORKBENCH_MODES,
    "effectiveMode",
    errors,
  );
  validateSnapshotModeRelationship(value, errors);
  const runtime = validateOptionalEnum(
    value.runtimeSource,
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "runtimeSource",
    errors,
  );
  const model = validateOptionalEnum(
    value.modelSource,
    CODING_WORKBENCH_MODEL_SOURCES,
    "modelSource",
    errors,
  );
  return run && requested && effective && runtime && model;
}
function validateSnapshotModeRelationship(value: Record<string, unknown>, errors: string[]): void {
  const requested = value.requestedMode;
  const effective = value.effectiveMode;
  if (effective === undefined) return;
  if (!isOneOf(requested, CODING_WORKBENCH_MODES)) {
    errors.push("requestedMode is required when effectiveMode is present");
    return;
  }
  if (
    isOneOf(effective, CODING_WORKBENCH_MODES) &&
    isCodingWorkbenchModeWidening(requested, effective)
  ) {
    errors.push("effectiveMode must not widen past requestedMode");
  }
}

function validateOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): value is T | undefined {
  if (value !== undefined && !isOneOf(value, allowed)) {
    errors.push(`${path} is invalid`);
    return false;
  }
  return true;
}
function validatePendingPermission(value: Record<string, unknown>, errors: string[]): boolean {
  const awaitingApproval = value.state === "awaiting-approval";
  if (awaitingApproval && value.pendingPermission === undefined) {
    errors.push("pendingPermission is required when state is awaiting-approval");
    return false;
  }
  if (!awaitingApproval && value.pendingPermission !== undefined) {
    errors.push("pendingPermission is only allowed when state is awaiting-approval");
    return false;
  }
  if (value.pendingPermission === undefined) return true;
  const validation = validateCodingWorkbenchPermissionRequest(value.pendingPermission);
  if (!validation.ok)
    errors.push(...validation.errors.map((error) => `pendingPermission.${error}`));
  return validation.ok;
}
function validateFailureCode(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeFailureCode | undefined {
  if (value !== undefined && !isOneOf(value, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)) {
    errors.push("failureCode is invalid");
    return false;
  }
  return true;
}
function validateRequestId(value: unknown, errors: string[]): value is string {
  return validateSafeId(value, "requestId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
}
