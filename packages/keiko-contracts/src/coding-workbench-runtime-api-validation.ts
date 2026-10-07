import {
  CODING_WORKBENCH_AUXILIARY_STATUSES,
  CODING_WORKBENCH_CONTENT_TRUST_VALUES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  type CodingWorkbenchValidationResult,
  type CodingWorkbenchVerificationSummary,
} from "./coding-workbench.js";
import {
  CODING_WORKBENCH_GATEWAY_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  type CodingWorkbenchTurnFailureCode,
} from "./coding-workbench-runtime-constants.js";
import { isVerificationKind } from "./editor-verification.js";
import { stripUnsafeFormatChars } from "./text-safety.js";

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
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  return errors;
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

export function validateUntrustedDisplayText(
  value: unknown,
  maxChars: number,
  options: { readonly minChars?: number | undefined } = {},
): value is string {
  const minChars = options.minChars ?? 1;
  return (
    typeof value === "string" &&
    value.length >= minChars &&
    value.length <= maxChars &&
    stripUnsafeFormatChars(value) === value
  );
}

export function validateStrictUtcInstant(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== "string" ||
    !STRICT_UTC_INSTANT.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== (value.includes(".") ? value : `${value.slice(0, -1)}.000Z`)
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
    ? [...common, "eventKind", "auxiliaryOutcome", "contentTrust", "verificationSummary"]
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
  validateSseEventKind(value, errors);
  validateSseOptionalEnums(value, errors);
  validateSseVerificationSummary(value, errors);
}

export function isCodingWorkbenchVerificationSummary(
  value: unknown,
): value is CodingWorkbenchVerificationSummary {
  if (!isRecord(value)) return false;
  const keys = ["verifierId", "status", "passedCount", "failedCount", "skippedCount", "durationMs"];
  return (
    exactKeys(value, keys, "verificationSummary").length === 0 &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    isVerificationKind(value.verifierId) &&
    isOneOf(value.status, ["passed", "failed", "partial"]) &&
    [value.passedCount, value.failedCount, value.skippedCount].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    ) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

function validateSseVerificationSummary(value: Record<string, unknown>, errors: string[]): void {
  if (value.verificationSummary === undefined) return;
  if (
    value.kind !== "runtime-event" ||
    value.eventKind !== "verification-summarized" ||
    !isCodingWorkbenchVerificationSummary(value.verificationSummary)
  ) {
    errors.push("verificationSummary is invalid or outside verification-summarized");
  }
}

// The `eventKind` of a runtime-event frame: an adapter event kind, or one of the SSE-only gateway
// facts (#3873 review), which carry nothing else — no failure code, outcome or trust marker.
function validateSseEventKind(value: Record<string, unknown>, errors: string[]): void {
  if (value.kind !== "runtime-event") return;
  if (isOneOf(value.eventKind, CODING_WORKBENCH_GATEWAY_EVENT_KINDS)) {
    if (
      value.failureCode !== undefined ||
      value.auxiliaryOutcome !== undefined ||
      value.contentTrust !== undefined
    ) {
      errors.push("a gateway fact carries no failureCode, auxiliaryOutcome or contentTrust");
    }
    return;
  }
  if (!isOneOf(value.eventKind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) {
    errors.push("eventKind is invalid");
  }
}

// The redacted per-turn gateway causes. A Record over the union, so a new cause that is not listed
// here fails the build instead of every frame that carries it failing validation (#3610).
const TURN_FAILURE_CODES: Readonly<Record<CodingWorkbenchTurnFailureCode, true>> = {
  "provider-failed": true,
  "stream-incomplete": true,
  "turn-rejected": true,
  "output-exhausted": true,
  "empty-answer": true,
  "invalid-tool-call": true,
};

function isTurnFailureCode(value: unknown): boolean {
  return typeof value === "string" && Object.hasOwn(TURN_FAILURE_CODES, value);
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
    !isOneOf(value.failureCode, CODING_WORKBENCH_RUNTIME_FAILURE_CODES) &&
    // Non-runtime frames cannot carry eventKind; exactKeys rejects them.
    !(value.eventKind === "failure-redacted" && isTurnFailureCode(value.failureCode))
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
