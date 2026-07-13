import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { validateCodingWorkbenchPermissionRequest } from "./coding-workbench-validation.js";
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
      "pendingPermission",
    ],
    "runtimeSnapshot",
  );
  validateSnapshotFields(value, errors);
  return result(value, errors);
}

export const validateCodingWorkbenchRuntimeStatus = validateCodingWorkbenchRuntimeSnapshot;

export function validateCodingWorkbenchRuntimeSseEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSseEvent> {
  if (!isRecord(value)) return invalid("runtime SSE event must be an object");
  const errors = exactKeys(value, sseEventKeys(value.kind), "runtimeSseEvent");
  validateSseEventFields(value, errors);
  return result(value, errors);
}

function sseEventKeys(kind: unknown): readonly string[] {
  const common = [
    "schemaVersion",
    "cursor",
    "sequence",
    "occurredAt",
    "kind",
    "runId",
    "state",
    "revision",
    "failureCode",
  ];
  return kind === "runtime-event" ? [...common, "eventKind"] : common;
}

function validateSseEventFields(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  validateSafeId(value.cursor, "cursor", errors);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) {
    errors.push("sequence must be a non-negative safe integer");
  }
  validateStrictUtcInstant(value.occurredAt, "occurredAt", errors);
  if (!isOneOf(value.kind, CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS))
    errors.push("kind is invalid");
  validateSafeId(value.runId, "runId", errors);
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) errors.push("state is invalid");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    errors.push("revision must be a non-negative safe integer");
  }
  if (value.kind === "runtime-event") {
    if (!isOneOf(value.eventKind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) {
      errors.push("eventKind is invalid");
    }
  }
  validateFailureCode(value.failureCode, errors);
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
  validatePendingPermission(value, errors);
}

function validateOptionalSnapshotFields(value: Record<string, unknown>, errors: string[]): void {
  if (value.runId !== undefined) validateSafeId(value.runId, "runId", errors);
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
  validateSafeId(value, "requestId", errors);
}

function validateSafeId(value: unknown, path: string, errors: string[]): void {
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  if (
    typeof value !== "string" ||
    value.length > CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS ||
    !safeId.test(value)
  ) {
    errors.push(`${path} must be a bounded safe identifier`);
  }
}

function validateStrictUtcInstant(value: unknown, path: string, errors: string[]): void {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const normalized =
    typeof value === "string" && !value.includes(".") ? `${value.slice(0, -1)}.000Z` : value;
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== normalized
  ) {
    errors.push(`${path} must be a strict UTC instant`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
}

function result<T>(value: unknown, errors: string[]): CodingWorkbenchValidationResult<T> {
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

function invalid<T>(error: string): CodingWorkbenchValidationResult<T> {
  return { ok: false, errors: [error] };
}
