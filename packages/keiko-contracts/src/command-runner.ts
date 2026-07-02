// Governed test/build/run command executor wire contract (Issue #1387, Epic #1491). This leaf
// module owns the wire-stable vocabulary for the controlled command runner only. It is intentionally
// pure: no IO, no process execution, no clock, no randomness, and no imports from sibling packages —
// the one in-package import is the `CommandRule` shape reused for the executor allowlist.
//
// The runner never accepts free-form argv. A request names a `taskId` from a server-discovered
// catalog; the BFF resolves that id to a vetted `CommandTask` whose `executable`+`args` are frozen.
// Discovery and execution live in keiko-server (composing keiko-tools `runCommand`), so the browser
// never gains process, shell, or filesystem authority.

import type { CommandRule } from "./tools.js";

export const COMMAND_RUNNER_SCHEMA_VERSION = "1" as const;

// The three governed task families named by Issue #1387. Discovered scripts that are not clearly a
// test or build are classified as a generic `run` task rather than being widened into new kinds.
export type CommandTaskKind = "test" | "build" | "run";

export const COMMAND_TASK_KINDS: readonly CommandTaskKind[] = Object.freeze([
  "test",
  "build",
  "run",
] as const satisfies readonly CommandTaskKind[]);

// Where a catalog task came from. v1 discovers `package.json` scripts; the enum is open for future
// ecosystem-manifest sources without a breaking change to the discovered-task shape.
export type CommandTaskSource = "package-json-script";

export const COMMAND_TASK_SOURCES: readonly CommandTaskSource[] = Object.freeze([
  "package-json-script",
] as const satisfies readonly CommandTaskSource[]);

// Repository-authored scripts are executable code from the selected workspace. The browser can see
// whether a task is currently runnable, but the server owns the trust decision and re-checks it at
// execution time; the request never carries this field back as authority.
export type CommandTaskTrustState = "trusted" | "approval-required";

export const COMMAND_TASK_TRUST_STATES: readonly CommandTaskTrustState[] = Object.freeze([
  "trusted",
  "approval-required",
] as const satisfies readonly CommandTaskTrustState[]);

export type CommandTaskTrustReason = "repository-authored-script";

export const COMMAND_TASK_TRUST_REASONS: readonly CommandTaskTrustReason[] = Object.freeze([
  "repository-authored-script",
] as const satisfies readonly CommandTaskTrustReason[]);

// One vetted catalog entry: a stable id mapped to an exact, frozen argv. Agents and the UI pick a
// task by id; they never supply `executable`/`args`, so an untrusted name can never reach a spawn.
export interface CommandTask {
  readonly id: string;
  readonly kind: CommandTaskKind;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly source: CommandTaskSource;
  readonly trustState: CommandTaskTrustState;
  readonly trustReason: CommandTaskTrustReason;
}

export interface CommandTaskCatalog {
  readonly schemaVersion: typeof COMMAND_RUNNER_SCHEMA_VERSION;
  readonly projectId: string;
  readonly tasks: readonly CommandTask[];
}

// Why a run did not finish cleanly. `truncated`/`timedOut` are SEPARATE result fields (a clean exit
// can still be truncated); this enum names the dominant terminal cause for the result and audit.
export type CommandFailureReason =
  "none" | "non-zero-exit" | "timed-out" | "cancelled" | "denied" | "spawn-error";

export const COMMAND_FAILURE_REASONS: readonly CommandFailureReason[] = Object.freeze([
  "none",
  "non-zero-exit",
  "timed-out",
  "cancelled",
  "denied",
  "spawn-error",
] as const satisfies readonly CommandFailureReason[]);

export interface CommandTaskRunRequest {
  readonly projectId: string;
  readonly taskId: string;
  // Optional per-run wall-clock override; the server clamps it to a floor and the policy ceiling.
  readonly timeoutMs?: number | undefined;
  // Client-chosen correlation token echoed on the run-started event so a UI can learn the
  // server-assigned runId mid-flight and cancel the in-flight run.
  readonly requestId?: string | undefined;
}

export interface CommandTaskRunResult {
  readonly schemaVersion: typeof COMMAND_RUNNER_SCHEMA_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly kind: CommandTaskKind;
  readonly exitCode: number | null;
  readonly durationMs: number;
  // True when output hit the byte cap and the rest was dropped (AC: bounded output).
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly failureReason: CommandFailureReason;
  // Already redacted + byte-capped by the server; never raw secret content.
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunnerEventKind =
  "run-started" | "run-completed" | "run-failed" | "run-cancelled";

export const COMMAND_RUNNER_EVENT_KINDS: readonly CommandRunnerEventKind[] = Object.freeze([
  "run-started",
  "run-completed",
  "run-failed",
  "run-cancelled",
] as const satisfies readonly CommandRunnerEventKind[]);

export interface CommandRunnerEvent {
  readonly kind: CommandRunnerEventKind;
  readonly runId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// The deny-by-default executor allowlist for discovered tasks. Deliberately SEPARATE from
// DEFAULT_COMMAND_RULES (read-only agent tools) and TERMINAL_COMMAND_RULES (read-only inspection) so
// the test/build/run surface cannot widen either: only the package-manager `run`/`test` subcommands
// back a task, and shell-spawning / scope-shifting flags are denied even though discovery only ever
// emits a frozen `["run", <script>]` argv (defense in depth).
export const COMMAND_TASK_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "npm",
    allowedSubcommands: Object.freeze(["run", "test"]),
    denyFlags: Object.freeze([
      "-c",
      "--call",
      "--prefix",
      "-g",
      "--global",
      "--location",
      "-w",
      "--workspace",
      "--workspaces",
    ]),
  },
] satisfies readonly CommandRule[]);

// ─── Validators (hand-rolled, throw-free, deterministic messages) ─────────────────

export interface CommandTaskRunRequestParseOk {
  readonly ok: true;
  readonly value: CommandTaskRunRequest;
}

export interface CommandTaskRunRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CommandTaskRunRequestParse =
  CommandTaskRunRequestParseOk | CommandTaskRunRequestParseFail;

export interface CommandTaskCatalogParseOk {
  readonly ok: true;
  readonly value: CommandTaskCatalog;
}

export interface CommandTaskCatalogParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CommandTaskCatalogParse = CommandTaskCatalogParseOk | CommandTaskCatalogParseFail;

export interface CommandTaskRunResultParseOk {
  readonly ok: true;
  readonly value: CommandTaskRunResult;
}

export interface CommandTaskRunResultParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CommandTaskRunResultParse = CommandTaskRunResultParseOk | CommandTaskRunResultParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

// Bound the identifier fields at the parse boundary so an oversized or non-token value cannot reach
// the manager, the audit ledger, or the SSE fan-out. The 16 KB body cap is the outer backstop; these
// are the precise per-field limits.
export const MAX_TASK_ID_LENGTH = 256;
export const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maxLength;
}

function isPositiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function collectOptionalRequestErrors(input: Record<string, unknown>, errors: string[]): void {
  if (input.timeoutMs !== undefined && !isPositiveFinite(input.timeoutMs)) {
    errors.push("timeoutMs must be a positive finite number");
  }
  if (input.requestId !== undefined && !isValidRequestId(input.requestId)) {
    errors.push(`requestId must be a token of 1-${String(MAX_REQUEST_ID_LENGTH)} characters`);
  }
}

// Parses an incoming run request at the BFF trust boundary. Collects ALL field errors in a fixed
// order (deterministic strings for test assertions); never throws.
export function parseCommandTaskRunRequest(input: unknown): CommandTaskRunRequestParse {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  if (!isNonEmptyString(input.projectId)) {
    errors.push("projectId must be a non-empty string");
  }
  if (!isBoundedNonEmptyString(input.taskId, MAX_TASK_ID_LENGTH)) {
    errors.push(
      `taskId must be a non-empty string of up to ${String(MAX_TASK_ID_LENGTH)} characters`,
    );
  }
  collectOptionalRequestErrors(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as CommandTaskRunRequest };
}

function validateTaskArgs(value: Record<string, unknown>, path: string, errors: string[]): void {
  const args = value.args;
  if (!Array.isArray(args)) {
    errors.push(`${path}.args must be an array`);
    return;
  }
  if (!args.every((arg) => typeof arg === "string")) {
    errors.push(`${path}.args must be an array of strings`);
  }
}

function validateTask(value: unknown, index: number, errors: string[]): void {
  const path = `tasks[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string`);
  if (!isNonEmptyString(value.label)) errors.push(`${path}.label must be a non-empty string`);
  if (!isNonEmptyString(value.executable)) {
    errors.push(`${path}.executable must be a non-empty string`);
  }
  if (!isOneOf(value.kind, COMMAND_TASK_KINDS)) errors.push(`${path}.kind is invalid`);
  if (!isOneOf(value.source, COMMAND_TASK_SOURCES)) errors.push(`${path}.source is invalid`);
  if (!isOneOf(value.trustState, COMMAND_TASK_TRUST_STATES)) {
    errors.push(`${path}.trustState is invalid`);
  }
  if (!isOneOf(value.trustReason, COMMAND_TASK_TRUST_REASONS)) {
    errors.push(`${path}.trustReason is invalid`);
  }
  validateTaskArgs(value, path, errors);
}

export function validateCommandTaskCatalog(value: unknown): CommandTaskCatalogParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["catalog must be an object"] };
  }
  if (value.schemaVersion !== COMMAND_RUNNER_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isNonEmptyString(value.projectId)) {
    errors.push("projectId must be a non-empty string");
  }
  if (!Array.isArray(value.tasks)) {
    errors.push("tasks must be an array");
  } else {
    value.tasks.forEach((task, index) => {
      validateTask(task, index, errors);
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as CommandTaskCatalog };
}

function validateResultScalars(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== COMMAND_RUNNER_SCHEMA_VERSION)
    errors.push("schemaVersion is invalid");
  if (!isNonEmptyString(value.runId)) errors.push("runId must be a non-empty string");
  if (!isNonEmptyString(value.taskId)) errors.push("taskId must be a non-empty string");
  if (!isOneOf(value.kind, COMMAND_TASK_KINDS)) errors.push("kind is invalid");
  if (!isOneOf(value.failureReason, COMMAND_FAILURE_REASONS))
    errors.push("failureReason is invalid");
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

function validateResultRuntime(value: Record<string, unknown>, errors: string[]): void {
  validateResultNumbers(value, errors);
  validateResultFlagsAndText(value, errors);
}

export function validateCommandTaskRunResult(value: unknown): CommandTaskRunResultParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  validateResultScalars(value, errors);
  validateResultRuntime(value, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as CommandTaskRunResult };
}
