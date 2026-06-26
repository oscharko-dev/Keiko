// Governed container engine detection + execution wire contract (Issue #1388, Epic #1491,
// ADR-0070). This leaf module owns the wire-stable vocabulary for the container runtime pilot only.
// It is intentionally pure: no IO, no process execution, no clock, no randomness. The ONLY in-package
// imports are the `CommandRule` shape reused for the defense-in-depth allowlist and the two runtime
// capability vocabularies reused (aliased, never redefined) for the engine state.
//
// The runner never accepts free-form argv, image refs, or flags. A request names a `taskId` from a
// server-frozen catalog; the server resolves that id to a vetted `ContainerTask` whose `image` is in
// a closed allowlist and whose docker/podman argv is hardened by the server. Detection and execution
// live in keiko-server (composing keiko-tools `runCommand`), so the browser never gains container,
// process, shell, or filesystem authority.

import type { CommandRule } from "./tools.js";
import type {
  RuntimeCapabilityState,
  RuntimeCapabilityUnavailableReason,
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
  | "run-started"
  | "run-completed"
  | "run-failed"
  | "run-cancelled";

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
  "-c",
] as const);

export const CONTAINER_TASK_RULES: readonly CommandRule[] = Object.freeze([
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
  | ContainerCapabilityResponseParseOk
  | ContainerCapabilityResponseParseFail;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function collectOptionalRequestErrors(input: Record<string, unknown>, errors: string[]): void {
  if (input.timeoutMs !== undefined && !isPositiveFinite(input.timeoutMs)) {
    errors.push("timeoutMs must be a positive finite number");
  }
  if (input.requestId !== undefined && typeof input.requestId !== "string") {
    errors.push("requestId must be a string");
  }
}

// Parses an incoming run request at the BFF trust boundary. Collects ALL field errors in a fixed
// order (deterministic strings for test assertions); never throws.
export function parseContainerRunRequest(input: unknown): ContainerRunRequestParse {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  if (!isNonEmptyString(input.projectId)) {
    errors.push("projectId must be a non-empty string");
  }
  if (!isNonEmptyString(input.taskId)) {
    errors.push("taskId must be a non-empty string");
  }
  collectOptionalRequestErrors(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as ContainerRunRequest };
}

function validateOptionalStringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    errors.push(`${path}.${key} must be a string`);
  }
}

function validateEngineStatus(value: unknown, index: number, errors: string[]): void {
  const path = `engines[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isOneOf(value.engine, CONTAINER_ENGINE_IDS)) {
    errors.push(`${path}.engine is invalid`);
  }
  if (typeof value.state !== "string" || value.state.length === 0) {
    errors.push(`${path}.state must be a non-empty string`);
  }
  validateOptionalStringField(value, "version", path, errors);
  validateOptionalStringField(value, "unavailableReason", path, errors);
  validateOptionalStringField(value, "remediationHint", path, errors);
}

function validateCapabilityScalars(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CONTAINER_RUNTIME_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  const generatedAtMs = value.generatedAtMs;
  if (
    typeof generatedAtMs !== "number" ||
    !Number.isSafeInteger(generatedAtMs) ||
    generatedAtMs < 0
  ) {
    errors.push("generatedAtMs must be a non-negative safe integer");
  }
  const deadlineMs = value.deadlineMs;
  if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    errors.push("deadlineMs must be a positive safe integer");
  }
  if (typeof value.anyAvailable !== "boolean") {
    errors.push("anyAvailable must be a boolean");
  }
}

function validateEnginesArray(value: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(value.engines)) {
    errors.push("engines must be an array");
  } else {
    value.engines.forEach((entry, index) => {
      validateEngineStatus(entry, index, errors);
    });
  }
}

export function validateContainerCapabilityResponse(
  value: unknown,
): ContainerCapabilityResponseParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["response must be an object"] };
  }
  validateCapabilityScalars(value, errors);
  validateEnginesArray(value, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as ContainerCapabilityResponse };
}

function validateContainerTaskArgs(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const args = value.args;
  if (!Array.isArray(args)) {
    errors.push(`${path}.args must be an array`);
    return;
  }
  if (!args.every((arg) => typeof arg === "string")) {
    errors.push(`${path}.args must be an array of strings`);
  }
}

function validateContainerTask(value: unknown, index: number, errors: string[]): void {
  const path = `tasks[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string`);
  if (!isNonEmptyString(value.label)) errors.push(`${path}.label must be a non-empty string`);
  if (!isNonEmptyString(value.image)) errors.push(`${path}.image must be a non-empty string`);
  if (!isOneOf(value.kind, CONTAINER_TASK_KINDS)) errors.push(`${path}.kind is invalid`);
  if (!isOneOf(value.engine, CONTAINER_ENGINE_IDS)) errors.push(`${path}.engine is invalid`);
  validateContainerTaskArgs(value, path, errors);
}

function validateCatalogScalars(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CONTAINER_RUNTIME_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isNonEmptyString(value.projectId)) {
    errors.push("projectId must be a non-empty string");
  }
  if (typeof value.engineAvailable !== "boolean") {
    errors.push("engineAvailable must be a boolean");
  }
}

export function validateContainerTaskCatalog(value: unknown): ContainerTaskCatalogParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["catalog must be an object"] };
  }
  validateCatalogScalars(value, errors);
  if (!Array.isArray(value.tasks)) {
    errors.push("tasks must be an array");
  } else {
    value.tasks.forEach((task, index) => {
      validateContainerTask(task, index, errors);
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as ContainerTaskCatalog };
}

function validateResultScalars(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CONTAINER_RUNTIME_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isNonEmptyString(value.runId)) errors.push("runId must be a non-empty string");
  if (!isNonEmptyString(value.taskId)) errors.push("taskId must be a non-empty string");
  if (!isOneOf(value.kind, CONTAINER_TASK_KINDS)) errors.push("kind is invalid");
  if (!isOneOf(value.engine, CONTAINER_ENGINE_IDS)) errors.push("engine is invalid");
  if (!isOneOf(value.failureReason, CONTAINER_FAILURE_REASONS)) {
    errors.push("failureReason is invalid");
  }
}

function validateResultNumbers(value: Record<string, unknown>, errors: string[]): void {
  const exitCode = value.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    errors.push("exitCode must be an integer or null");
  }
  const durationMs = value.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    errors.push("durationMs must be a non-negative finite number");
  }
}

function validateResultFlagsAndText(value: Record<string, unknown>, errors: string[]): void {
  if (typeof value.truncated !== "boolean") errors.push("truncated must be a boolean");
  if (typeof value.timedOut !== "boolean") errors.push("timedOut must be a boolean");
  if (typeof value.stdout !== "string") errors.push("stdout must be a string");
  if (typeof value.stderr !== "string") errors.push("stderr must be a string");
}

export function validateContainerRunResult(value: unknown): ContainerRunResultParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  validateResultScalars(value, errors);
  validateResultNumbers(value, errors);
  validateResultFlagsAndText(value, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as ContainerRunResult };
}
