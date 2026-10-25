import { exactKeys, isRecord } from "./contract-validation-primitives.js";
export { exactKeys, isRecord } from "./contract-validation-primitives.js";
import {
  CODING_WORKBENCH_AUXILIARY_STATUSES,
  CODING_WORKBENCH_CONTENT_TRUST_VALUES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  isCodingWorkbenchNativeRetry,
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

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  const strings: readonly string[] = allowed;
  return typeof value === "string" && strings.includes(value);
}

export function invalid<T>(error: string): CodingWorkbenchValidationResult<T> {
  return { ok: false, errors: [error] };
}

export function validateSafeId(
  value: unknown,
  path: string,
  errors: string[],
  maxChars: number,
): value is string {
  if (typeof value !== "string" || value.length > maxChars || !SAFE_IDENTIFIER.test(value)) {
    errors.push(`${path} must be a bounded safe identifier`);
    return false;
  }
  return true;
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

export function validateStrictUtcInstant(
  value: unknown,
  path: string,
  errors: string[],
): value is string {
  if (
    typeof value !== "string" ||
    !STRICT_UTC_INSTANT.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== (value.includes(".") ? value : `${value.slice(0, -1)}.000Z`)
  ) {
    errors.push(`${path} must be a strict UTC instant`);
    return false;
  }
  return true;
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
    ? [
        ...common,
        "eventKind",
        "auxiliaryOutcome",
        "contentTrust",
        "verificationSummary",
        "nativeRetry",
      ]
    : common;
}

export function validateSseEventFields(
  value: Record<string, unknown>,
  errors: string[],
  idMaxChars: number,
  allowedEventKinds: readonly string[],
): boolean {
  const version = value.schemaVersion === CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  if (!version) errors.push("schemaVersion is invalid");
  const cursor = validateSafeId(value.cursor, "cursor", errors, idMaxChars);
  const sequence = validateNonNegativeSafeInteger(value.sequence, "sequence", errors);
  const occurred = validateStrictUtcInstant(value.occurredAt, "occurredAt", errors);
  const kind = isOneOf(value.kind, allowedEventKinds);
  if (!kind) errors.push("kind is invalid");
  const run = validateSafeId(value.runId, "runId", errors, idMaxChars);
  const state = isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES);
  if (!state) errors.push("state is invalid");
  const revision = validateNonNegativeSafeInteger(value.revision, "revision", errors);
  const event = validateSseEventKind(value, errors);
  const optional = validateSseOptionalEnums(value, errors);
  const verification = validateSseVerificationSummary(value, errors);
  const retry = validateSseNativeRetry(value, errors);
  return [
    version,
    cursor,
    sequence,
    occurred,
    kind,
    run,
    state,
    revision,
    event,
    optional,
    verification,
    retry,
  ].every(Boolean);
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

function validateSseNativeRetry(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.kind === "runtime-event" && value.eventKind === "native-retry-changed") {
    const admitted = value.nativeRetry === null || isCodingWorkbenchNativeRetry(value.nativeRetry);
    if (!admitted) errors.push("nativeRetry must be canonical native retry facts or null");
    return admitted;
  }
  const absent = value.nativeRetry === undefined;
  if (!absent) errors.push("nativeRetry is only admissible on native-retry-changed");
  return absent;
}
function validateSseVerificationSummary(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.verificationSummary === undefined) return true;
  const admitted =
    value.kind === "runtime-event" &&
    value.eventKind === "verification-summarized" &&
    isCodingWorkbenchVerificationSummary(value.verificationSummary);
  if (!admitted) errors.push("verificationSummary is invalid or outside verification-summarized");
  return admitted;
}
// The `eventKind` of a runtime-event frame: an adapter event kind, or one of the SSE-only gateway
// facts (#3873 review), which carry nothing else — no failure code, outcome or trust marker.
function validateSseEventKind(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.kind !== "runtime-event") return true;
  if (isOneOf(value.eventKind, CODING_WORKBENCH_GATEWAY_EVENT_KINDS)) {
    if (
      value.failureCode !== undefined ||
      value.auxiliaryOutcome !== undefined ||
      value.contentTrust !== undefined
    )
      errors.push("a gateway fact carries no failureCode, auxiliaryOutcome or contentTrust");
    return true;
  }
  const admitted = isOneOf(value.eventKind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS);
  if (!admitted) errors.push("eventKind is invalid");
  return admitted;
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

function isTurnFailureCode(value: unknown): value is CodingWorkbenchTurnFailureCode {
  return typeof value === "string" && Object.hasOwn(TURN_FAILURE_CODES, value);
}

// The optional closed-vocabulary fields an SSE frame may carry. Split out of `validateSseEventFields`
// so that function stays inside the repository complexity bound as the vocabulary grows.
function validateSseOptionalEnums(value: Record<string, unknown>, errors: string[]): boolean {
  const outcome =
    value.auxiliaryOutcome === undefined ||
    isOneOf(value.auxiliaryOutcome, CODING_WORKBENCH_AUXILIARY_STATUSES);
  if (!outcome) errors.push("auxiliaryOutcome is invalid");
  const trust = validateSseContentTrust(value, errors);
  const failure =
    value.failureCode === undefined ||
    isOneOf(value.failureCode, CODING_WORKBENCH_RUNTIME_FAILURE_CODES) ||
    (value.eventKind === "failure-redacted" && isTurnFailureCode(value.failureCode));
  if (!failure) errors.push("failureCode is invalid");
  return outcome && trust && failure;
}
// #2637: the SSE boundary mirrors the runtime-event rule rather than merely type-checking the field.
// An accepted `research-performed` frame MUST declare the marker, and no other frame may carry it —
// otherwise the timeline could render a skill invocation or a denied fetch as though it had taken in
// untrusted page content, or render an accepted research read without saying what it took in. Both
// directions are a lie about provenance, so both fail closed.
function validateSseContentTrust(value: Record<string, unknown>, errors: string[]): boolean {
  const isAcceptedResearch =
    value.kind === "runtime-event" &&
    value.eventKind === "research-performed" &&
    value.auxiliaryOutcome === "accepted";
  if (isAcceptedResearch) {
    const admitted = isOneOf(value.contentTrust, CODING_WORKBENCH_CONTENT_TRUST_VALUES);
    if (!admitted) errors.push("contentTrust is required on an accepted research-performed frame");
    return admitted;
  }
  const absent = value.contentTrust === undefined;
  if (!absent)
    errors.push("contentTrust is only admissible on an accepted research-performed frame");
  return absent;
}
function validateNonNegativeSafeInteger(
  value: unknown,
  path: string,
  errors: string[],
): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${path} must be a non-negative safe integer`);
    return false;
  }
  return true;
}

export function validateCodingPhysicalMembers<Member>(
  value: readonly unknown[],
  path: string,
  errors: string[],
  validateMember: (value: unknown, path: string, errors: string[]) => value is Member,
): value is readonly Member[] {
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const memberPath = `${path}[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${memberPath} must be an object`);
      return false;
    }
    const member: unknown = value[index];
    admitted = validateMember(member, memberPath, errors) && admitted;
  }
  return admitted;
}
