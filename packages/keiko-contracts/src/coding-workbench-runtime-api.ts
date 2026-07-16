import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
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

/** Content-free server authority and runtime-composition projection used before Start is enabled. */
export interface CodingWorkbenchRuntimeReadiness {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeAvailable: boolean;
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

export interface CodingWorkbenchRuntimeRecoveryAcknowledgementRequest {
  readonly requestId: string;
  readonly acknowledged: true;
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
  readonly requestedMode?: CodingWorkbenchMode | undefined;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  /** Present only when durable server truth records acknowledgement for a recovery-required run. */
  readonly recoveryAcknowledged?: true | undefined;
  /** Present exactly while the runtime is awaiting an operator decision. */
  readonly pendingPermission?: CodingWorkbenchRuntimePendingPermission | undefined;
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

export const parseCodingWorkbenchRuntimeRetryRequest = parseCodingWorkbenchRuntimeStartRequest;

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
      "runtimeSource",
      "modelSource",
      "failureCode",
      "recoveryAcknowledged",
      "pendingPermission",
    ],
    "runtimeSnapshot",
  );
  validateSnapshotFields(value, errors);
  return result(value, errors);
}

export const validateCodingWorkbenchRuntimeStatus = validateCodingWorkbenchRuntimeSnapshot;

export function validateCodingWorkbenchRuntimeReadiness(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeReadiness> {
  if (!isRecord(value)) return invalid("runtime readiness must be an object");
  const errors = exactKeys(
    value,
    ["schemaVersion", "requestedMode", "deploymentCeiling", "effectiveMode", "runtimeAvailable"],
    "runtimeReadiness",
  );
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  for (const field of ["requestedMode", "deploymentCeiling", "effectiveMode"] as const) {
    if (!isOneOf(value[field], CODING_WORKBENCH_MODES)) errors.push(`${field} is invalid`);
  }
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
  validateOptionalEnum(
    value.runtimeSource,
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "runtimeSource",
    errors,
  );
  validateOptionalEnum(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES, "modelSource", errors);
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
