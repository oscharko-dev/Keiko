import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
} from "./coding-workbench.js";
import { validateCodingWorkbenchAuthorityEnvelope } from "./coding-workbench-validation.js";

export const CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION = "1" as const;
export const CODING_WORKBENCH_TASK_INTENT_MAX_CHARS = 65_536;

export type CodingWorkbenchLifecycleCommand = "start" | "stop" | "takeover" | "recover";
export const CODING_WORKBENCH_LIFECYCLE_COMMANDS: readonly CodingWorkbenchLifecycleCommand[] =
  Object.freeze(["start", "stop", "takeover", "recover"] as const);

export type CodingWorkbenchRuntimeIntent =
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly requestId: string;
      readonly command: "start";
      /** Transient model input. It must never be copied into runtime state, events, or evidence. */
      readonly taskIntent: string;
      readonly requestedMode: CodingWorkbenchMode;
      readonly modelSource: CodingWorkbenchModelSource;
    }
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly requestId: string;
      readonly command: Exclude<CodingWorkbenchLifecycleCommand, "start">;
      readonly runId: string;
    };

export type CodingWorkbenchRuntimeStateName =
  | "unavailable"
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "awaiting-approval"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "taken-over"
  | "recovery-required";

export const CODING_WORKBENCH_RUNTIME_STATE_NAMES: readonly CodingWorkbenchRuntimeStateName[] =
  Object.freeze([
    "unavailable",
    "idle",
    "starting",
    "ready",
    "running",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
  ] as const);

export interface CodingWorkbenchRuntimeState {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
}

export type CodingWorkbenchRuntimeFailureCode =
  | "runtime-unavailable"
  | "active-run-conflict"
  | "invalid-intent"
  | "authority-resolution-failed"
  | "authority-expired"
  | "authority-replayed"
  | "task-drift"
  | "workspace-drift"
  | "project-drift"
  | "branch-drift"
  | "scope-drift"
  | "budget-drift"
  | "authority-budget-exceeded"
  | "source-drift"
  | "runtime-failed"
  | "revoked"
  | "recovery-required";

export const CODING_WORKBENCH_RUNTIME_FAILURE_CODES: readonly CodingWorkbenchRuntimeFailureCode[] =
  Object.freeze([
    "runtime-unavailable",
    "active-run-conflict",
    "invalid-intent",
    "authority-resolution-failed",
    "authority-expired",
    "authority-replayed",
    "task-drift",
    "workspace-drift",
    "project-drift",
    "branch-drift",
    "scope-drift",
    "budget-drift",
    "authority-budget-exceeded",
    "source-drift",
    "runtime-failed",
    "revoked",
    "recovery-required",
  ] as const);

export interface CodingWorkbenchRuntimeExecutionBinding {
  readonly taskId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly branchRef: string;
  readonly branchHeadDigest: string;
}

export interface CodingWorkbenchRuntimeAuthorityEnvelope {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly authority: CodingWorkbenchAuthorityEnvelope;
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly intentDigest: string;
  readonly nonceDigest: string;
  readonly issuedAt: string;
}

export interface CodingWorkbenchRuntimeMintConfirmation {
  readonly approvalId: string;
  readonly approvalToken: string;
  readonly taskId: string;
  readonly operatorId: string;
  readonly intentDigest: string;
  readonly expiresAt: string;
}

export interface CodingWorkbenchRuntimeAuthorityFacts {
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly budgetDigest: string;
  readonly commandPolicyDigest: string;
  readonly networkPolicyDigest: string;
  readonly gatesDigest: string;
  readonly branchConstraintsDigest: string;
  readonly modelProfileDigest: string;
}

export interface CodingWorkbenchRuntimeDelegationUsage {
  readonly toolCalls: number;
  readonly patchBytes: number;
  readonly promptTokens: number;
}

export interface CodingWorkbenchRuntimeAdapterStartRequest {
  readonly authorityRef: { readonly runId: string; readonly envelopeDigest: string };
  readonly delegationId: string;
  readonly idempotencyKey: string;
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
}

export interface CodingWorkbenchRuntimeAdapterPort {
  readonly start: (request: CodingWorkbenchRuntimeAdapterStartRequest) => Promise<void>;
  readonly stop: (runId: string) => Promise<void>;
}

const LEGAL_TRANSITIONS: Readonly<
  Record<CodingWorkbenchRuntimeStateName, readonly CodingWorkbenchRuntimeStateName[]>
> = Object.freeze({
  unavailable: ["idle", "recovery-required"],
  idle: ["starting", "unavailable", "recovery-required"],
  starting: ["ready", "failed", "cancelled", "taken-over", "recovery-required"],
  ready: ["running", "stopping", "failed", "taken-over", "recovery-required"],
  running: [
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "taken-over",
    "recovery-required",
  ],
  "awaiting-approval": ["running", "stopping", "failed", "taken-over", "recovery-required"],
  stopping: ["cancelled", "succeeded", "failed", "recovery-required"],
  succeeded: ["idle", "recovery-required"],
  failed: ["idle", "recovery-required"],
  cancelled: ["idle", "recovery-required"],
  "taken-over": ["idle", "recovery-required"],
  "recovery-required": ["idle", "unavailable"],
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isLegalCodingWorkbenchRuntimeTransition(
  from: CodingWorkbenchRuntimeStateName,
  to: CodingWorkbenchRuntimeStateName,
): boolean {
  return (
    isOneOf(from, CODING_WORKBENCH_RUNTIME_STATE_NAMES) &&
    isOneOf(to, CODING_WORKBENCH_RUNTIME_STATE_NAMES) &&
    LEGAL_TRANSITIONS[from].includes(to)
  );
}

export function validateCodingWorkbenchRuntimeIntent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeIntent> {
  if (!isRecord(value)) return { ok: false, errors: ["runtime intent must be an object"] };
  const common = ["schemaVersion", "requestId", "command"];
  const allowed =
    value.command === "start"
      ? [...common, "taskIntent", "requestedMode", "modelSource"]
      : [...common, "runId"];
  const errors = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `runtimeIntent.${key} is not allowed`);
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    errors.push("schemaVersion is invalid");
  if (!isNonEmpty(value.requestId)) errors.push("requestId must be a non-empty string");
  if (!isOneOf(value.command, CODING_WORKBENCH_LIFECYCLE_COMMANDS))
    errors.push("command is invalid");
  if (value.command === "start") validateStartIntent(value, errors);
  else if (
    isOneOf(value.command, CODING_WORKBENCH_LIFECYCLE_COMMANDS) &&
    !isNonEmpty(value.runId)
  ) {
    errors.push("runId must be a non-empty string");
  }
  return errors.length === 0
    ? { ok: true, value: value as unknown as CodingWorkbenchRuntimeIntent }
    : { ok: false, errors };
}

export function validateCodingWorkbenchRuntimeAuthorityEnvelope(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAuthorityEnvelope> {
  if (!isRecord(value)) return { ok: false, errors: ["runtime authority must be an object"] };
  const errors = unknownKeys(
    value,
    ["schemaVersion", "authority", "binding", "intentDigest", "nonceDigest", "issuedAt"],
    "runtimeAuthority",
  );
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    errors.push("schemaVersion is invalid");
  const authority = validateCodingWorkbenchAuthorityEnvelope(value.authority);
  if (!authority.ok) errors.push(...authority.errors.map((error) => `authority.${error}`));
  validateBinding(value.binding, errors);
  validateDigest(value.intentDigest, "intentDigest", errors);
  validateDigest(value.nonceDigest, "nonceDigest", errors);
  validateIso(value.issuedAt, "issuedAt", errors);
  if (authority.ok && authority.value.workspace.rootDigest !== bindingRootDigest(value.binding)) {
    errors.push("binding workspace root digest must match authority workspace");
  }
  if (authority.ok && isRecord(value.binding)) {
    validateAuthorityBindingCorrelation(authority.value, value.binding, errors);
  }
  return errors.length === 0
    ? { ok: true, value: value as unknown as CodingWorkbenchRuntimeAuthorityEnvelope }
    : { ok: false, errors };
}

export function validateCodingWorkbenchRuntimeState(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeState> {
  if (!isRecord(value)) return { ok: false, errors: ["runtime state must be an object"] };
  const errors = unknownKeys(
    value,
    [
      "schemaVersion",
      "state",
      "revision",
      "updatedAt",
      "runId",
      "taskId",
      "workspaceId",
      "runtimeSource",
      "modelSource",
      "failureCode",
    ],
    "runtimeState",
  );
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    errors.push("schemaVersion is invalid");
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) errors.push("state is invalid");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)
    errors.push("revision must be non-negative");
  validateStrictIso(value.updatedAt, "updatedAt", errors);
  validateOptionalStateFields(value, errors);
  validateStateShape(value, errors);
  return result(value, errors);
}

export function validateCodingWorkbenchRuntimeMintConfirmation(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeMintConfirmation> {
  if (!isRecord(value)) return { ok: false, errors: ["mint confirmation must be an object"] };
  const errors = unknownKeys(
    value,
    ["approvalId", "approvalToken", "taskId", "operatorId", "intentDigest", "expiresAt"],
    "mintConfirmation",
  );
  for (const key of ["approvalId", "approvalToken", "taskId", "operatorId"] as const)
    if (!isNonEmpty(value[key])) errors.push(`${key} is required`);
  validateDigest(value.intentDigest, "intentDigest", errors);
  validateStrictIso(value.expiresAt, "expiresAt", errors);
  return result(value, errors);
}

export function validateCodingWorkbenchRuntimeAuthorityFacts(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAuthorityFacts> {
  if (!isRecord(value)) return { ok: false, errors: ["authority facts must be an object"] };
  const keys = [
    "binding",
    "actionClasses",
    "connectorScopes",
    "runtimeSource",
    "modelSource",
    "budgetDigest",
    "commandPolicyDigest",
    "networkPolicyDigest",
    "gatesDigest",
    "branchConstraintsDigest",
    "modelProfileDigest",
  ];
  const errors = unknownKeys(value, keys, "authorityFacts");
  validateBinding(value.binding, errors);
  for (const key of keys.filter((key) => key.endsWith("Digest")))
    validateDigest(value[key], key, errors);
  if (!Array.isArray(value.actionClasses) || !Array.isArray(value.connectorScopes))
    errors.push("authority scopes must be arrays");
  else {
    if (!value.actionClasses.every((entry) => isOneOf(entry, CODING_WORKBENCH_ACTION_CLASSES)))
      errors.push("actionClasses contains an invalid member");
    if (!value.connectorScopes.every((entry) => isOneOf(entry, CODING_WORKBENCH_CONNECTOR_SCOPES)))
      errors.push("connectorScopes contains an invalid member");
  }
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES))
    errors.push("runtimeSource is invalid");
  if (!isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES))
    errors.push("modelSource is invalid");
  return result(value, errors);
}

export function validateCodingWorkbenchRuntimeAdapterStartRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAdapterStartRequest> {
  if (!isRecord(value)) return { ok: false, errors: ["adapter request must be an object"] };
  const errors = unknownKeys(
    value,
    ["authorityRef", "delegationId", "idempotencyKey", "binding", "runtimeSource", "modelSource"],
    "adapterRequest",
  );
  validateBinding(value.binding, errors);
  if (!isRecord(value.authorityRef)) errors.push("authorityRef is required");
  else {
    errors.push(...unknownKeys(value.authorityRef, ["runId", "envelopeDigest"], "authorityRef"));
    if (!isNonEmpty(value.authorityRef.runId)) errors.push("authorityRef.runId is required");
    validateDigest(value.authorityRef.envelopeDigest, "authorityRef.envelopeDigest", errors);
  }
  for (const key of ["delegationId", "idempotencyKey"] as const)
    if (!isNonEmpty(value[key])) errors.push(`${key} is required`);
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES))
    errors.push("runtimeSource is invalid");
  if (!isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES))
    errors.push("modelSource is invalid");
  return result(value, errors);
}

function result<T>(value: unknown, errors: string[]): CodingWorkbenchValidationResult<T> {
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

function validateAuthorityBindingCorrelation(
  authority: CodingWorkbenchAuthorityEnvelope,
  binding: Record<string, unknown>,
  errors: string[],
): void {
  if (!authority.taskRefs.includes(String(binding.taskId))) {
    errors.push("binding task id must be present in authority task references");
  }
  if (authority.workspace.workspaceId !== binding.workspaceId) {
    errors.push("binding workspace id must match authority workspace");
  }
  if (authority.branch.headRef !== binding.branchRef) {
    errors.push("binding branch reference must match authority head reference");
  }
  if (
    !authority.branch.allowedPrefixes.some((prefix) => String(binding.branchRef).startsWith(prefix))
  ) {
    errors.push("binding branch reference must satisfy authority branch constraints");
  }
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
}

function validateBinding(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("binding must be an object");
    return;
  }
  errors.push(
    ...unknownKeys(
      value,
      [
        "taskId",
        "projectId",
        "projectDigest",
        "workspaceId",
        "workspaceRootDigest",
        "branchRef",
        "branchHeadDigest",
      ],
      "binding",
    ),
  );
  for (const key of ["taskId", "projectId", "workspaceId", "branchRef"] as const) {
    if (!isNonEmpty(value[key])) errors.push(`binding.${key} must be a non-empty string`);
  }
  for (const key of ["projectDigest", "workspaceRootDigest", "branchHeadDigest"] as const) {
    validateDigest(value[key], `binding.${key}`, errors);
  }
}

function bindingRootDigest(value: unknown): unknown {
  return isRecord(value) ? value.workspaceRootDigest : undefined;
}

function validateDigest(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    errors.push(`${path} must be a 64-character lowercase hex digest`);
  }
}

function validateIso(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be an ISO instant`);
  }
}

function validateStrictIso(value: unknown, path: string, errors: string[]): void {
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

function validateOptionalStateFields(value: Record<string, unknown>, errors: string[]): void {
  for (const key of ["runId", "taskId", "workspaceId"] as const) {
    if (value[key] !== undefined && !isNonEmpty(value[key]))
      errors.push(`${key} must be a non-empty string`);
  }
  if (
    value.runtimeSource !== undefined &&
    !isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)
  )
    errors.push("runtimeSource is invalid");
  if (
    value.modelSource !== undefined &&
    !isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES)
  )
    errors.push("modelSource is invalid");
  if (
    value.failureCode !== undefined &&
    !isOneOf(value.failureCode, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)
  )
    errors.push("failureCode is invalid");
}

function validateStateShape(value: Record<string, unknown>, errors: string[]): void {
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) return;
  const unbound = value.state === "idle" || value.state === "unavailable";
  const bindings = [
    value.runId,
    value.taskId,
    value.workspaceId,
    value.runtimeSource,
    value.modelSource,
  ];
  if (unbound && bindings.some((entry) => entry !== undefined))
    errors.push("unbound state must not carry run binding");
  const recoveryHasBinding =
    value.state === "recovery-required" && bindings.some((entry) => entry !== undefined);
  const requiresBinding = !unbound && value.state !== "recovery-required";
  if ((requiresBinding || recoveryHasBinding) && bindings.some((entry) => !isNonEmpty(entry)))
    errors.push("run-bound state requires complete binding");
  validateStateFailureShape(value, errors);
}

function validateStateFailureShape(value: Record<string, unknown>, errors: string[]): void {
  const requiresFailure = value.state === "failed" || value.state === "recovery-required";
  if (requiresFailure && value.failureCode === undefined)
    errors.push("failure state requires failureCode");
  const permitsFailure = [
    "unavailable",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
  ].includes(String(value.state));
  if (!permitsFailure && value.failureCode !== undefined)
    errors.push("state must not carry failureCode");
}

function validateStartIntent(value: Record<string, unknown>, errors: string[]): void {
  if (
    !isNonEmpty(value.taskIntent) ||
    value.taskIntent.length > CODING_WORKBENCH_TASK_INTENT_MAX_CHARS
  ) {
    errors.push("taskIntent must be a bounded non-empty string");
  }
  const modes: readonly CodingWorkbenchMode[] = [
    "governed-assist",
    "supervised-coding",
    "autonomous-delivery",
  ];
  const sources: readonly CodingWorkbenchModelSource[] = [
    "keiko-model-gateway",
    "openai-api-key-through-gateway",
    "chatgpt-codex-subscription-profile",
  ];
  if (!isOneOf(value.requestedMode, modes)) errors.push("requestedMode is invalid");
  if (!isOneOf(value.modelSource, sources)) errors.push("modelSource is invalid");
}
