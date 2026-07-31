import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuxiliaryStatus,
  type CodingWorkbenchContentTrust,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { validateCodingWorkbenchPermissionRequest } from "./coding-workbench-validation.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
  sseEventKeys,
  validateSafeId,
  validateSseEventFields,
  validateStrictUtcInstant,
} from "./coding-workbench-runtime-api-validation.js";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStateName,
} from "./coding-workbench-runtime.js";

/** Browser-level preference, deliberately not an adapter, model, profile, or endpoint selector. */
export type CodingWorkbenchRuntimePreference = "managed-gateway" | "codex-subscription";

export const CODING_WORKBENCH_RUNTIME_PREFERENCES: readonly CodingWorkbenchRuntimePreference[] =
  Object.freeze(["managed-gateway", "codex-subscription"] as const);

export const CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS = 128;
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

/** Content-free server authority and runtime-composition projection used before Start is enabled. */
export interface CodingWorkbenchRuntimeReadiness {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeAvailable: boolean;
  /** Present exactly when `runtimeAvailable` is false; names the first failed prerequisite. */
  readonly runtimeUnavailableReason?: CodingWorkbenchRuntimeUnavailableReason | undefined;
}

export interface CodingWorkbenchRuntimeStartRequest {
  readonly requestId: string;
  /** Transient model input; no response, snapshot, SSE projection, or evidence may retain it. */
  readonly taskIntent: string;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference?: CodingWorkbenchRuntimePreference | undefined;
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
  /** Present only when durable server truth records acknowledgement for a recovery-required run. */
  readonly recoveryAcknowledged?: true | undefined;
  /** Present exactly while the runtime is awaiting an operator decision. */
  readonly pendingPermission?: CodingWorkbenchRuntimePendingPermission | undefined;
  /** Terminal, body-free process outcome; never contains stdout or stderr content. */
  readonly result?: CodingWorkbenchRuntimeResult | undefined;
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
      readonly eventKind: CodingWorkbenchRuntimeEventKind;
      readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
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
    };

export function parseCodingWorkbenchRuntimeStartRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStartRequest> {
  if (!isRecord(value)) return invalid("start request must be an object");
  const errors = exactKeys(
    value,
    ["requestId", "taskIntent", "requestedMode", "runtimePreference"],
    "startRequest",
  );
  validateRequestId(value.requestId, errors);
  if (
    typeof value.taskIntent !== "string" ||
    value.taskIntent.length === 0 ||
    value.taskIntent.length > 65_536
  ) {
    errors.push("taskIntent must be a bounded non-empty string");
  }
  if (!isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    errors.push("requestedMode is invalid");
  }
  if (
    value.runtimePreference !== undefined &&
    !isOneOf(value.runtimePreference, CODING_WORKBENCH_RUNTIME_PREFERENCES)
  ) {
    errors.push("runtimePreference is invalid");
  }
  return result(value, errors);
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
  if (!isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    errors.push("requestedMode is invalid");
  }
  return result(value, errors);
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
  validateRequestId(value.requestId, errors);
  if (value.requestedMode !== undefined && !isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    errors.push("requestedMode is invalid");
  }
  return result(value, errors);
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
    ["requestId", "expectedRevision", "decision"],
    "approvalDecision",
  );
  validateRequestId(value.requestId, errors);
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    errors.push("expectedRevision must be a non-negative safe integer");
  }
  if (!isOneOf(value.decision, CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS)) {
    errors.push("decision is invalid");
  }
  return result(value, errors);
}

export function parseCodingWorkbenchRuntimeResearchRevokeRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchRevokeRequest> {
  if (!isRecord(value)) return invalid("research revoke request must be an object");
  const errors = exactKeys(value, ["requestId", "expectedRevision", "grantId"], "researchRevoke");
  validateRequestId(value.requestId, errors);
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    errors.push("expectedRevision must be a non-negative safe integer");
  }
  validateSafeId(value.grantId, "grantId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
  return result(value, errors);
}

export function parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeRecoveryAcknowledgementRequest> {
  if (!isRecord(value)) return invalid("recovery acknowledgement must be an object");
  const errors = exactKeys(value, ["requestId", "acknowledged"], "recoveryAcknowledgement");
  validateRequestId(value.requestId, errors);
  if (value.acknowledged !== true) errors.push("acknowledged must be true");
  return result(value, errors);
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
      "recoveryAcknowledged",
      "pendingPermission",
      "result",
    ],
    "runtimeSnapshot",
  );
  validateSnapshotFields(value, errors);
  validateRuntimeResult(value.result, errors);
  if (
    value.result !== undefined &&
    !["succeeded", "failed", "cancelled", "taken-over"].includes(String(value.state))
  ) {
    errors.push("result is permitted only on a terminal snapshot");
  }
  return result(value, errors);
}

function validateRuntimeResult(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push("result must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["status", "exitCode", "output", "error"], "result"));
  if (!["cancelled", "failed", "signalled", "succeeded"].includes(String(value.status))) {
    errors.push("result.status is invalid");
  }
  if (
    value.exitCode !== null &&
    (!Number.isSafeInteger(value.exitCode) ||
      Number(value.exitCode) < 0 ||
      Number(value.exitCode) > 255)
  ) {
    errors.push("result.exitCode is invalid");
  }
  validateProcessSummary(value.output, "result.output", errors);
  validateProcessSummary(value.error, "result.error", errors);
}

function validateProcessSummary(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["byteCount", "lineCount", "sha256", "truncated"], path));
  if (!validBoundedCount(value.byteCount, 1_073_741_824)) {
    errors.push(`${path}.byteCount is invalid`);
  }
  if (!validBoundedCount(value.lineCount, 1_000_000)) {
    errors.push(`${path}.lineCount is invalid`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    errors.push(`${path}.sha256 is invalid`);
  }
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated is invalid`);
}

function validBoundedCount(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
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
    ],
    "runtimeReadiness",
  );
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  for (const field of ["requestedMode", "deploymentCeiling", "effectiveMode"] as const) {
    if (!isOneOf(value[field], CODING_WORKBENCH_MODES)) errors.push(`${field} is invalid`);
  }
  validateRuntimeUnavailableReason(value, errors);
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
  if (typeof value.runtimeAvailable !== "boolean") errors.push("runtimeAvailable is invalid");
  return result(value, errors);
}

/**
 * The unavailable reason is bound to the availability boolean in both directions: an available
 * runtime must not carry a reason, and an unavailable runtime must name one — a bare `false`
 * would reintroduce the unexplained-unavailability posture this field exists to end.
 */
function validateRuntimeUnavailableReason(value: Record<string, unknown>, errors: string[]): void {
  const reason = value.runtimeUnavailableReason;
  if (reason !== undefined && !isOneOf(reason, CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS)) {
    errors.push("runtimeUnavailableReason is invalid");
    return;
  }
  if (value.runtimeAvailable === true && reason !== undefined) {
    errors.push("runtimeUnavailableReason must be absent when the runtime is available");
  }
  if (value.runtimeAvailable === false && reason === undefined) {
    errors.push("runtimeUnavailableReason is required when the runtime is unavailable");
  }
}

export function validateCodingWorkbenchRuntimeSseEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSseEvent> {
  if (!isRecord(value)) return invalid("runtime SSE event must be an object");
  const errors = exactKeys(value, sseEventKeys(value.kind), "runtimeSseEvent");
  validateSseEventFields(
    value,
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  );
  return result(value, errors);
}

function parseRequestIdOnly<T>(value: unknown, path: string): CodingWorkbenchValidationResult<T> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);
  const errors = exactKeys(value, ["requestId"], path);
  validateRequestId(value.requestId, errors);
  return result(value, errors);
}

function validateSnapshotFields(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) errors.push("state is invalid");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    errors.push("revision must be a non-negative safe integer");
  }
  validateStrictUtcInstant(value.updatedAt, "updatedAt", errors);
  validateOptionalSnapshotFields(value, errors);
  validateFailureCode(value.failureCode, errors);
  validateRecoveryAcknowledgement(value, errors);
  validatePendingPermission(value, errors);
}

function validateRecoveryAcknowledgement(value: Record<string, unknown>, errors: string[]): void {
  if (value.recoveryAcknowledged === undefined) return;
  if (value.recoveryAcknowledged !== true) errors.push("recoveryAcknowledged must be true");
  if (value.state !== "recovery-required") {
    errors.push("recoveryAcknowledged is only allowed when state is recovery-required");
  }
}

function validateOptionalSnapshotFields(value: Record<string, unknown>, errors: string[]): void {
  if (value.runId !== undefined) {
    validateSafeId(value.runId, "runId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
  }
  validateOptionalEnum(value.requestedMode, CODING_WORKBENCH_MODES, "requestedMode", errors);
  validateOptionalEnum(value.effectiveMode, CODING_WORKBENCH_MODES, "effectiveMode", errors);
  validateSnapshotModeRelationship(value, errors);
  validateOptionalEnum(
    value.runtimeSource,
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "runtimeSource",
    errors,
  );
  validateOptionalEnum(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES, "modelSource", errors);
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

function validateOptionalEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  if (value !== undefined && !isOneOf(value, allowed)) errors.push(`${path} is invalid`);
}

function validatePendingPermission(value: Record<string, unknown>, errors: string[]): void {
  const awaitingApproval = value.state === "awaiting-approval";
  if (awaitingApproval && value.pendingPermission === undefined) {
    errors.push("pendingPermission is required when state is awaiting-approval");
    return;
  }
  if (!awaitingApproval && value.pendingPermission !== undefined) {
    errors.push("pendingPermission is only allowed when state is awaiting-approval");
    return;
  }
  if (value.pendingPermission === undefined) return;

  const validation = validateCodingWorkbenchPermissionRequest(value.pendingPermission);
  if (!validation.ok) {
    errors.push(...validation.errors.map((error) => `pendingPermission.${error}`));
  }
}

function validateFailureCode(value: unknown, errors: string[]): void {
  if (value !== undefined && !isOneOf(value, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)) {
    errors.push("failureCode is invalid");
  }
}

function validateRequestId(value: unknown, errors: string[]): void {
  validateSafeId(value, "requestId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
}
