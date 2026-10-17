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
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface RunResultIdentity<Schema extends string, Kind extends string> {
  readonly schemaVersion: Schema;
  readonly runId: string;
  readonly taskId: string;
  readonly kind: Kind;
}

function checkField(valid: boolean, error: string, errors: string[]): boolean {
  if (!valid) errors.push(error);
  return valid;
}

function validateRunResultIdentity<Schema extends string, Kind extends string>(
  value: Record<string, unknown>,
  expectedSchemaVersion: Schema,
  kinds: readonly Kind[],
  errors: string[],
): value is Record<string, unknown> & RunResultIdentity<Schema, Kind> {
  const schema = checkField(
    value.schemaVersion === expectedSchemaVersion,
    "schemaVersion is invalid",
    errors,
  );
  const run = checkField(isNonEmptyString(value.runId), "runId must be a non-empty string", errors);
  const task = checkField(
    isNonEmptyString(value.taskId),
    "taskId must be a non-empty string",
    errors,
  );
  const kind = checkField(isOneOf(value.kind, kinds), "kind is invalid", errors);
  return schema && run && task && kind;
}

function validateRunResultFailureReason<Reason extends string>(
  value: Record<string, unknown>,
  failureReasons: readonly Reason[],
  errors: string[],
): value is Record<string, unknown> & { readonly failureReason: Reason } {
  return checkField(
    isOneOf(value.failureReason, failureReasons),
    "failureReason is invalid",
    errors,
  );
}

export function validateRunResultNumbers(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & {
  readonly exitCode: number | null;
  readonly durationMs: number;
} {
  const exitCode = value.exitCode;
  const exit = checkField(
    exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode)),
    "exitCode must be an integer or null",
    errors,
  );
  const durationMs = value.durationMs;
  const duration = checkField(
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0,
    "durationMs must be a non-negative finite number",
    errors,
  );
  return exit && duration;
}

export function validateRunResultFlagsAndText(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & {
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
} {
  const truncated = checkField(
    typeof value.truncated === "boolean",
    "truncated must be a boolean",
    errors,
  );
  const timedOut = checkField(
    typeof value.timedOut === "boolean",
    "timedOut must be a boolean",
    errors,
  );
  const stdout = checkField(typeof value.stdout === "string", "stdout must be a string", errors);
  const stderr = checkField(typeof value.stderr === "string", "stderr must be a string", errors);
  return truncated && timedOut && stdout && stderr;
}

export interface RunResultVocabulary<
  Schema extends string = string,
  Kind extends string = string,
  Reason extends string = string,
> {
  readonly schemaVersion: Schema;
  readonly kinds: readonly Kind[];
  readonly failureReasons: readonly Reason[];
}

// Each concrete phase performs its own checks. All phases run eagerly in the original error
// order; the optional executor-owned phase validates its fields immediately after kind.
type CheckedRunResult<Schema extends string, Kind extends string, Reason extends string> = Record<
  string,
  unknown
> &
  RunResultIdentity<Schema, Kind> & {
    readonly failureReason: Reason;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly truncated: boolean;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
  };

export function validateRunResultCore<
  Schema extends string,
  Kind extends string,
  Reason extends string,
  Extra extends Record<string, unknown>,
>(
  value: Record<string, unknown>,
  vocabulary: RunResultVocabulary<Schema, Kind, Reason>,
  errors: string[],
  afterKind: (value: Record<string, unknown>, errors: string[]) => value is Extra,
): value is CheckedRunResult<Schema, Kind, Reason> & Extra;
export function validateRunResultCore<
  Schema extends string,
  Kind extends string,
  Reason extends string,
>(
  value: Record<string, unknown>,
  vocabulary: RunResultVocabulary<Schema, Kind, Reason>,
  errors: string[],
  afterKind?: (value: Record<string, unknown>, errors: string[]) => void,
): value is CheckedRunResult<Schema, Kind, Reason>;
export function validateRunResultCore(
  value: Record<string, unknown>,
  vocabulary: RunResultVocabulary,
  errors: string[],
  afterKind?: (value: Record<string, unknown>, errors: string[]) => boolean | void,
): boolean {
  const identity = validateRunResultIdentity(
    value,
    vocabulary.schemaVersion,
    vocabulary.kinds,
    errors,
  );
  const extra = afterKind === undefined || afterKind(value, errors) !== false;
  const reason = validateRunResultFailureReason(value, vocabulary.failureReasons, errors);
  const numbers = validateRunResultNumbers(value, errors);
  const text = validateRunResultFlagsAndText(value, errors);
  return identity && extra && reason && numbers && text;
}
