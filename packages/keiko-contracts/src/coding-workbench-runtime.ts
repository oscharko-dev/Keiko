import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchValidationResult,
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
  readonly confirmationId: string;
  readonly taskId: string;
  readonly intentDigest: string;
  readonly proofDigest: string;
  readonly expiresAt: string;
}

export interface CodingWorkbenchRuntimeAuthorityFacts {
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly budgetDigest: string;
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
  return errors.length === 0
    ? { ok: true, value: value as unknown as CodingWorkbenchRuntimeAuthorityEnvelope }
    : { ok: false, errors };
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
