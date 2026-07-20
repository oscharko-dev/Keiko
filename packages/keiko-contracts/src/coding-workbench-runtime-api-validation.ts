import {
  CODING_WORKBENCH_AUXILIARY_STATUSES,
  CODING_WORKBENCH_CONTENT_TRUST_VALUES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
} from "./coding-workbench-runtime.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
}

export function result<T>(value: unknown, errors: string[]): CodingWorkbenchValidationResult<T> {
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

export function invalid<T>(error: string): CodingWorkbenchValidationResult<T> {
  return { ok: false, errors: [error] };
}

export function validateSafeId(
  value: unknown,
  path: string,
  errors: string[],
  maxChars: number,
): void {
  if (typeof value !== "string" || value.length > maxChars || !SAFE_IDENTIFIER.test(value)) {
    errors.push(`${path} must be a bounded safe identifier`);
  }
}

export function validateStrictUtcInstant(value: unknown, path: string, errors: string[]): void {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const normalized =
    typeof value === "string" && !value.includes(".") ? `${value.slice(0, -1)}.000Z` : value;
  if (
    typeof value !== "string" ||
    !STRICT_UTC_INSTANT.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== normalized
  ) {
    errors.push(`${path} must be a strict UTC instant`);
  }
}

export function sseEventKeys(kind: unknown): readonly string[] {
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
  return kind === "runtime-event"
    ? [...common, "eventKind", "auxiliaryOutcome", "contentTrust"]
    : common;
}

export function validateSseEventFields(
  value: Record<string, unknown>,
  errors: string[],
  idMaxChars: number,
  allowedEventKinds: readonly string[],
): void {
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  validateSafeId(value.cursor, "cursor", errors, idMaxChars);
  validateNonNegativeSafeInteger(value.sequence, "sequence", errors);
  validateStrictUtcInstant(value.occurredAt, "occurredAt", errors);
  if (!isOneOf(value.kind, allowedEventKinds)) errors.push("kind is invalid");
  validateSafeId(value.runId, "runId", errors, idMaxChars);
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) errors.push("state is invalid");
  validateNonNegativeSafeInteger(value.revision, "revision", errors);
  if (
    value.kind === "runtime-event" &&
    !isOneOf(value.eventKind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)
  ) {
    errors.push("eventKind is invalid");
  }
  validateSseOptionalEnums(value, errors);
}

// The optional closed-vocabulary fields an SSE frame may carry. Split out of `validateSseEventFields`
// so that function stays inside the repository complexity bound as the vocabulary grows.
function validateSseOptionalEnums(value: Record<string, unknown>, errors: string[]): void {
  if (
    value.auxiliaryOutcome !== undefined &&
    !isOneOf(value.auxiliaryOutcome, CODING_WORKBENCH_AUXILIARY_STATUSES)
  ) {
    errors.push("auxiliaryOutcome is invalid");
  }
  validateSseContentTrust(value, errors);
  if (
    value.failureCode !== undefined &&
    !isOneOf(value.failureCode, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)
  ) {
    errors.push("failureCode is invalid");
  }
}

// #2637: the SSE boundary mirrors the runtime-event rule rather than merely type-checking the field.
// An accepted `research-performed` frame MUST declare the marker, and no other frame may carry it —
// otherwise the timeline could render a skill invocation or a denied fetch as though it had taken in
// untrusted page content, or render an accepted research read without saying what it took in. Both
// directions are a lie about provenance, so both fail closed.
function validateSseContentTrust(value: Record<string, unknown>, errors: string[]): void {
  const isAcceptedResearch =
    value.kind === "runtime-event" &&
    value.eventKind === "research-performed" &&
    value.auxiliaryOutcome === "accepted";
  if (isAcceptedResearch) {
    if (!isOneOf(value.contentTrust, CODING_WORKBENCH_CONTENT_TRUST_VALUES)) {
      errors.push("contentTrust is required on an accepted research-performed frame");
    }
    return;
  }
  if (value.contentTrust !== undefined) {
    errors.push("contentTrust is only admissible on an accepted research-performed frame");
  }
}

function validateNonNegativeSafeInteger(value: unknown, path: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    errors.push(`${path} must be a non-negative safe integer`);
  }
}
