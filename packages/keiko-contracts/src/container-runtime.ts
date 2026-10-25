// Governed container engine detection + execution wire contract (Issue #1388, Epic #1491,
// ADR-0070). This leaf module owns the wire-stable vocabulary for the container runtime pilot only.
// It is intentionally pure: no IO, no process execution, no clock, no randomness. In-package
// helpers share task-field admission, freezing, the defense-in-depth allowlist shape and the
// runtime capability vocabularies (aliased, never redefined) for the engine state.
//
// The runner never accepts free-form argv, image refs, or flags. A request names a `taskId` from a
// server-frozen catalog; the server resolves that id to a vetted `ContainerTask` whose `image` is in
// a closed allowlist and whose docker/podman argv is hardened by the server. Detection and execution
// live in keiko-server (composing keiko-tools `runCommand`), so the browser never gains container,
// process, shell, or filesystem authority.

import type { CommandRule } from "./tools.js";
import { deepFreeze } from "./deep-freeze.js";
import {
  isNonEmptyString,
  isOneOf,
  isRecord,
  validateRunResultCore,
  validateTaskArguments,
  validateTaskCatalogMembers,
} from "./run-result-validation.js";
import {
  RUNTIME_CAPABILITY_STATES,
  RUNTIME_CAPABILITY_UNAVAILABLE_REASONS,
  type RuntimeCapabilityState,
  type RuntimeCapabilityUnavailableReason,
} from "./runtime-capabilities.js";

// ─── Schema version ───────────────────────────────────────────────────────────────

export const CONTAINER_RUNTIME_SCHEMA_VERSION = "1" as const;

// ─── Engine identity ────────────────────────────────────────────────────────────────

export type ContainerEngineId = "docker" | "podman";

export const CONTAINER_ENGINE_IDS: readonly ContainerEngineId[] = Object.freeze([
  "docker",
  "podman",
] as const satisfies readonly ContainerEngineId[]);

// ─── Engine state — REUSE the runtime capability vocabulary (alias only, no new members) ─────

// The probe's resolved state aligns 1:1 with `RuntimeCapabilityState`; its reason aligns with
// `RuntimeCapabilityUnavailableReason`. Aliased for the container surface ergonomics — the
// underlying unions are identical and there is no parallel enum.
export type ContainerEngineState = RuntimeCapabilityState;
export type ContainerEngineUnavailableReason = RuntimeCapabilityUnavailableReason;

// ─── Engine status + capability response ───────────────────────────────────────────

export interface ContainerEngineStatus {
  readonly engine: ContainerEngineId;
  readonly state: ContainerEngineState;
  readonly version?: string | undefined;
  readonly unavailableReason?: ContainerEngineUnavailableReason | undefined;
  readonly remediationHint?: string | undefined;
}

export interface ContainerCapabilityResponse {
  readonly schemaVersion: typeof CONTAINER_RUNTIME_SCHEMA_VERSION;
  readonly generatedAtMs: number;
  readonly deadlineMs: number;
  readonly engines: readonly ContainerEngineStatus[];
  readonly anyAvailable: boolean;
}

// ─── Execution policy ─────────────────────────────────────────────────────────────

export type ContainerMountMode = "read-only";

export const CONTAINER_MOUNT_MODES: readonly ContainerMountMode[] = Object.freeze([
  "read-only",
] as const satisfies readonly ContainerMountMode[]);

export type ContainerNetworkMode = "none";

export const CONTAINER_NETWORK_MODES: readonly ContainerNetworkMode[] = Object.freeze([
  "none",
] as const satisfies readonly ContainerNetworkMode[]);

export interface ContainerResourceLimits {
  readonly pidsLimit: number;
  readonly memoryBytes: number;
  readonly cpus: number;
}

export interface ContainerExecutionPolicy {
  readonly imageAllowlist: readonly string[];
  readonly limits: ContainerResourceLimits;
  readonly mountMode: ContainerMountMode;
  readonly networkMode: ContainerNetworkMode;
  readonly workspaceMountPath: string;
  readonly pull: "never";
}

// ─── Container task + catalog ─────────────────────────────────────────────────────

export type ContainerTaskKind = "diagnostic" | "verify";

export const CONTAINER_TASK_KINDS: readonly ContainerTaskKind[] = Object.freeze([
  "diagnostic",
  "verify",
] as const satisfies readonly ContainerTaskKind[]);

export interface ContainerTask {
  readonly id: string;
  readonly kind: ContainerTaskKind;
  readonly label: string;
  readonly image: string;
  readonly args: readonly string[];
  readonly engine: ContainerEngineId;
}

export interface ContainerTaskCatalog {
  readonly schemaVersion: typeof CONTAINER_RUNTIME_SCHEMA_VERSION;
  readonly projectId: string;
  readonly engineAvailable: boolean;
  readonly tasks: readonly ContainerTask[];
}

// ─── Run request / result / events ─────────────────────────────────────────────────

export interface ContainerRunRequest {
  readonly projectId: string;
  readonly taskId: string;
  readonly timeoutMs?: number | undefined;
  readonly requestId?: string | undefined;
}

// Why a run did not finish cleanly. `truncated`/`timedOut` are SEPARATE result fields; this enum
// names the dominant terminal cause for the result and audit. `engine-unavailable` is reserved for
// the engine vanishing mid-resolution after a run id was minted — the normal no-engine path throws a
// governance error before any run exists.
export type ContainerFailureReason =
  | "none"
  | "non-zero-exit"
  | "engine-unavailable"
  | "image-missing"
  | "pull-denied"
  | "mount-failure"
  | "timed-out"
  | "cancelled"
  | "denied"
  | "spawn-error"
  | "output-capped";

export const CONTAINER_FAILURE_REASONS: readonly ContainerFailureReason[] = Object.freeze([
  "none",
  "non-zero-exit",
  "engine-unavailable",
  "image-missing",
  "pull-denied",
  "mount-failure",
  "timed-out",
  "cancelled",
  "denied",
  "spawn-error",
  "output-capped",
] as const satisfies readonly ContainerFailureReason[]);

export interface ContainerRunResult {
  readonly schemaVersion: typeof CONTAINER_RUNTIME_SCHEMA_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly kind: ContainerTaskKind;
  readonly engine: ContainerEngineId;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly failureReason: ContainerFailureReason;
  readonly stdout: string;
  readonly stderr: string;
}

export type ContainerRunnerEventKind =
  "run-started" | "run-completed" | "run-failed" | "run-cancelled";

export const CONTAINER_RUNNER_EVENT_KINDS: readonly ContainerRunnerEventKind[] = Object.freeze([
  "run-started",
  "run-completed",
  "run-failed",
  "run-cancelled",
] as const satisfies readonly ContainerRunnerEventKind[]);

export interface ContainerRunnerEvent {
  readonly kind: ContainerRunnerEventKind;
  readonly runId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─── Allowlist (defense-in-depth, D4) ──────────────────────────────────────────────

// `runCommand` denies the WHOLE invocation if ANY `denyFlags` member appears ANYWHERE in argv (in
// `--flag x` or `--flag=x` form — see keiko-tools/src/sandbox.ts). The runner passes the server-
// FROZEN hardened argv to `runCommand`, so `denyFlags` MUST NOT contain any flag the server's own
// frozen argv emits, or the runner would self-deny its own hardened run. The frozen `docker run`
// argv emits `--rm`, `--network`, `--read-only`, `--cap-drop`, `--security-opt`, `--pids-limit`,
// `--memory`, `--cpus`, `--pull`, `-v`; those are therefore EXCLUDED from `denyFlags`. The decisive
// safety control is the server-frozen argv + closed catalog (D2/D3) — this list is pure defense-in-
// depth against escalation flags the server NEVER emits, catching a hypothetical future regression
// where a client-influenced token reaches the argv.
//
// ALIAS-COMPLETENESS RULE: the matcher in keiko-tools/src/sandbox.ts is an exact-token comparison
// (it only splits `--flag=value` at the `=`), so every spelling of a denied flag must be listed
// separately — denying `--user` without `-u` denies nothing a caller cannot trivially rewrite. The
// `--volume`/`--net` entries below already follow this; new entries must too.
const CONTAINER_DENY_FLAGS = Object.freeze([
  "--privileged",
  "--volume", // long form of -v; the server uses only the short `-v`, so reject any extra mount
  "--mount",
  "--device",
  "--cap-add",
  "--net", // alias of --network; server uses the canonical --network, reject the alias
  "--pid",
  "--ipc",
  "--user",
  "-u", // short alias of --user; alias-completeness rule — deny every spelling of a denied flag
  "--entrypoint", // replaces the program the container executes
  "--userns", // user-namespace remapping, including `host` (defeats the uid boundary)
  "--group-add", // supplementary groups, including privileged ones
  "--device-cgroup-rule", // grants device access without --device
  "-c",
] as const);

// deepFreeze, not Object.freeze: freezing only the outer array leaves each rule object's own
// top-level fields (executable, allowedSubcommands, denyFlags) writable — the identical bug class
// command-runner.ts's COMMAND_TASK_RULES already documents and was fixed for (KEIKO-0139).
export const CONTAINER_TASK_RULES: readonly CommandRule[] = deepFreeze([
  {
    executable: "docker",
    allowedSubcommands: Object.freeze(["version", "info", "run"]),
    denyFlags: CONTAINER_DENY_FLAGS,
  },
  {
    executable: "podman",
    allowedSubcommands: Object.freeze(["version", "info", "run"]),
    denyFlags: CONTAINER_DENY_FLAGS,
  },
] satisfies readonly CommandRule[]);

// ─── Validators (hand-rolled, throw-free, deterministic messages) ─────────────────

export interface ContainerRunRequestParseOk {
  readonly ok: true;
  readonly value: ContainerRunRequest;
}

export interface ContainerRunRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ContainerRunRequestParse = ContainerRunRequestParseOk | ContainerRunRequestParseFail;

export interface ContainerCapabilityResponseParseOk {
  readonly ok: true;
  readonly value: ContainerCapabilityResponse;
}

export interface ContainerCapabilityResponseParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ContainerCapabilityResponseParse =
  ContainerCapabilityResponseParseOk | ContainerCapabilityResponseParseFail;

export interface ContainerTaskCatalogParseOk {
  readonly ok: true;
  readonly value: ContainerTaskCatalog;
}

export interface ContainerTaskCatalogParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ContainerTaskCatalogParse = ContainerTaskCatalogParseOk | ContainerTaskCatalogParseFail;

export interface ContainerRunResultParseOk {
  readonly ok: true;
  readonly value: ContainerRunResult;
}

export interface ContainerRunResultParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ContainerRunResultParse = ContainerRunResultParseOk | ContainerRunResultParseFail;

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function requestOptionalsAreValid(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & Pick<ContainerRunRequest, "timeoutMs" | "requestId"> {
  const timeout = input.timeoutMs === undefined || isPositiveFinite(input.timeoutMs);
  if (!timeout) errors.push("timeoutMs must be a positive finite number");
  const request = input.requestId === undefined || typeof input.requestId === "string";
  if (!request) errors.push("requestId must be a string");
  return timeout && request;
}

function requestFieldsAreValid(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & ContainerRunRequest {
  const project = isNonEmptyString(input.projectId);
  if (!project) errors.push("projectId must be a non-empty string");
  const task = isNonEmptyString(input.taskId);
  if (!task) errors.push("taskId must be a non-empty string");
  const optional = requestOptionalsAreValid(input, errors);
  return project && task && optional;
}

export function parseContainerRunRequest(input: unknown): ContainerRunRequestParse {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  if (!requestFieldsAreValid(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

function validateOptionalStringField(
  value: Record<string, unknown>,
  key: "version" | "remediationHint",
  path: string,
  errors: string[],
): boolean {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    errors.push(`${path}.${key} must be a string`);
    return false;
  }
  return true;
}

function engineStateIsValid(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): value is Record<string, unknown> & Pick<ContainerEngineStatus, "state"> {
  if (typeof value.state !== "string") {
    errors.push(`${path}.state must be a non-empty string`);
    return false;
  }
  const state = value.state;
  if (typeof state !== "string" || state.length === 0) {
    errors.push(`${path}.state must be a non-empty string`);
    return false;
  }
  if (!isOneOf(state, RUNTIME_CAPABILITY_STATES)) {
    errors.push(`${path}.state is invalid`);
    return false;
  }
  return true;
}

function engineReasonIsValid(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): value is Record<string, unknown> & Pick<ContainerEngineStatus, "unavailableReason"> {
  if (value.unavailableReason === undefined) return true;
  const reason = value.unavailableReason;
  if (typeof reason !== "string") {
    errors.push(`${path}.unavailableReason must be a string`);
    return false;
  }
  if (!isOneOf(reason, RUNTIME_CAPABILITY_UNAVAILABLE_REASONS)) {
    errors.push(`${path}.unavailableReason is invalid`);
    return false;
  }
  return true;
}

function engineOptionalsAreValid(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): value is Record<string, unknown> &
  Pick<ContainerEngineStatus, "version" | "unavailableReason" | "remediationHint"> {
  const version = validateOptionalStringField(value, "version", path, errors);
  const reason = engineReasonIsValid(value, path, errors);
  const remediation = validateOptionalStringField(value, "remediationHint", path, errors);
  return version && reason && remediation;
}

function validateEngineStatus(
  value: unknown,
  index: number,
  errors: string[],
): value is ContainerEngineStatus {
  const path = `engines[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const engine = isOneOf(value.engine, CONTAINER_ENGINE_IDS);
  if (!engine) errors.push(`${path}.engine is invalid`);
  const state = engineStateIsValid(value, path, errors);
  const optional = engineOptionalsAreValid(value, path, errors);
  return engine && state && optional;
}

function capabilityTimesAreValid(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> &
  Pick<ContainerCapabilityResponse, "generatedAtMs" | "deadlineMs"> {
  const generatedAtMs = value.generatedAtMs;
  const generated =
    typeof generatedAtMs === "number" && Number.isSafeInteger(generatedAtMs) && generatedAtMs >= 0;
  if (!generated) errors.push("generatedAtMs must be a non-negative safe integer");
  const deadlineMs = value.deadlineMs;
  const deadline =
    typeof deadlineMs === "number" && Number.isSafeInteger(deadlineMs) && deadlineMs >= 1;
  if (!deadline) errors.push("deadlineMs must be a positive safe integer");
  return generated && deadline;
}

function validateCapabilityScalars(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> &
  Pick<
    ContainerCapabilityResponse,
    "schemaVersion" | "generatedAtMs" | "deadlineMs" | "anyAvailable"
  > {
  const schema = value.schemaVersion === CONTAINER_RUNTIME_SCHEMA_VERSION;
  if (!schema) errors.push("schemaVersion is invalid");
  const times = capabilityTimesAreValid(value, errors);
  const available = typeof value.anyAvailable === "boolean";
  if (!available) errors.push("anyAvailable must be a boolean");
  return schema && times && available;
}

function validateEnginesArray(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & Pick<ContainerCapabilityResponse, "engines"> {
  if (!Array.isArray(value.engines)) {
    errors.push("engines must be an array");
    return false;
  }
  const engines: unknown = value.engines;
  if (!Array.isArray(engines)) {
    errors.push("engines must be an array");
    return false;
  }
  const entries: readonly unknown[] = engines;
  const length = entries.length;
  let valid = true;
  for (let index = 0; index < length; index += 1) {
    if (!(index in entries)) {
      errors.push(`engines[${String(index)}] must be an object`);
      return false;
    }
    if (!validateEngineStatus(entries[index], index, errors)) valid = false;
  }
  return valid;
}

export function validateContainerCapabilityResponse(
  value: unknown,
): ContainerCapabilityResponseParse {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["response must be an object"] };
  const scalars = validateCapabilityScalars(value, errors);
  const engines = validateEnginesArray(value, errors);
  if (!scalars || !engines) return { ok: false, errors };
  return { ok: true, value };
}

function containerTaskIdentityIsValid(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): value is Record<string, unknown> & Pick<ContainerTask, "id" | "label" | "image"> {
  const id = isNonEmptyString(value.id);
  if (!id) errors.push(`${path}.id must be a non-empty string`);
  const label = isNonEmptyString(value.label);
  if (!label) errors.push(`${path}.label must be a non-empty string`);
  const image = isNonEmptyString(value.image);
  if (!image) errors.push(`${path}.image must be a non-empty string`);
  return id && label && image;
}

function validateContainerTask(
  value: unknown,
  index: number,
  errors: string[],
): value is ContainerTask {
  const path = `tasks[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const identity = containerTaskIdentityIsValid(value, path, errors);
  const kind = isOneOf(value.kind, CONTAINER_TASK_KINDS);
  if (!kind) errors.push(`${path}.kind is invalid`);
  const engine = isOneOf(value.engine, CONTAINER_ENGINE_IDS);
  if (!engine) errors.push(`${path}.engine is invalid`);
  const args = validateTaskArguments(value, path, errors);
  return identity && kind && engine && args;
}

function catalogFieldsAreValid(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & ContainerTaskCatalog {
  const schema = value.schemaVersion === CONTAINER_RUNTIME_SCHEMA_VERSION;
  if (!schema) errors.push("schemaVersion is invalid");
  const project = isNonEmptyString(value.projectId);
  if (!project) errors.push("projectId must be a non-empty string");
  const engine = typeof value.engineAvailable === "boolean";
  if (!engine) errors.push("engineAvailable must be a boolean");
  const tasks = validateTaskCatalogMembers(value, errors, validateContainerTask);
  return schema && project && engine && tasks;
}

export function validateContainerTaskCatalog(value: unknown): ContainerTaskCatalogParse {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["catalog must be an object"] };
  if (!catalogFieldsAreValid(value, errors)) return { ok: false, errors };
  return { ok: true, value };
}

// KEIKO-0601: the field-by-field scalar/runtime checks (schemaVersion, runId, taskId, kind,
// failureReason, exitCode, durationMs, truncated, timedOut, stdout, stderr) are shared with
// command-runner.ts's validateCommandTaskRunResult via run-result-validation.ts's
// validateRunResultCore, parameterized by this executor's own schema version, CONTAINER_TASK_KINDS
// and CONTAINER_FAILURE_REASONS. `engine` is this executor's own extra field — the `afterKind` hook
// validates it immediately after `kind` so the error order stays schemaVersion, runId, taskId, kind,
// engine, failureReason, exitCode, durationMs, truncated, timedOut, stdout, stderr, exactly as
// container-runtime.test.ts's fixed-order test pins.
function validateEngineField(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & Pick<ContainerRunResult, "engine"> {
  if (!isOneOf(value.engine, CONTAINER_ENGINE_IDS)) {
    errors.push("engine is invalid");
    return false;
  }
  return true;
}

export function validateContainerRunResult(value: unknown): ContainerRunResultParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  if (
    !validateRunResultCore(
      value,
      {
        schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
        kinds: CONTAINER_TASK_KINDS,
        failureReasons: CONTAINER_FAILURE_REASONS,
      },
      errors,
      validateEngineField,
    )
  ) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}
