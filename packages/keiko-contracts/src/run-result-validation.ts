// Shared internal run-result field validators for the governed task-execution wire contracts
// (KEIKO-0601). command-runner.ts and container-runtime.ts each parse an independent executor's
// run-result shape, but the mechanical field-by-field checks for the fields both shapes share
// (schemaVersion, runId, taskId, kind, failureReason, exitCode, durationMs, truncated, timedOut,
// stdout, stderr) were re-declared byte-for-byte (or near-byte-for-byte) in both files. This module
// is the one place that logic lives; each executor supplies its OWN schema-version literal, kind
// vocabulary and failure-reason vocabulary (`COMMAND_FAILURE_REASONS` and `CONTAINER_FAILURE_REASONS`
// stay legitimately separate enums — only the checking mechanics are shared) plus an optional hook
// for a field it validates in between `kind` and `failureReason` (container-runtime's `engine`).
//
// Leaf-package rules (ADR-0019): no imports, no IO, no clock, no randomness. Intentionally NOT
// re-exported from index.ts — this is internal wiring between two sibling files in this package,
// not a public contract.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateRunResultIdentity(
  value: Record<string, unknown>,
  expectedSchemaVersion: string,
  kinds: readonly string[],
  errors: string[],
): void {
  if (value.schemaVersion !== expectedSchemaVersion) errors.push("schemaVersion is invalid");
  if (!isNonEmptyString(value.runId)) errors.push("runId must be a non-empty string");
  if (!isNonEmptyString(value.taskId)) errors.push("taskId must be a non-empty string");
  if (!isOneOf(value.kind, kinds)) errors.push("kind is invalid");
}

function validateRunResultFailureReason(
  value: Record<string, unknown>,
  failureReasons: readonly string[],
  errors: string[],
): void {
  if (!isOneOf(value.failureReason, failureReasons)) errors.push("failureReason is invalid");
}

export function validateRunResultNumbers(value: Record<string, unknown>, errors: string[]): void {
  const exitCode = value.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    errors.push("exitCode must be an integer or null");
  }
  const durationMs = value.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    errors.push("durationMs must be a non-negative finite number");
  }
}

export function validateRunResultFlagsAndText(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (typeof value.truncated !== "boolean") errors.push("truncated must be a boolean");
  if (typeof value.timedOut !== "boolean") errors.push("timedOut must be a boolean");
  if (typeof value.stdout !== "string") errors.push("stdout must be a string");
  if (typeof value.stderr !== "string") errors.push("stderr must be a string");
}

// Each executor supplies its own schema-version literal and its own kind/failure-reason
// vocabulary (e.g. COMMAND_TASK_KINDS vs. CONTAINER_TASK_KINDS); the vocabulary is intentionally
// widened to `string`/`readonly string[]` here rather than kept generic, since nothing downstream
// of this internal validator needs the narrowed literal type back (only `boolean` error-collection
// side effects are observable) and a single-use type parameter is flagged as unnecessary
// (@typescript-eslint/no-unnecessary-type-parameters).
export interface RunResultVocabulary {
  readonly schemaVersion: string;
  readonly kinds: readonly string[];
  readonly failureReasons: readonly string[];
}

// Composes the full common field set in the fixed order both executors' tests pin: schemaVersion,
// runId, taskId, kind, [an executor's own mid-sequence fields via `afterKind`, e.g. container-
// runtime's `engine`], failureReason, exitCode, durationMs, truncated, timedOut, stdout, stderr.
export function validateRunResultCore(
  value: Record<string, unknown>,
  vocabulary: RunResultVocabulary,
  errors: string[],
  afterKind?: (value: Record<string, unknown>, errors: string[]) => void,
): void {
  validateRunResultIdentity(value, vocabulary.schemaVersion, vocabulary.kinds, errors);
  afterKind?.(value, errors);
  validateRunResultFailureReason(value, vocabulary.failureReasons, errors);
  validateRunResultNumbers(value, errors);
  validateRunResultFlagsAndText(value, errors);
}
