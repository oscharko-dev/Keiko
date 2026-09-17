// Shared error-kind classification gate (ADR-0173 D11).
//
// Three packages write an `errorKind` field onto their own activity-log envelope —
// `keiko-server`, `keiko-model-gateway`, `keiko-local-knowledge` — and each classifies an unknown
// thrown value into that field by reading a `code`/`name` property and refusing anything that
// fails a shape gate. Until this module existed, `ERROR_KIND_PATTERN` was declared
// byte-identically in all three, pinned only by a test that diffed the three declarations against
// each other (`scripts/__tests__/error-kind-pattern-drift.test.mjs`, retired in the same change
// that added this file). That test could only ever catch drift AFTER one copy relaxed; it could
// never prevent a fourth copy, in a fourth package, from being declared tomorrow with a wider
// character class. Moving the pattern here — the leaf every other package already depends on
// inward toward, per ADR-0019 — makes that drift structurally impossible: there is exactly one
// declaration, and every writer imports it instead of restating it.
//
// The gate exists because `code` and `name` are PROVIDER- or CALLER-CONTROLLED strings, never
// this repository's: an SDK, a hostile response body, or a bare `Object.assign(new Error(), {
// code: "…" })` call decides them. A conforming value is an identifier, a taxonomy code, or a
// constructor name (`PROXY_BLOCKED_BY_POLICY`, `ECONNREFUSED`, `TypeError`) — never a sentence,
// and never long enough to hide an echoed payload. `errorKind` is an ENVELOPE field, so it
// bypasses the `extra` redaction path entirely: this shape gate is the only thing standing
// between a provider's rejected-input message and a log line an operator will grep in the clear.

export {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
} from "./activity-log-registry.generated.js";

/**
 * The shape an error KIND may take: a leading letter, then up to 63 more letters, digits,
 * underscores, dots, or hyphens — 64 characters total. Long enough for every taxonomy code and
 * constructor name this codebase produces, short enough that a sentence — which starts
 * accumulating spaces and punctuation within a handful of words — cannot pass.
 */
export const ERROR_KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * True when `value` is a string conforming to {@link ERROR_KIND_PATTERN}: an identifier, a
 * taxonomy code, or a constructor name, never a sentence. A type guard so a caller can narrow
 * `unknown` directly instead of re-testing after {@link classifyErrorKind} already did the work.
 */
export function isErrorKind(value: unknown): value is string {
  return typeof value === "string" && ERROR_KIND_PATTERN.test(value);
}

/**
 * Returns `value` unchanged when it is a conforming error kind, else `undefined`. This is the
 * exact shape-gated read every package's `code`/`name` reducer performs on a candidate property —
 * factored out so those reducers delegate to one shared decision instead of each restating the
 * regex test. Reading the property itself (and surviving a hostile accessor that throws) stays the
 * caller's job: this function only judges a value already in hand.
 */
export function classifyErrorKind(value: unknown): string | undefined {
  return isErrorKind(value) ? value : undefined;
}

// Activity Log registry foundation (#3529). These values are deliberately data-only so every
// package can register operations through the contracts leaf without depending on the server.
// The registry generator resolves calls to the two functions below through TypeScript's type
// system; a same-named helper with a different return type is not an Activity Log declaration.
export const ACTIVITY_LOG_FIELD_TYPES = [
  "boolean",
  "integer",
  "number",
  "string",
  "string-array",
] as const;

export type ActivityLogFieldType = (typeof ACTIVITY_LOG_FIELD_TYPES)[number];

export const ACTIVITY_LOG_CATEGORIES = [
  "http",
  "gateway",
  "embedding",
  "indexing",
  "setup",
  "search",
  "memory",
  "security",
  "diagnostic",
  "process",
  "consolidation",
] as const;

export type ActivityLogCategory = (typeof ACTIVITY_LOG_CATEGORIES)[number];

export const ACTIVITY_LOG_DATA_CLASSES = [
  "closed-enum",
  "completeness-state",
  "count",
  "digest",
  "duration",
  "error-kind",
  "loss-state",
  "opaque-id",
  "safe-platform-class",
  "safe-version",
] as const;

export type ActivityLogDataClass = (typeof ACTIVITY_LOG_DATA_CLASSES)[number];

export const ACTIVITY_LOG_COMPLETENESS_STATES = ["complete", "partial", "unknown"] as const;
export type ActivityLogCompletenessState = (typeof ACTIVITY_LOG_COMPLETENESS_STATES)[number];

export const ACTIVITY_LOG_LOSS_STATES = [
  "none",
  "event-dropped",
  "event-location-unknown",
  "publication-unavailable",
] as const;
export type ActivityLogLossState = (typeof ACTIVITY_LOG_LOSS_STATES)[number];

export const ACTIVITY_LOG_ERROR_KINDS = [
  "unknown",
  "internal",
  "invalid-request",
  "validation-failed",
  "permission-denied",
  "authority-denied",
  "unavailable",
  "timeout",
  "cancelled",
  "rate-limited",
  "conflict",
  "unsafe-target",
  "target-exists",
  "target-mutated",
  "open-failed",
  "read-failed",
  "write-failed",
  "durability-failed",
  "publish-unsupported",
] as const;
export type ActivityLogErrorKind = (typeof ACTIVITY_LOG_ERROR_KINDS)[number];

export const ACTIVITY_LOG_COMPATIBILITY_STATES = [
  "supported",
  "legacy-supported",
  "unsupported-version",
  "corrupt",
  "truncated",
  "incomplete",
] as const;
export type ActivityLogCompatibilityState = (typeof ACTIVITY_LOG_COMPATIBILITY_STATES)[number];

export const ACTIVITY_LOG_WRITER_CAPABILITY_STATES = [
  "active",
  "degraded",
  "unavailable",
] as const;
export type ActivityLogWriterCapabilityState =
  (typeof ACTIVITY_LOG_WRITER_CAPABILITY_STATES)[number];

export function isActivityLogErrorKind(value: unknown): value is ActivityLogErrorKind {
  return (
    typeof value === "string" &&
    (ACTIVITY_LOG_ERROR_KINDS as readonly string[]).includes(value)
  );
}

export interface ActivityLogFieldContract {
  readonly type: ActivityLogFieldType;
  readonly dataClass: ActivityLogDataClass;
  readonly required: boolean;
  readonly maxLength?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly values?: readonly string[] | undefined;
}

export const ACTIVITY_LOG_LIFECYCLE_PHASES = ["start", "state", "end", "failure", "loss"] as const;
export type ActivityLogLifecyclePhase = (typeof ACTIVITY_LOG_LIFECYCLE_PHASES)[number];

export const ACTIVITY_LOG_ANALYZER_PROJECTIONS = [
  "timeline",
  "process-lifecycle",
  "failure-cluster",
  "capability",
] as const;
export type ActivityLogAnalyzerProjection = (typeof ACTIVITY_LOG_ANALYZER_PROJECTIONS)[number];

export const ACTIVITY_LOG_RELEASE_IMPACTS = ["none", "patch", "minor", "major"] as const;
export type ActivityLogReleaseImpact = (typeof ACTIVITY_LOG_RELEASE_IMPACTS)[number];

export interface ActivityLogOperationRegistration {
  readonly contractKind: "activity-log-operation";
  readonly schemaVersion: 1;
  readonly op: string;
  readonly category: ActivityLogCategory;
  readonly owner: string;
  readonly emitter: string;
  readonly fields: Readonly<Record<string, ActivityLogFieldContract>>;
  readonly causal: "none" | "correlation" | "parent-correlation";
  readonly lifecycle: ActivityLogLifecyclePhase;
  readonly analyzerProjection: ActivityLogAnalyzerProjection;
  readonly failureClasses: readonly string[];
  readonly proofIds: readonly string[];
  readonly releaseImpact: ActivityLogReleaseImpact;
}

export interface RegisteredActivityLogEvent<
  Registration extends ActivityLogOperationRegistration = ActivityLogOperationRegistration,
> {
  readonly category: Registration["category"];
  readonly op: Registration["op"];
}

export const ACTIVITY_LOG_EVENT_FAILURE_KINDS = [
  "unregistered-operation",
  "registration-mismatch",
  "missing-identity",
  "invalid-identity",
  "fields-not-object",
  "missing-field",
  "unknown-field",
  "invalid-field-type",
  "invalid-field-bound",
  "invalid-field-vocabulary",
] as const;

export type ActivityLogEventFailureKind = (typeof ACTIVITY_LOG_EVENT_FAILURE_KINDS)[number];

export class ActivityLogEventValidationError extends Error {
  public readonly kind: ActivityLogEventFailureKind;

  public constructor(kind: ActivityLogEventFailureKind) {
    super("activity-log-event-invalid");
    this.name = "ActivityLogEventValidationError";
    this.kind = kind;
  }
}

export interface ActivityLogEventEnvelope {
  readonly level?: "debug" | "info" | "warn" | "error" | undefined;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: ActivityLogErrorKind | undefined;
}

type ActivityLogPrimitiveValue<Contract extends ActivityLogFieldContract> =
  Contract["type"] extends "boolean"
    ? boolean
    : Contract["type"] extends "integer" | "number"
      ? number
      : Contract["type"] extends "string-array"
        ? readonly string[]
        : string;

type ActivityLogFieldValue<Contract extends ActivityLogFieldContract> =
  Contract["dataClass"] extends "completeness-state"
    ? ActivityLogCompletenessState
    : Contract["dataClass"] extends "loss-state"
      ? ActivityLogLossState
      : Contract["type"] extends "string-array"
        ? Contract["values"] extends readonly string[]
          ? readonly Contract["values"][number][]
          : readonly string[]
        : Contract["values"] extends readonly string[]
          ? Contract["values"][number]
          : ActivityLogPrimitiveValue<Contract>;

type RequiredActivityLogFieldNames<Fields extends Readonly<Record<string, ActivityLogFieldContract>>> = {
  [Name in keyof Fields]: Fields[Name]["required"] extends true ? Name : never;
}[keyof Fields];

type OptionalActivityLogFieldNames<Fields extends Readonly<Record<string, ActivityLogFieldContract>>> =
  Exclude<keyof Fields, RequiredActivityLogFieldNames<Fields>>;

export type ActivityLogFields<Registration extends ActivityLogOperationRegistration> = {
  readonly [Name in RequiredActivityLogFieldNames<Registration["fields"]>]: ActivityLogFieldValue<
    Registration["fields"][Name]
  >;
} & {
  readonly [Name in OptionalActivityLogFieldNames<Registration["fields"]>]?: ActivityLogFieldValue<
    Registration["fields"][Name]
  >;
};

type ExactActivityLogFields<
  Registration extends ActivityLogOperationRegistration,
  Fields extends ActivityLogFields<Registration>,
> = Fields & Record<Exclude<keyof Fields, keyof ActivityLogFields<Registration>>, never>;

function stringFieldFailure(
  contract: ActivityLogFieldContract,
  value: string,
): ActivityLogEventFailureKind | undefined {
  if (contract.maxLength !== undefined && value.length > contract.maxLength) {
    return "invalid-field-bound";
  }
  if (contract.values !== undefined && !contract.values.includes(value)) {
    return "invalid-field-vocabulary";
  }
  if (
    contract.dataClass === "completeness-state" &&
    !(ACTIVITY_LOG_COMPLETENESS_STATES as readonly string[]).includes(value)
  ) {
    return "invalid-field-vocabulary";
  }
  if (
    contract.dataClass === "loss-state" &&
    !(ACTIVITY_LOG_LOSS_STATES as readonly string[]).includes(value)
  ) {
    return "invalid-field-vocabulary";
  }
  return undefined;
}

function stringArrayFailure(
  contract: ActivityLogFieldContract,
  value: readonly unknown[],
): ActivityLogEventFailureKind | undefined {
  if (contract.maxItems !== undefined && value.length > contract.maxItems) {
    return "invalid-field-bound";
  }
  for (const item of value) {
    if (typeof item !== "string") return "invalid-field-type";
    const failure = stringFieldFailure(contract, item);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function numberFieldFailure(
  contract: ActivityLogFieldContract,
  value: number,
): ActivityLogEventFailureKind | undefined {
  if (!Number.isFinite(value)) return "invalid-field-type";
  if (contract.type === "integer" && !Number.isInteger(value)) return "invalid-field-type";
  if ((contract.dataClass === "count" || contract.dataClass === "duration") && value < 0) {
    return "invalid-field-bound";
  }
  return undefined;
}

function fieldFailure(
  contract: ActivityLogFieldContract,
  value: unknown,
): ActivityLogEventFailureKind | undefined {
  if (contract.type === "boolean") return typeof value === "boolean" ? undefined : "invalid-field-type";
  if (contract.type === "string") {
    return typeof value === "string" ? stringFieldFailure(contract, value) : "invalid-field-type";
  }
  if (contract.type === "string-array") {
    return Array.isArray(value) ? stringArrayFailure(contract, value) : "invalid-field-type";
  }
  return typeof value === "number" ? numberFieldFailure(contract, value) : "invalid-field-type";
}

function validateActivityLogFields(
  registration: ActivityLogOperationRegistration,
  fields: Readonly<Record<string, unknown>>,
): void {
  const expected = registration.fields;
  for (const name of Object.keys(fields)) {
    if (expected[name] === undefined) throw new ActivityLogEventValidationError("unknown-field");
  }
  for (const [name, contract] of Object.entries(expected)) {
    const value = fields[name];
    if (value === undefined) {
      if (contract.required) throw new ActivityLogEventValidationError("missing-field");
      continue;
    }
    const failure = fieldFailure(contract, value);
    if (failure !== undefined) throw new ActivityLogEventValidationError(failure);
  }
}

const ACTIVITY_LOG_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "level",
  "correlationId",
  "parentCorrelationId",
  "durationMs",
  "status",
  "errorKind",
]);
const ACTIVITY_LOG_CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/u;

function validOptionalCorrelationId(value: string | undefined): boolean {
  return value === undefined || ACTIVITY_LOG_CORRELATION_ID.test(value);
}

function validateActivityLogEnvelope(
  registration: ActivityLogOperationRegistration,
  envelope: ActivityLogEventEnvelope,
): void {
  if (Object.keys(envelope).some((key) => !ACTIVITY_LOG_ENVELOPE_KEYS.has(key))) {
    throw new ActivityLogEventValidationError("unknown-field");
  }
  if (!validOptionalCorrelationId(envelope.correlationId)) {
    throw new ActivityLogEventValidationError("invalid-field-bound");
  }
  if (!validOptionalCorrelationId(envelope.parentCorrelationId)) {
    throw new ActivityLogEventValidationError("invalid-field-bound");
  }
  if (registration.causal !== "none" && envelope.correlationId === undefined) {
    throw new ActivityLogEventValidationError("missing-field");
  }
  if (registration.causal === "parent-correlation" && envelope.parentCorrelationId === undefined) {
    throw new ActivityLogEventValidationError("missing-field");
  }
  if (envelope.errorKind !== undefined && !isActivityLogErrorKind(envelope.errorKind)) {
    throw new ActivityLogEventValidationError("invalid-field-vocabulary");
  }
  if (
    envelope.durationMs !== undefined &&
    (!Number.isFinite(envelope.durationMs) || envelope.durationMs < 0)
  ) {
    throw new ActivityLogEventValidationError("invalid-field-bound");
  }
  if (envelope.status !== undefined && !Number.isInteger(envelope.status)) {
    throw new ActivityLogEventValidationError("invalid-field-type");
  }
}

export const ACTIVITY_LOG_EVENT_REGISTRATION = Symbol.for(
  "@oscharko-dev/keiko-contracts/activity-log-event-registration",
);

export function activityLogEventRegistration(
  event: Readonly<Record<PropertyKey, unknown>>,
): ActivityLogOperationRegistration | undefined {
  const registration = event[ACTIVITY_LOG_EVENT_REGISTRATION];
  return registration !== null && typeof registration === "object"
    ? (registration as ActivityLogOperationRegistration)
    : undefined;
}

const ACTIVITY_LOG_EVENT_KEYS: ReadonlySet<string> = new Set([
  "level",
  "category",
  "op",
  "correlationId",
  "parentCorrelationId",
  "durationMs",
  "status",
  "errorKind",
  "extra",
]);

const ACTIVITY_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function registeredEventEnvelope(
  event: Readonly<Record<PropertyKey, unknown>>,
): ActivityLogEventEnvelope {
  if (event.correlationId !== undefined && typeof event.correlationId !== "string") {
    throw new ActivityLogEventValidationError("invalid-field-type");
  }
  if (event.parentCorrelationId !== undefined && typeof event.parentCorrelationId !== "string") {
    throw new ActivityLogEventValidationError("invalid-field-type");
  }
  if (event.level !== undefined && !ACTIVITY_LOG_LEVELS.has(String(event.level))) {
    throw new ActivityLogEventValidationError("invalid-field-vocabulary");
  }
  if (event.errorKind !== undefined && !isActivityLogErrorKind(event.errorKind)) {
    throw new ActivityLogEventValidationError("invalid-field-vocabulary");
  }
  if (event.durationMs !== undefined && typeof event.durationMs !== "number") {
    throw new ActivityLogEventValidationError("invalid-field-type");
  }
  if (event.status !== undefined && typeof event.status !== "number") {
    throw new ActivityLogEventValidationError("invalid-field-type");
  }
  return {
    ...(event.level !== undefined ? { level: event.level as ActivityLogEventEnvelope["level"] } : {}),
    ...(typeof event.correlationId === "string" ? { correlationId: event.correlationId } : {}),
    ...(typeof event.parentCorrelationId === "string"
      ? { parentCorrelationId: event.parentCorrelationId }
      : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    ...(typeof event.status === "number" ? { status: event.status } : {}),
    ...(isActivityLogErrorKind(event.errorKind) ? { errorKind: event.errorKind } : {}),
  };
}

export function validateRegisteredActivityLogEvent(
  event: Readonly<Record<PropertyKey, unknown>>,
): ActivityLogOperationRegistration {
  const registration = activityLogEventRegistration(event);
  if (registration === undefined) {
    throw new ActivityLogEventValidationError("unregistered-operation");
  }
  if (event.op !== registration.op || event.category !== registration.category) {
    throw new ActivityLogEventValidationError("registration-mismatch");
  }
  if (Object.keys(event).some((key) => !ACTIVITY_LOG_EVENT_KEYS.has(key))) {
    throw new ActivityLogEventValidationError("unknown-field");
  }
  validateActivityLogEnvelope(registration, registeredEventEnvelope(event));
  if (typeof event.extra !== "object" || event.extra === null || Array.isArray(event.extra)) {
    throw new ActivityLogEventValidationError("fields-not-object");
  }
  validateActivityLogFields(registration, event.extra as Readonly<Record<string, unknown>>);
  return registration;
}

/**
 * Declares one operation for the generated Activity Log registry. Keep the call at the production
 * emitter; the generator records that exact source site and rejects non-literal declarations.
 */
export function defineActivityLogOperation<
  const Registration extends ActivityLogOperationRegistration,
>(registration: Registration): Registration {
  return registration;
}

/**
 * Binds an emitted field set to its registered operation. Runtime schema validation is added at
 * the owning serializer in the next migration slice; this typed binding lets discovery fail
 * closed now instead of inferring operations from unrelated object literals.
 */
export function activityLogEvent<
  const Registration extends ActivityLogOperationRegistration,
  const Fields extends ActivityLogFields<Registration>,
>(
  registration: Registration,
  envelope: ActivityLogEventEnvelope,
  fields: ExactActivityLogFields<Registration, Fields>,
): RegisteredActivityLogEvent<Registration> &
  ActivityLogEventEnvelope & { readonly extra: ActivityLogFields<Registration> } {
  validateActivityLogEnvelope(registration, envelope);
  validateActivityLogFields(registration, fields);
  const event = {
    ...envelope,
    category: registration.category,
    ["op"]: registration.op,
    extra: fields,
  };
  Object.defineProperty(event, ACTIVITY_LOG_EVENT_REGISTRATION, {
    value: registration,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return event;
}
