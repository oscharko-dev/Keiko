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

import { ACTIVITY_LOG_OPERATION_REGISTRY } from "./activity-log-registry.generated.js";
import { containsAbsolutePath } from "./text-safety.js";

export {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  ACTIVITY_LOG_FAILURE_SURFACES,
  ACTIVITY_LOG_OPERATION_SURFACES,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  type ActivityLogFailureSurface,
} from "./activity-log-registry.generated.js";
export { ACTIVITY_LOG_OPERATION_REGISTRY };
// The Activity Log directory's closed file-name grammar travels with the runtime observability
// contract, so every reader that already imports this entry point shares the writer's grammar.
export {
  ACTIVITY_LOG_DIRECTORY_NAME,
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  ACTIVITY_LOG_PIN_ID_PATTERN,
  activityLogPinFileName,
  activityLogSegmentFileName,
  compareActivityLogFileNames,
  formatActivityLogSegmentId,
  isActivityLogOwnedFileName,
  orderActivityLogFileNames,
  parseActivityLogFileName,
  parseActivityLogPinFileName,
  parseActivityLogSegmentId,
  readableActivityLogFileNames,
  type ActivityLogFileName,
  type ActivityLogLegacyArchiveFileName,
  type ActivityLogLegacyCurrentFileName,
  type ActivityLogSegmentFileName,
  type ActivityLogSegmentIdentity,
  type ActivityLogSegmentState,
} from "./activity-log-files.js";
export {
  ACTIVITY_LOG_LOSS_REASONS,
  activityLogLossCounters,
  activityLogLossTotal,
  isActivityLogLossReason,
  recordActivityLogLoss,
  resetActivityLogLossCountersForTests,
  type ActivityLogLossCounters,
  type ActivityLogLossReason,
} from "./activity-log-loss.js";
// The body-free SupportIncident descriptor (#3533) is a selection artifact over this log, so it
// travels with the same runtime entry point instead of a parallel package surface.
export {
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  DEFECT_FINGERPRINT_PATTERN,
  MAX_DEFECT_FINGERPRINT_FRAMES,
  MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS,
  MAX_SUPPORT_INCIDENT_RECORD_BYTES,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
  SUPPORT_INCIDENT_EVIDENCE_INTEGRITY,
  SUPPORT_INCIDENT_ID_PATTERN,
  SUPPORT_INCIDENT_PIN_STATUSES,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  SUPPORT_INCIDENT_STATES,
  SUPPORT_INCIDENT_TRIGGERS,
  SUPPORT_INCIDENT_UNATTRIBUTED,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  defectFingerprintPreimage,
  isDefectFingerprint,
  isSupportIncidentId,
  isSupportIncidentSurface,
  normalizeKeikoFrame,
  normalizeKeikoFrameSignature,
  parseSupportIncidentFileName,
  parseSupportIncidentRecord,
  supportIncidentBuild,
  supportIncidentFileName,
  supportIncidentPrivateProjection,
  supportIncidentPublicProjection,
  type DefectFingerprintInput,
  type SupportIncident,
  type SupportIncidentBuild,
  type SupportIncidentCorrelation,
  type SupportIncidentCoverage,
  type SupportIncidentEvidence,
  type SupportIncidentEvidenceIntegrity,
  type SupportIncidentFingerprint,
  type SupportIncidentPin,
  type SupportIncidentPinStatus,
  type SupportIncidentPrivateProjection,
  type SupportIncidentPublicProjection,
  type SupportIncidentRecord,
  type SupportIncidentSegmentReference,
  type SupportIncidentState,
  type SupportIncidentSufficiency,
  type SupportIncidentSurface,
  type SupportIncidentTrigger,
  type SupportIncidentWindow,
} from "./support-incident.js";

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

export const ACTIVITY_LOG_WRITER_CAPABILITY_STATES = ["active", "degraded", "unavailable"] as const;
export type ActivityLogWriterCapabilityState =
  (typeof ACTIVITY_LOG_WRITER_CAPABILITY_STATES)[number];

// Diagnostic sufficiency of reconstruction evidence (#3532), projected per failure class by
// `keiko support analyze` and carried by support incidents. Closed: an analyzer, an incident and a
// report all speak exactly these statuses and reasons. Insufficient: required evidence or causal
// closure is missing. Degraded: localization and replay remain possible, but a closed warning or a
// bounded loss exists. Complete: neither.
export const DIAGNOSTIC_SUFFICIENCY_STATUSES = ["complete", "degraded", "insufficient"] as const;
export type DiagnosticSufficiencyStatus = (typeof DIAGNOSTIC_SUFFICIENCY_STATUSES)[number];

export const DIAGNOSTIC_SUFFICIENCY_INSUFFICIENT_REASONS = [
  "no-registered-evidence",
  "no-registered-failure",
  "corrupt-evidence",
  "parent-correlation-missing",
  "lifecycle-start-missing",
] as const;

export const DIAGNOSTIC_SUFFICIENCY_DEGRADED_REASONS = [
  "truncated-evidence",
  "unsupported-evidence",
  "incomplete-evidence",
  "sequence-anomaly",
  "activity-log-loss",
  "events-dropped",
  "correlation-unknown",
  "evidence-partial",
] as const;

export const DIAGNOSTIC_SUFFICIENCY_REASONS = [
  ...DIAGNOSTIC_SUFFICIENCY_INSUFFICIENT_REASONS,
  ...DIAGNOSTIC_SUFFICIENCY_DEGRADED_REASONS,
] as const;
export type DiagnosticSufficiencyReason = (typeof DIAGNOSTIC_SUFFICIENCY_REASONS)[number];

const DIAGNOSTIC_SUFFICIENCY_INSUFFICIENT_SET: ReadonlySet<string> = new Set(
  DIAGNOSTIC_SUFFICIENCY_INSUFFICIENT_REASONS,
);

/** The one status rule: any insufficient reason wins, any other reason degrades, none is complete. */
export function diagnosticSufficiencyStatus(
  reasons: readonly DiagnosticSufficiencyReason[],
): DiagnosticSufficiencyStatus {
  if (reasons.some((reason) => DIAGNOSTIC_SUFFICIENCY_INSUFFICIENT_SET.has(reason))) {
    return "insufficient";
  }
  return reasons.length > 0 ? "degraded" : "complete";
}

export function isActivityLogErrorKind(value: unknown): value is ActivityLogErrorKind {
  return (
    typeof value === "string" && (ACTIVITY_LOG_ERROR_KINDS as readonly string[]).includes(value)
  );
}

export function activityLogErrorKindOr(
  value: unknown,
  fallback: ActivityLogErrorKind,
): ActivityLogErrorKind {
  return isActivityLogErrorKind(value) ? value : fallback;
}

// One canonical identity shape is shared by the v2 writer and every compatibility reader. Keep
// these guards in the contracts leaf: accepting a wider identity in a reader than the writer can
// produce makes forged lines look supported, while a narrower writer-side check can make valid
// persisted evidence unreadable. The pid ceiling is the cross-platform signed 32-bit process-id
// contract; seq remains process-wide and is bounded only by JavaScript's safe integer range.
export const ACTIVITY_LOG_IDENTITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export const ACTIVITY_LOG_INSTANCE_ID_PATTERN = /^[a-f0-9]{8}$/u;
export const ACTIVITY_LOG_PLATFORM_CLASS_PATTERN =
  /^(?:darwin|linux|win32|other)-(?:arm64|x64|other)$/u;
export const ACTIVITY_LOG_PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function isActivityLogIdentityDigest(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_IDENTITY_DIGEST_PATTERN.test(value);
}

export function isActivityLogInstanceId(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_INSTANCE_ID_PATTERN.test(value);
}

export function isActivityLogPlatformClass(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_PLATFORM_CLASS_PATTERN.test(value);
}

export function isActivityLogProductVersion(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_PRODUCT_VERSION_PATTERN.test(value);
}

export function isActivityLogProcessId(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  );
}

export function isActivityLogSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

interface ActivityLogFieldContractBase {
  readonly required: boolean;
  readonly maxLength?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly values?: readonly string[] | undefined;
}

// Keep the declared primitive and semantic class coupled. The generated-registry program consumes
// TypeScript diagnostics, so an impossible pair is rejected at generation time rather than becoming
// a runtime contract whose data class can never be enforced coherently.
export type ActivityLogFieldContract = ActivityLogFieldContractBase &
  (
    | { readonly type: "boolean"; readonly dataClass: "closed-enum" }
    | {
        readonly type: "integer";
        readonly dataClass: "count" | "duration" | "safe-version";
      }
    | { readonly type: "number"; readonly dataClass: "count" | "duration" }
    | {
        readonly type: "string";
        readonly dataClass:
          | "closed-enum"
          | "completeness-state"
          | "digest"
          | "error-kind"
          | "loss-state"
          | "opaque-id"
          | "safe-platform-class"
          | "safe-version";
      }
    | {
        readonly type: "string-array";
        readonly dataClass:
          "closed-enum" | "digest" | "error-kind" | "opaque-id" | "safe-platform-class";
      }
  );

// These two fields are part of every persisted v2 operation, not optional per-emitter metadata.
// Centralizing them keeps loss/completeness evidence structurally present while still allowing an
// emitter to override the safe defaults when an operation is partial or a known loss occurred.
export const ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS = {
  completeness: { type: "string", dataClass: "completeness-state", required: true },
  loss: { type: "string", dataClass: "loss-state", required: true },
} as const satisfies Readonly<Record<string, ActivityLogFieldContract>>;

type ActivityLogGlobalFieldContracts = typeof ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS;
type ActivityLogGlobalFieldName = keyof ActivityLogGlobalFieldContracts;

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

export const ACTIVITY_LOG_EXEMPTION_BOUNDARIES = ["platform", "durability"] as const;
export type ActivityLogExemptionBoundary = (typeof ACTIVITY_LOG_EXEMPTION_BOUNDARIES)[number];

// Stable machine categories consumed by the permanent implementation gate. They describe the
// contract obligations, not one epic or one scanner implementation.
export const ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS = [
  "typed-operation-registration",
  "closed-bounded-fields",
  "causal-correlation",
  "lifecycle-evidence",
  "failure-evidence",
  "loss-evidence",
  "analyzer-projection",
  "executable-proof",
  "release-impact",
] as const;
export type ActivityLogImplementationObligation =
  (typeof ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS)[number];

/**
 * Canonical, explicit reconstruction obligations for one registered failure class.
 *
 * This checked-in manifest and the typed operation declarations are the two inputs to the single
 * generated Activity Log registry. The generator validates their exact agreement; it never infers
 * an obligation from the generated catalog or treats observed coverage as its own requirement.
 */
export interface ActivityLogFailureClassContract {
  readonly contractKind: "activity-log-failure-class";
  readonly schemaVersion: 1;
  readonly failureClass: string;
  readonly requiredProductSurfaces: readonly string[];
  readonly requiredLifecycleOperations: Readonly<
    Record<ActivityLogLifecyclePhase, readonly string[]>
  >;
  readonly requiredCausalOperations: readonly string[];
  readonly requiredLossOperations: readonly string[];
  readonly requiredProofOperations: readonly string[];
  readonly requiredReplayProofIds: readonly string[];
  readonly requiredResourceOperations: readonly string[];
  readonly requiredEvidenceClasses: readonly ActivityLogDataClass[];
  readonly requiredFrameOperations: readonly string[];
  readonly requiredCauseOperations: readonly string[];
}

/**
 * A narrowly reviewed exception to one failure-class proof at one registered operation.
 *
 * The shape cannot authorize fields, data classes, unknown operations, silent loss, or incomplete
 * evidence. Those concerns stay governed by the operation schema. The registry generator validates
 * the exact operation/failure-class pair, tracking issue, owner, technical reason, and expiry.
 */
export interface ActivityLogRegistryExemption {
  readonly contractKind: "activity-log-exemption";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly operation: string;
  readonly failureClass: string;
  readonly boundary: ActivityLogExemptionBoundary;
  readonly owner: string;
  readonly reason: string;
  readonly trackingIssue: number;
  readonly expiresOn: string;
}

// Intentionally empty. Any future entry is compiled into the authoritative generated registry and
// must pass its expiry/scope validator; there is no second exemption file or runtime override.
export const ACTIVITY_LOG_REGISTRY_EXEMPTIONS: readonly ActivityLogRegistryExemption[] = [];

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

const ACTIVITY_LOG_OPERATION_BY_OP: ReadonlyMap<string, ActivityLogOperationRegistration> = new Map(
  ACTIVITY_LOG_OPERATION_REGISTRY.map(
    (registration) => [registration.op, registration as ActivityLogOperationRegistration] as const,
  ),
);

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

type RequiredActivityLogFieldNames<
  Fields extends Readonly<Record<string, ActivityLogFieldContract>>,
> = {
  [Name in keyof Fields]: Fields[Name]["required"] extends true ? Name : never;
}[keyof Fields];

type OptionalActivityLogFieldNames<
  Fields extends Readonly<Record<string, ActivityLogFieldContract>>,
> = Exclude<keyof Fields, RequiredActivityLogFieldNames<Fields>>;

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
  Fields extends ActivityLogEventFields<Registration>,
> = Fields & Record<Exclude<keyof Fields, keyof ActivityLogEventFields<Registration>>, never>;

export type ActivityLogEventFields<Registration extends ActivityLogOperationRegistration> = Omit<
  ActivityLogFields<Registration>,
  ActivityLogGlobalFieldName
> &
  Partial<
    Pick<
      ActivityLogFields<Registration>,
      Extract<ActivityLogGlobalFieldName, keyof ActivityLogFields<Registration>>
    >
  >;

const ACTIVITY_LOG_DIGEST_VALUE = /^[a-f0-9]{8,128}$/u;
const ACTIVITY_LOG_REDACTION_MARKER = /^\[(?:dropped|redacted):[a-z-]+\]$/u;
const ACTIVITY_LOG_EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const ACTIVITY_LOG_CREDENTIAL_SHAPES = [
  /^sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{8,}$/u,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/u,
  /^AKIA[A-Z0-9]{16}$/u,
  /^(?:bearer|basic|password|secret|token|api[-_]?key)[-_:][a-z0-9._~+/-]{8,}$/iu,
] as const;
const ACTIVITY_LOG_REDUCER_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "clientNote",
  "diagnosticSummary",
  "path",
  "routeTemplate",
]);
export const ACTIVITY_LOG_FRAME_FIELD_NAME = "frames";
export const ACTIVITY_LOG_CAUSE_CHAIN_FIELD_NAME = "causeChain";

/**
 * The array fields persisted-line redaction reduces element by element and OMITS when nothing
 * survives (an error without Keiko frames, an error without a cause). A registration therefore
 * never declares them required: a required one would make every such failure persist a line that
 * fails its own registration. The op-catalog generator rejects that declaration.
 */
export const ACTIVITY_LOG_OMITTED_WHEN_EMPTY_FIELD_NAMES = [
  ACTIVITY_LOG_FRAME_FIELD_NAME,
  ACTIVITY_LOG_CAUSE_CHAIN_FIELD_NAME,
] as const;

/**
 * The envelope fields the central sink stamps on every persisted record (ADR-0173 D1). Redaction
 * drops a producer field with one of these names before the merge, so a registration never declares
 * one: its value would be silently replaced by the sink's own (a skill catalog digest once persisted
 * as the log format's catalog digest). The op-catalog generator rejects that declaration.
 */
export const ACTIVITY_LOG_RESERVED_FIELD_NAMES = [
  "ts",
  "level",
  "category",
  "op",
  "schemaVersion",
  "registryVersion",
  "schemaDigest",
  "catalogDigest",
  "buildClass",
  "releaseClass",
  "platformClass",
  "productVersion",
  "compatibilityState",
  "writerCapability",
  "pid",
  "instanceId",
  "seq",
] as const;

function isBodyFreeMachineValue(value: string): boolean {
  if (value.length === 0 || value.startsWith("{") || value.startsWith("<")) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function vocabularyFailure(valid: boolean): ActivityLogEventFailureKind | undefined {
  return valid ? undefined : "invalid-field-vocabulary";
}

function bodyFreeStringFailure(value: string): ActivityLogEventFailureKind | undefined {
  if (ACTIVITY_LOG_REDACTION_MARKER.test(value)) return undefined;
  if (!isBodyFreeMachineValue(value)) return "invalid-field-vocabulary";
  // These deliberately narrow shape guards are defense in depth for values whose declared class
  // is an opaque machine token. They prove rejection of representative credential, identity and
  // path forms without claiming universal secret/PII detection or authorizing open-ended content.
  if (
    ACTIVITY_LOG_EMAIL_SHAPE.test(value) ||
    containsAbsolutePath(value) ||
    value.startsWith("~/") ||
    value.startsWith("~\\")
  ) {
    return "invalid-field-vocabulary";
  }
  return vocabularyFailure(!ACTIVITY_LOG_CREDENTIAL_SHAPES.some((pattern) => pattern.test(value)));
}

function semanticStringFailure(
  name: string,
  contract: ActivityLogFieldContract,
  value: string,
): ActivityLogEventFailureKind | undefined {
  switch (contract.dataClass) {
    case "completeness-state":
      return vocabularyFailure(
        (ACTIVITY_LOG_COMPLETENESS_STATES as readonly string[]).includes(value),
      );
    case "loss-state":
      return vocabularyFailure((ACTIVITY_LOG_LOSS_STATES as readonly string[]).includes(value));
    case "digest":
      return vocabularyFailure(ACTIVITY_LOG_DIGEST_VALUE.test(value));
    case "error-kind":
      // ADR-0173 D4 gives this named field a dedicated structural redaction hatch downstream.
      // The shared name keeps the contract and redaction boundary from drifting independently.
      return name === ACTIVITY_LOG_FRAME_FIELD_NAME
        ? bodyFreeStringFailure(value)
        : vocabularyFailure(ERROR_KIND_PATTERN.test(value));
    case "closed-enum":
      return vocabularyFailure(contract.values !== undefined);
    default:
      if (ACTIVITY_LOG_REDUCER_OWNED_FIELDS.has(name)) return undefined;
      return bodyFreeStringFailure(value);
  }
}

function stringFieldFailure(
  name: string,
  contract: ActivityLogFieldContract,
  value: string,
): ActivityLogEventFailureKind | undefined {
  if (contract.maxLength !== undefined && value.length > contract.maxLength) {
    return "invalid-field-bound";
  }
  if (contract.values !== undefined && !contract.values.includes(value)) {
    return "invalid-field-vocabulary";
  }
  return semanticStringFailure(name, contract, value);
}

function stringArrayFailure(
  name: string,
  contract: ActivityLogFieldContract,
  value: readonly unknown[],
): ActivityLogEventFailureKind | undefined {
  if (contract.maxItems !== undefined && value.length > contract.maxItems) {
    return "invalid-field-bound";
  }
  for (const item of value) {
    if (typeof item !== "string") return "invalid-field-type";
    const failure = stringFieldFailure(name, contract, item);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function numberFieldFailure(
  contract: ActivityLogFieldContract,
  value: number,
): ActivityLogEventFailureKind | undefined {
  if (!Number.isFinite(value)) return "invalid-field-type";
  if (contract.type === "integer" && !Number.isSafeInteger(value)) return "invalid-field-type";
  if (
    (contract.dataClass === "count" ||
      contract.dataClass === "duration" ||
      contract.dataClass === "safe-version") &&
    value < 0
  ) {
    return "invalid-field-bound";
  }
  return undefined;
}

function fieldFailure(
  name: string,
  contract: ActivityLogFieldContract,
  value: unknown,
): ActivityLogEventFailureKind | undefined {
  if (contract.type === "boolean")
    return typeof value === "boolean" ? undefined : "invalid-field-type";
  if (contract.type === "string") {
    return typeof value === "string"
      ? stringFieldFailure(name, contract, value)
      : "invalid-field-type";
  }
  if (contract.type === "string-array") {
    return Array.isArray(value) ? stringArrayFailure(name, contract, value) : "invalid-field-type";
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
    const failure = fieldFailure(name, contract, value);
    if (failure !== undefined) throw new ActivityLogEventValidationError(failure);
  }
}

export function activityLogOperationSchema(
  op: string,
): ActivityLogOperationRegistration | undefined {
  return ACTIVITY_LOG_OPERATION_BY_OP.get(op);
}

export function validateActivityLogOperationFields(
  op: string,
  category: string,
  fields: Readonly<Record<string, unknown>>,
): ActivityLogOperationRegistration {
  const registration = activityLogOperationSchema(op);
  if (registration === undefined) {
    throw new ActivityLogEventValidationError("unregistered-operation");
  }
  if (registration.category !== category) {
    throw new ActivityLogEventValidationError("registration-mismatch");
  }
  validateActivityLogFields(registration, fields);
  return registration;
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
export const ACTIVITY_LOG_UNKNOWN_CORRELATION_ID = "unknown-correlation-id";

/** True for a value of the one correlation-id shape every Activity Log envelope accepts. */
export function isActivityLogCorrelationId(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_CORRELATION_ID.test(value);
}

function validOptionalCorrelationId(value: string | undefined): boolean {
  return value === undefined || ACTIVITY_LOG_CORRELATION_ID.test(value);
}

function normalizedCorrelationId(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined) return required ? ACTIVITY_LOG_UNKNOWN_CORRELATION_ID : undefined;
  return ACTIVITY_LOG_CORRELATION_ID.test(value) ? value : ACTIVITY_LOG_UNKNOWN_CORRELATION_ID;
}

function normalizeActivityLogEnvelope(
  registration: ActivityLogOperationRegistration,
  envelope: ActivityLogEventEnvelope,
): ActivityLogEventEnvelope {
  const { correlationId, parentCorrelationId, ...other } = envelope;
  const normalizedCorrelation = normalizedCorrelationId(
    correlationId,
    registration.causal !== "none",
  );
  const normalizedParentCorrelation = normalizedCorrelationId(
    parentCorrelationId,
    registration.causal === "parent-correlation",
  );
  return {
    ...other,
    ...(normalizedCorrelation === undefined ? {} : { correlationId: normalizedCorrelation }),
    ...(normalizedParentCorrelation === undefined
      ? {}
      : { parentCorrelationId: normalizedParentCorrelation }),
  };
}

function validateActivityLogCorrelations(
  registration: ActivityLogOperationRegistration,
  envelope: ActivityLogEventEnvelope,
): void {
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
}

function validateActivityLogOutcome(envelope: ActivityLogEventEnvelope): void {
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

function validateActivityLogEnvelope(
  registration: ActivityLogOperationRegistration,
  envelope: ActivityLogEventEnvelope,
): void {
  if (Object.keys(envelope).some((key) => !ACTIVITY_LOG_ENVELOPE_KEYS.has(key))) {
    throw new ActivityLogEventValidationError("unknown-field");
  }
  validateActivityLogCorrelations(registration, envelope);
  validateActivityLogOutcome(envelope);
}

export function validateActivityLogOperationRecord(
  op: string,
  category: string,
  envelope: ActivityLogEventEnvelope,
  fields: Readonly<Record<string, unknown>>,
): ActivityLogOperationRegistration {
  const registration = validateActivityLogOperationFields(op, category, fields);
  validateActivityLogEnvelope(registration, envelope);
  return registration;
}

export const ACTIVITY_LOG_EVENT_REGISTRATION = Symbol.for(
  "@oscharko-dev/keiko-contracts/activity-log-event-registration",
);

const ACTIVITY_LOG_EVENT_REJECTION = Symbol.for(
  "@oscharko-dev/keiko-contracts/activity-log-event-rejection",
);
const ACTIVITY_LOG_EVENT_FAILURE_KIND_SET: ReadonlySet<unknown> = new Set(
  ACTIVITY_LOG_EVENT_FAILURE_KINDS,
);

export function activityLogEventRegistration(
  event: object,
): ActivityLogOperationRegistration | undefined {
  const registration = (event as Readonly<Record<PropertyKey, unknown>>)[
    ACTIVITY_LOG_EVENT_REGISTRATION
  ];
  return registration !== null && typeof registration === "object"
    ? (registration as ActivityLogOperationRegistration)
    : undefined;
}

/** Marks an event built outside `activityLogEvent()` with its canonical registration. */
export function attachActivityLogEventRegistration<Event extends object>(
  event: Event,
  registration: ActivityLogOperationRegistration | undefined,
): Event {
  if (registration !== undefined) {
    Object.defineProperty(event, ACTIVITY_LOG_EVENT_REGISTRATION, {
      value: registration,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return event;
}

/**
 * Copies an event with a new correlation id. A plain spread drops the non-enumerable registration
 * and rejection markers, which makes the sink misclassify the copy (a rejected event would read as
 * unregistered), so every rebind goes through here.
 */
export function withActivityLogCorrelation<Event extends object>(
  event: Event,
  correlationId: string,
): Event & { readonly correlationId: string } {
  const rebound = attachActivityLogEventRegistration(
    { ...event, correlationId },
    activityLogEventRegistration(event),
  );
  const rejection = activityLogEventRejection(event);
  if (rejection !== undefined) markActivityLogEventRejection(rebound, rejection);
  return rebound;
}

function markActivityLogEventRejection(
  event: object,
  rejection: ActivityLogEventFailureKind,
): void {
  Object.defineProperty(event, ACTIVITY_LOG_EVENT_REJECTION, {
    value: rejection,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function activityLogEventRejection(event: object): ActivityLogEventFailureKind | undefined {
  const rejection: unknown = (event as Readonly<Record<PropertyKey, unknown>>)[
    ACTIVITY_LOG_EVENT_REJECTION
  ];
  return ACTIVITY_LOG_EVENT_FAILURE_KIND_SET.has(rejection)
    ? (rejection as ActivityLogEventFailureKind)
    : undefined;
}

/**
 * True when the persisted-event validation will refuse this event: it carries the body-free
 * rejection sentinel `activityLogEvent` substitutes for invalid fields, or it was never bound to a
 * registration at all. A cheap marker read, so a logger can count the loss before the sink drops it.
 */
export function activityLogEventWillBeRejected(event: object): boolean {
  return (
    activityLogEventRejection(event) !== undefined ||
    activityLogEventRegistration(event) === undefined
  );
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

function registeredOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ActivityLogEventValidationError("invalid-field-type");
  return value;
}

function registeredOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new ActivityLogEventValidationError("invalid-field-type");
  return value;
}

function registeredLevel(value: unknown): ActivityLogEventEnvelope["level"] {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ACTIVITY_LOG_LEVELS.has(value)) {
    throw new ActivityLogEventValidationError("invalid-field-vocabulary");
  }
  return value as ActivityLogEventEnvelope["level"];
}

function registeredErrorKind(value: unknown): ActivityLogErrorKind | undefined {
  if (value === undefined) return undefined;
  if (!isActivityLogErrorKind(value)) {
    throw new ActivityLogEventValidationError("invalid-field-vocabulary");
  }
  return value;
}

function registeredEventEnvelope(
  event: Readonly<Record<PropertyKey, unknown>>,
): ActivityLogEventEnvelope {
  const level = registeredLevel(event.level);
  const correlationId = registeredOptionalString(event.correlationId);
  const parentCorrelationId = registeredOptionalString(event.parentCorrelationId);
  const durationMs = registeredOptionalNumber(event.durationMs);
  const status = registeredOptionalNumber(event.status);
  const errorKind = registeredErrorKind(event.errorKind);
  return {
    ...(level === undefined ? {} : { level }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(status === undefined ? {} : { status }),
    ...(errorKind === undefined ? {} : { errorKind }),
  };
}

function hasExactOwnKeys(left: object, right: object): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = new Set(Reflect.ownKeys(right));
  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameFieldContract(
  left: ActivityLogFieldContract,
  right: ActivityLogFieldContract,
): boolean {
  if (!hasExactOwnKeys(left, right)) return false;
  const valuesMatch =
    left.values === undefined
      ? right.values === undefined
      : right.values !== undefined && sameStringArray(left.values, right.values);
  return (
    left.type === right.type &&
    left.dataClass === right.dataClass &&
    left.required === right.required &&
    left.maxLength === right.maxLength &&
    left.maxItems === right.maxItems &&
    valuesMatch
  );
}

function sameRegistrationFields(
  left: Readonly<Record<string, ActivityLogFieldContract>>,
  right: Readonly<Record<string, ActivityLogFieldContract>>,
): boolean {
  if (!hasExactOwnKeys(left, right)) return false;
  return Object.entries(left).every(([name, contract]) => {
    const canonical = right[name];
    return canonical !== undefined && sameFieldContract(contract, canonical);
  });
}

function runtimeProperty(value: object, key: PropertyKey): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}

function registrationMatchesCanonical(
  registration: ActivityLogOperationRegistration,
  canonical: ActivityLogOperationRegistration,
): boolean {
  try {
    const fixedIdentityMatches =
      runtimeProperty(registration, "contractKind") ===
        runtimeProperty(canonical, "contractKind") &&
      runtimeProperty(registration, "schemaVersion") ===
        runtimeProperty(canonical, "schemaVersion");
    return [
      hasExactOwnKeys(registration, canonical) && fixedIdentityMatches,
      registration.op === canonical.op,
      registration.category === canonical.category,
      registration.owner === canonical.owner,
      registration.emitter === canonical.emitter,
      sameRegistrationFields(registration.fields, canonical.fields),
      registration.causal === canonical.causal,
      registration.lifecycle === canonical.lifecycle,
      registration.analyzerProjection === canonical.analyzerProjection,
      sameStringArray(registration.failureClasses, canonical.failureClasses) &&
        sameStringArray(registration.proofIds, canonical.proofIds),
      registration.releaseImpact === canonical.releaseImpact,
    ].every(Boolean);
  } catch {
    return false;
  }
}

function canonicalRegistrationForEvent(
  event: Readonly<Record<PropertyKey, unknown>>,
): ActivityLogOperationRegistration {
  const canonical = typeof event.op === "string" ? activityLogOperationSchema(event.op) : undefined;
  if (canonical === undefined) {
    throw new ActivityLogEventValidationError("unregistered-operation");
  }
  return canonical;
}

function validateCanonicalRegistration(
  event: Readonly<Record<PropertyKey, unknown>>,
  registration: ActivityLogOperationRegistration,
  canonical: ActivityLogOperationRegistration,
): void {
  if (
    !registrationMatchesCanonical(registration, canonical) ||
    event.op !== canonical.op ||
    event.category !== canonical.category
  ) {
    throw new ActivityLogEventValidationError("registration-mismatch");
  }
}

function registeredEventFields(
  event: Readonly<Record<PropertyKey, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof event.extra !== "object" || event.extra === null || Array.isArray(event.extra)) {
    throw new ActivityLogEventValidationError("fields-not-object");
  }
  return event.extra as Readonly<Record<string, unknown>>;
}

export function validateRegisteredActivityLogEvent(
  candidate: object,
): ActivityLogOperationRegistration {
  // Interface-typed events (ServerLogEvent, SecurityLogEvent, ...) carry no index signature, so the
  // public signature accepts any object and the runtime checks below treat it as an open record.
  const event = candidate as Readonly<Record<PropertyKey, unknown>>;
  const rejection = activityLogEventRejection(event);
  if (rejection !== undefined) throw new ActivityLogEventValidationError(rejection);
  const registration = activityLogEventRegistration(event);
  if (registration === undefined) {
    throw new ActivityLogEventValidationError("unregistered-operation");
  }
  const canonical = canonicalRegistrationForEvent(event);
  validateCanonicalRegistration(event, registration, canonical);
  if (Object.keys(event).some((key) => !ACTIVITY_LOG_EVENT_KEYS.has(key))) {
    throw new ActivityLogEventValidationError("unknown-field");
  }
  validateActivityLogEnvelope(canonical, registeredEventEnvelope(event));
  validateActivityLogFields(canonical, registeredEventFields(event));
  return canonical;
}

type BoundActivityLogEvent<Registration extends ActivityLogOperationRegistration> =
  RegisteredActivityLogEvent<Registration> &
    ActivityLogEventEnvelope & { readonly extra: ActivityLogFields<Registration> };

function rejectedActivityLogEvent<Registration extends ActivityLogOperationRegistration>(
  error: unknown,
): BoundActivityLogEvent<Registration> {
  const rejection =
    error instanceof ActivityLogEventValidationError ? error.kind : "registration-mismatch";
  const event = {
    level: "error",
    category: "diagnostic",
    op: "server-log.write-failed",
    extra: { completeness: "unknown", loss: "event-dropped" },
  };
  markActivityLogEventRejection(event, rejection);
  return event as unknown as BoundActivityLogEvent<Registration>;
}

/**
 * Declares one operation for the generated Activity Log registry. Keep the call at the production
 * emitter; the generator records that exact source site and rejects non-literal declarations.
 */
export function defineActivityLogOperation<
  const Registration extends ActivityLogOperationRegistration,
>(
  registration: Registration,
): Omit<Registration, "fields"> & {
  readonly fields: ActivityLogGlobalFieldContracts & Registration["fields"];
} {
  for (const [name, contract] of Object.entries(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS)) {
    const declared = registration.fields[name];
    if (
      declared !== undefined &&
      (declared.type !== contract.type ||
        declared.dataClass !== contract.dataClass ||
        declared.required !== contract.required ||
        declared.maxLength !== undefined ||
        declared.maxItems !== undefined ||
        declared.values !== undefined)
    ) {
      throw new ActivityLogEventValidationError("registration-mismatch");
    }
  }
  return {
    ...registration,
    fields: { ...ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS, ...registration.fields },
  };
}

/**
 * Binds an emitted field set to its registered operation. Invalid runtime values become a
 * body-free rejection sentinel: the physical sink revalidates it, drops it, and emits the one
 * independent rejection notice without letting observability change the business operation.
 */
export function activityLogEvent<
  const Registration extends ActivityLogOperationRegistration & {
    readonly fields: ActivityLogGlobalFieldContracts;
  },
  const Fields extends ActivityLogEventFields<Registration>,
>(
  registration: Registration,
  envelope: ActivityLogEventEnvelope,
  fields: ExactActivityLogFields<Registration, Fields>,
): BoundActivityLogEvent<Registration> {
  try {
    const normalizedEnvelope = normalizeActivityLogEnvelope(registration, envelope);
    validateActivityLogEnvelope(registration, normalizedEnvelope);
    const normalizedFields = {
      completeness: "complete",
      loss: "none",
      ...fields,
    } as ActivityLogFields<Registration>;
    validateActivityLogFields(registration, normalizedFields);
    const event = {
      ...normalizedEnvelope,
      category: registration.category,
      ["op"]: registration.op,
      extra: normalizedFields,
    };
    return attachActivityLogEventRegistration(event, registration);
  } catch (error) {
    return rejectedActivityLogEvent<Registration>(error);
  }
}
