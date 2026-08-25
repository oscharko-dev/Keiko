// Governed test/build/run command executor wire contract (Issue #1387, Epic #1491). This leaf
// module owns the wire-stable vocabulary for the controlled command runner only. It is intentionally
// pure: no IO, no process execution, no clock, no randomness, and no imports from sibling packages —
// the one in-package import is the `CommandRule` shape reused for the executor allowlist.
//
// The runner never accepts free-form argv. A request names a `taskId` from a server-discovered
// catalog; the BFF resolves that id to a vetted `CommandTask` whose `executable`+`args` are frozen.
// Discovery and execution live in keiko-server (composing keiko-tools `runCommand`), so the browser
// never gains process, shell, or filesystem authority.

import { deepFreeze } from "./deep-freeze.js";
import {
  isNonEmptyString,
  isOneOf,
  isRecord,
  validateRunResultCore,
} from "./run-result-validation.js";
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
// deepFreeze: the array and the inner allowedSubcommands/denyFlags arrays were frozen individually,
// but the RULE OBJECTS were not — `COMMAND_TASK_RULES[0].executable = "bash"` and
// `COMMAND_TASK_RULES[0].denyFlags = []` both succeeded against the deny-by-default allowlist.
export const COMMAND_TASK_RULES: readonly CommandRule[] = deepFreeze([
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

// Bound the identifier fields at the parse boundary so an oversized or non-token value cannot reach
// the manager, the audit ledger, or the SSE fan-out. The 16 KB body cap is the outer backstop; these
// are the precise per-field limits.
export const MAX_TASK_ID_LENGTH = 256;
export const MAX_REQUEST_ID_LENGTH = 128;
// projectId is a real filesystem path (keiko-server's projectFor() matches it against
// project.path), so it takes a length bound and a control-character rejection rather than a token
// pattern — a `/` and spaces are legitimate in it.
export const MAX_PROJECT_ID_LENGTH = 4_096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
// Mirrors keiko-server's SAFE_SCRIPT_NAME: a taskId is always compared against a discovered script
// id of exactly this shape, so anything else can only be a malformed or hostile value.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
// C0 controls plus DEL. A newline or ESC in an identifier that is later interpolated into a log
// line or an SSE `data:` field is a log-injection / frame-splitting primitive.
// eslint-disable-next-line no-control-regex -- rejecting C0/DEL in an identifier is the point
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;

// Closed key sets. Every peer validator in this territory enforces one — an unexpected field on a
// documented content-free contract must never ride through — and these four did not, so a payload
// carrying free text alongside the validated fields was accepted and passed on as `value`.
function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): readonly string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
}

const RUN_REQUEST_KEYS = ["projectId", "taskId", "timeoutMs", "requestId"] as const;
const TASK_KEYS = [
  "id",
  "kind",
  "label",
  "executable",
  "args",
  "source",
  "trustState",
  "trustReason",
] as const;
const CATALOG_KEYS = ["schemaVersion", "projectId", "tasks"] as const;
const RUN_RESULT_KEYS = [
  "schemaVersion",
  "runId",
  "taskId",
  "kind",
  "exitCode",
  "durationMs",
  "truncated",
  "timedOut",
  "failureReason",
  "stdout",
  "stderr",
] as const;

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maxLength;
}

function isBoundedControlFreeString(value: unknown, maxLength: number): value is string {
  return isBoundedNonEmptyString(value, maxLength) && !CONTROL_CHAR_PATTERN.test(value);
}

function isValidTaskId(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_TASK_ID_LENGTH) && TASK_ID_PATTERN.test(value);
}

// timeoutMs feeds a real timer budget; a fractional or 1e300 value is malformed, not a large
// timeout, so the parse boundary requires a safe integer rather than any positive finite number.
function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
  if (input.timeoutMs !== undefined && !isPositiveSafeInteger(input.timeoutMs)) {
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
  errors.push(...unknownKeys(input, RUN_REQUEST_KEYS, "request"));
  if (!isBoundedControlFreeString(input.projectId, MAX_PROJECT_ID_LENGTH)) {
    errors.push("projectId must be a non-empty string");
  }
  if (!isValidTaskId(input.taskId)) {
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
  errors.push(...unknownKeys(value, TASK_KEYS, path));
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
  errors.push(...unknownKeys(value, CATALOG_KEYS, "catalog"));
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

// KEIKO-0601: the field-by-field scalar/runtime checks below (schemaVersion, runId, taskId, kind,
// failureReason, exitCode, durationMs, truncated, timedOut, stdout, stderr) are shared with
// container-runtime.ts's validateContainerRunResult via run-result-validation.ts's
// validateRunResultCore, parameterized by this executor's own schema version, COMMAND_TASK_KINDS and
// COMMAND_FAILURE_REASONS. Only the unknown-key rejection above is command-runner-specific.
export function validateCommandTaskRunResult(value: unknown): CommandTaskRunResultParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  errors.push(...unknownKeys(value, RUN_RESULT_KEYS, "result"));
  validateRunResultCore(
    value,
    {
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      kinds: COMMAND_TASK_KINDS,
      failureReasons: COMMAND_FAILURE_REASONS,
    },
    errors,
  );
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as CommandTaskRunResult };
}
