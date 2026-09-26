import { captureCatalogJson, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import {
  TOOL_CATALOG_LIMITS,
  TOOL_RESULT_REASONS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  TOOL_HANDLER_READINESS,
  captureToolInvocationReceipt,
  toolLifecyclePhaseFor,
  type ToolLifecycleEvent,
  type ToolLifecyclePhase,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  activityLogEvent,
  defineActivityLogOperation,
  isErrorKind,
  recordActivityLogLoss,
  type ActivityLogErrorKind,
  type ActivityLogEventEnvelope,
  type ActivityLogEventFields,
  type ActivityLogFieldContract,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isValidCorrelationId } from "../correlation.js";
import { redactLogFields } from "../observability/log-redaction.js";
import type { ServerLogSink } from "../observability/server-log.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";

const BASE_FIELDS = ["op", "correlationId", "catalogRevision", "profile", "projectionDigest"];
const PHASE_FIELDS = {
  projection: ["readiness"],
  "bind-ready": ["readiness", "handlerSetDigest"],
  "bind-unavailable": ["readiness", "reason"],
  "invocation-started": ["invocationId", "toolRef", "state", "reservationId", "reason"],
  terminal: [
    "invocationId",
    "toolRef",
    "status",
    "reason",
    "durationMs",
    "settlementId",
    "effectStarted",
    "budgetDisposition",
    "reservationId",
  ],
  discarded: ["invocationId", "toolRef", "settlementId", "reason"],
} as const;
const TERMINAL_OPTIONAL = [
  "inputBytes",
  "outputBytes",
  "resultCount",
  "truncated",
  "errorKind",
  "frames",
  "causeChain",
];
const DIGEST_FIELDS = new Set(["catalogRevision", "projectionDigest", "handlerSetDigest"]);
const ID_FIELDS = new Set(["invocationId", "reservationId", "settlementId"]);
const METRIC_FIELDS = new Set(["durationMs", "inputBytes", "outputBytes", "resultCount"]);
const TOKEN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const READINESS: ReadonlySet<string> = new Set(TOOL_HANDLER_READINESS);

const HANDLER_FAILURE_REASONS = [
  "handler-unavailable",
  "handler-mismatch",
  "handler-failed",
  "result-contract-failed",
  "effect-outcome-unknown",
  "budget-port-failed",
] as const;
const AUTHORITY_VALIDITY_REASONS = [
  "authority-invalid",
  "authority-expired",
  "authority-revoked",
  "hard-denial",
] as const;
const TOOL_SELECTION_REASONS = [
  "unknown-tool",
  "unoffered-tool",
  "ambiguous-alias",
  "invalid-arguments",
  "version-mismatch",
  "projection-mismatch",
  "unsupported-capability",
] as const;
const APPROVAL_AND_SCOPE_REASONS = [
  "approval-required",
  "approval-rejected",
  "budget-exhausted",
  "workspace-denied",
  "effect-denied",
] as const;
const STATE_CONTINUITY_REASONS = [
  "cursor-invalid",
  "cursor-expired",
  "cursor-replayed",
  "workspace-stale",
  "replay-conflict",
  "recovery-required",
] as const;
const IN_FLIGHT_TERMINATION_REASONS = [
  "invocation-in-flight",
  "capacity-exhausted",
  "explicit-cancellation",
  "parent-cancelled",
  "deadline-exceeded",
] as const;
const BIND_UNAVAILABLE_REASON_VALUES = [
  ...AUTHORITY_VALIDITY_REASONS,
  ...APPROVAL_AND_SCOPE_REASONS,
  ...TOOL_SELECTION_REASONS,
  ...STATE_CONTINUITY_REASONS,
  ...HANDLER_FAILURE_REASONS,
] as const;
const INVOCATION_SETTLED_REASON_VALUES = [
  "none",
  ...AUTHORITY_VALIDITY_REASONS,
  ...APPROVAL_AND_SCOPE_REASONS,
  ...TOOL_SELECTION_REASONS,
  ...STATE_CONTINUITY_REASONS,
  ...IN_FLIGHT_TERMINATION_REASONS,
  ...HANDLER_FAILURE_REASONS,
] as const;
const BIND_REASONS: ReadonlySet<string> = new Set(BIND_UNAVAILABLE_REASON_VALUES);

type ToolCatalogOperationHeader = Pick<
  ActivityLogOperationRegistration,
  "contractKind" | "schemaVersion"
>;
type ToolCatalogOperationOwnership = Pick<ActivityLogOperationRegistration, "category" | "owner">;

const TOOL_CATALOG_OPERATION_HEADER = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
} as const satisfies ToolCatalogOperationHeader;
const TOOL_CATALOG_OPERATION_OWNERSHIP = {
  category: "security",
  owner: "keiko-server",
} as const satisfies ToolCatalogOperationOwnership;

const TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS = {
  catalogRevision: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  profileId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
  profileVersion: { type: "integer", dataClass: "count", required: true },
  projectionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
} as const satisfies Readonly<Record<string, ActivityLogFieldContract>>;

const TOOL_CATALOG_PROJECTION_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.projection",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeProjection",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    readiness: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ready", "unavailable", "dry-run", "unsupported", "mismatch"],
    },
    resultCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["tool-catalog-projection"],
  proofIds: ["tool-catalog.projection.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_BIND_READY_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.bind-ready",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeBindingReady",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    readiness: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ready"],
    },
    handlerSetDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["tool-catalog-binding"],
  proofIds: ["tool-catalog.bind-ready.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_BIND_UNAVAILABLE_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.bind-unavailable",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeBindingUnavailable",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    readiness: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unavailable", "dry-run", "unsupported", "mismatch"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: BIND_UNAVAILABLE_REASON_VALUES,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "capability",
  failureClasses: ["tool-catalog-binding-unavailable"],
  proofIds: ["tool-catalog.bind-unavailable.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_INVOCATION_STARTED_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.invocation-started",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeInvocationStarted",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    invocationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    toolCanonicalId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    toolContractVersion: { type: "integer", dataClass: "count", required: true },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none"],
    },
    reservationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["tool-catalog-invocation"],
  proofIds: ["tool-catalog.invocation-started.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_INVOCATION_SETTLED_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.invocation-settled",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeInvocationSettled",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    invocationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    toolCanonicalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    toolContractVersion: { type: "integer", dataClass: "count", required: false },
    toolRefCompleteness: { type: "string", dataClass: "completeness-state", required: true },
    settlementId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reservationId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    reservationState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["reserved", "not-reserved"],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "denied", "invalid", "busy", "cancelled", "timeout", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: INVOCATION_SETTLED_REASON_VALUES,
    },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    effectStarted: { type: "boolean", dataClass: "closed-enum", required: true },
    budgetDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["committed", "released", "not-reserved", "commit-uncertain", "release-uncertain"],
    },
    inputBytes: { type: "integer", dataClass: "count", required: false },
    outputBytes: { type: "integer", dataClass: "count", required: false },
    resultCount: { type: "integer", dataClass: "count", required: false },
    truncated: { type: "boolean", dataClass: "closed-enum", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["tool-catalog-invocation-settlement"],
  proofIds: ["tool-catalog.invocation-settled.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_COMPLETION_DISCARDED_OPERATION = defineActivityLogOperation({
  ...TOOL_CATALOG_OPERATION_HEADER,
  op: "tool-catalog.completion-discarded",
  ...TOOL_CATALOG_OPERATION_OWNERSHIP,
  emitter: "tool-catalog.catalogToolLifecycle.writeCompletionDiscarded",
  fields: {
    ...TOOL_CATALOG_IDENTITY_FIELD_CONTRACTS,
    invocationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    toolCanonicalId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    toolContractVersion: { type: "integer", dataClass: "count", required: true },
    settlementId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["late-completion"],
    },
    lossState: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["tool-catalog-late-completion"],
  proofIds: ["tool-catalog.completion-discarded.emitted-line"],
  releaseImpact: "patch",
});

function requireLifecycle(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid tool lifecycle evidence");
}
function object(value: CatalogJsonValue | undefined): CatalogJsonObject {
  requireLifecycle(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as CatalogJsonObject;
}
function exactKeys(
  value: CatalogJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  requireLifecycle(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => allowed.has(key)),
  );
}
function validProfile(value: CatalogJsonValue | undefined): boolean {
  const profile = object(value);
  exactKeys(profile, ["id", "version"]);
  return (
    typeof profile.id === "string" &&
    TOKEN.test(profile.id) &&
    typeof profile.version === "number" &&
    Number.isSafeInteger(profile.version) &&
    profile.version > 0
  );
}
function validTool(value: CatalogJsonValue | undefined): boolean {
  if (value === null) return true;
  const ref = object(value);
  exactKeys(ref, ["canonicalId", "contractVersion"]);
  if (typeof ref.canonicalId !== "string" || typeof ref.contractVersion !== "number") return false;
  createToolRef(ref.canonicalId, ref.contractVersion);
  return true;
}
function validDiagnostics(key: string, value: CatalogJsonValue | undefined): boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return false;
  if (value.length === 0) return true;
  const redacted = redactLogFields({ [key]: value })?.[key];
  return (
    Array.isArray(redacted) &&
    value.length === redacted.length &&
    value.every((item, index) => item === redacted[index])
  );
}
function metricMaximum(key: string): number {
  if (key === "resultCount") return TOOL_CATALOG_LIMITS.maxArrayItems;
  if (key === "durationMs") return Number.MAX_SAFE_INTEGER;
  return TOOL_CATALOG_LIMITS.maxResultBytes;
}
function validMetric(key: string, value: CatalogJsonValue): boolean {
  const maximum = metricMaximum(key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validField(key: string, value: CatalogJsonValue): boolean {
  if (DIGEST_FIELDS.has(key)) return typeof value === "string" && DIGEST.test(value);
  if (ID_FIELDS.has(key)) return validIdentifier(key, value);
  if (METRIC_FIELDS.has(key)) return validMetric(key, value);
  if (key === "correlationId" || key === "parentCorrelationId")
    return typeof value === "string" && isValidCorrelationId(value);
  if (key === "profile") return validProfile(value);
  if (key === "toolRef") return validTool(value);
  return validStateField(key, value);
}
function validIdentifier(key: string, value: CatalogJsonValue): boolean {
  return value === null ? key === "reservationId" : typeof value === "string" && TOKEN.test(value);
}
function validStateField(key: string, value: CatalogJsonValue): boolean {
  if (key === "frames" || key === "causeChain") return validDiagnostics(key, value);
  if (key === "errorKind") return isErrorKind(value);
  if (key === "effectStarted" || key === "truncated") return typeof value === "boolean";
  if (key === "readiness") return typeof value === "string" && READINESS.has(value);
  return typeof value === "string";
}
function optionalFields(phase: ToolLifecyclePhase): readonly string[] {
  if (phase === "terminal") return ["parentCorrelationId", ...TERMINAL_OPTIONAL];
  if (phase === "projection") return ["parentCorrelationId", "resultCount"];
  return ["parentCorrelationId"];
}
function terminalStatus(value: CatalogJsonObject): void {
  requireLifecycle(
    typeof value.status === "string" && Object.hasOwn(TOOL_RESULT_REASONS, value.status),
  );
  const reasons: readonly string[] =
    TOOL_RESULT_REASONS[value.status as keyof typeof TOOL_RESULT_REASONS];
  requireLifecycle(typeof value.reason === "string" && reasons.includes(value.reason));
  if (value.status === "failed") {
    requireLifecycle(
      isErrorKind(value.errorKind) &&
        validDiagnostics("frames", value.frames) &&
        validDiagnostics("causeChain", value.causeChain),
    );
  } else
    requireLifecycle(
      !["errorKind", "frames", "causeChain"].some((key) => Object.hasOwn(value, key)),
    );
}
function terminalReservation(value: CatalogJsonObject): void {
  captureToolInvocationReceipt({
    invocationId: value.invocationId,
    settlementId: value.settlementId,
    reservationId: value.reservationId,
    status: value.status,
    effectStarted: value.effectStarted,
    budgetDisposition: value.budgetDisposition,
  });
  if (value.toolRef === null)
    requireLifecycle(
      value.status !== "completed" &&
        !value.effectStarted &&
        value.budgetDisposition === "not-reserved",
    );
}
function phaseShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "terminal") {
    terminalStatus(value);
    terminalReservation(value);
    return;
  }
  bindingShape(phase, value);
  invocationShape(phase, value);
}
function bindingShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "bind-ready") requireLifecycle(value.readiness === "ready");
  if (phase === "bind-unavailable")
    requireLifecycle(
      value.readiness !== "ready" &&
        typeof value.reason === "string" &&
        BIND_REASONS.has(value.reason),
    );
}
function invocationShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "invocation-started")
    requireLifecycle(
      value.state === "started" &&
        value.reason === "none" &&
        value.reservationId !== null &&
        value.toolRef !== null,
    );
  if (phase === "discarded")
    requireLifecycle(value.reason === "late-completion" && value.toolRef !== null);
}

/** Closed, detached runtime evidence validation before the generic redactor and every sink. */
export function validateToolLifecycleEvent(source: unknown): ToolLifecycleEvent {
  try {
    const value = object(captureCatalogJson(source, 8192));
    const phase = typeof value.op === "string" ? toolLifecyclePhaseFor(value.op) : undefined;
    requireLifecycle(phase !== undefined);
    exactKeys(value, [...BASE_FIELDS, ...PHASE_FIELDS[phase]], optionalFields(phase));
    requireLifecycle(Object.entries(value).every(([key, field]) => validField(key, field)));
    phaseShape(phase, value);
    return deepFreeze(value) as unknown as ToolLifecycleEvent;
  } catch {
    throw new TypeError("Invalid tool lifecycle evidence");
  }
}

const CATALOG_REASON_ERROR_KIND: Readonly<Record<string, ActivityLogErrorKind>> = {
  "authority-invalid": "authority-denied",
  "authority-expired": "authority-denied",
  "authority-revoked": "authority-denied",
  "hard-denial": "authority-denied",
  "approval-required": "authority-denied",
  "approval-rejected": "authority-denied",
  "budget-exhausted": "rate-limited",
  "workspace-denied": "authority-denied",
  "effect-denied": "authority-denied",
  "unknown-tool": "invalid-request",
  "unoffered-tool": "invalid-request",
  "ambiguous-alias": "invalid-request",
  "invalid-arguments": "invalid-request",
  "version-mismatch": "validation-failed",
  "projection-mismatch": "validation-failed",
  "unsupported-capability": "unavailable",
  "cursor-invalid": "invalid-request",
  "cursor-expired": "invalid-request",
  "cursor-replayed": "conflict",
  "workspace-stale": "conflict",
  "replay-conflict": "conflict",
  "recovery-required": "conflict",
  "invocation-in-flight": "conflict",
  "capacity-exhausted": "rate-limited",
  "explicit-cancellation": "cancelled",
  "parent-cancelled": "cancelled",
  "deadline-exceeded": "timeout",
  "handler-unavailable": "unavailable",
  "handler-mismatch": "unavailable",
  "handler-failed": "internal",
  "result-contract-failed": "validation-failed",
  "effect-outcome-unknown": "unknown",
  "budget-port-failed": "internal",
};

function lifecycleEnvelope(
  event: ToolLifecycleEvent,
  errorKind?: ActivityLogErrorKind,
): ActivityLogEventEnvelope {
  return {
    level:
      event.op === "tool-catalog.invocation-settled" && event.status === "failed"
        ? "error"
        : "info",
    correlationId: event.correlationId,
    ...(event.parentCorrelationId === undefined
      ? {}
      : { parentCorrelationId: event.parentCorrelationId }),
    ...(errorKind === undefined ? {} : { errorKind }),
  };
}

function identityFields(event: ToolLifecycleEvent): {
  readonly catalogRevision: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly projectionDigest: string;
} {
  return {
    catalogRevision: event.catalogRevision,
    profileId: event.profile.id,
    profileVersion: event.profile.version,
    projectionDigest: event.projectionDigest,
  };
}

function writeProjection(
  sink: ServerLogSink,
  event: Extract<ToolLifecycleEvent, { readonly op: "tool-catalog.projection" }>,
): void {
  sink.write(
    activityLogEvent(TOOL_CATALOG_PROJECTION_OPERATION, lifecycleEnvelope(event), {
      ...identityFields(event),
      readiness: event.readiness,
      ...(event.resultCount === undefined ? {} : { resultCount: event.resultCount }),
    }),
  );
}

function writeBindingReady(
  sink: ServerLogSink,
  event: Extract<ToolLifecycleEvent, { readonly op: "tool-catalog.bind-ready" }>,
): void {
  sink.write(
    activityLogEvent(TOOL_CATALOG_BIND_READY_OPERATION, lifecycleEnvelope(event), {
      ...identityFields(event),
      readiness: event.readiness,
      handlerSetDigest: event.handlerSetDigest,
    }),
  );
}

function writeBindingUnavailable(
  sink: ServerLogSink,
  event: Extract<ToolLifecycleEvent, { readonly op: "tool-catalog.bind-unavailable" }>,
): void {
  sink.write(
    activityLogEvent(
      TOOL_CATALOG_BIND_UNAVAILABLE_OPERATION,
      lifecycleEnvelope(event, CATALOG_REASON_ERROR_KIND[event.reason] ?? "unavailable"),
      { ...identityFields(event), readiness: event.readiness, reason: event.reason },
    ),
  );
}

function writeInvocationStarted(
  sink: ServerLogSink,
  event: Extract<ToolLifecycleEvent, { readonly op: "tool-catalog.invocation-started" }>,
): void {
  sink.write(
    activityLogEvent(TOOL_CATALOG_INVOCATION_STARTED_OPERATION, lifecycleEnvelope(event), {
      ...identityFields(event),
      invocationId: event.invocationId,
      toolCanonicalId: event.toolRef.canonicalId,
      toolContractVersion: event.toolRef.contractVersion,
      state: event.state,
      reason: event.reason,
      reservationId: event.reservationId,
    }),
  );
}

type SettlementEvent = Extract<
  ToolLifecycleEvent,
  { readonly op: "tool-catalog.invocation-settled" }
>;

function settledFields(
  event: SettlementEvent,
): ActivityLogEventFields<typeof TOOL_CATALOG_INVOCATION_SETTLED_OPERATION> {
  return {
    ...identityFields(event),
    invocationId: event.invocationId,
    ...(event.toolRef === null
      ? { toolRefCompleteness: "unknown" }
      : {
          toolCanonicalId: event.toolRef.canonicalId,
          toolContractVersion: event.toolRef.contractVersion,
          toolRefCompleteness: "complete",
        }),
    settlementId: event.settlementId,
    ...(event.reservationId === null
      ? { reservationState: "not-reserved" }
      : { reservationId: event.reservationId, reservationState: "reserved" }),
    status: event.status,
    reason: event.reason,
    durationMs: event.durationMs,
    effectStarted: event.effectStarted,
    budgetDisposition: event.budgetDisposition,
    ...(event.inputBytes === undefined ? {} : { inputBytes: event.inputBytes }),
    ...(event.outputBytes === undefined ? {} : { outputBytes: event.outputBytes }),
    ...(event.resultCount === undefined ? {} : { resultCount: event.resultCount }),
    ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
    ...(event.status === "failed" ? { frames: event.frames, causeChain: event.causeChain } : {}),
  };
}

function settlementErrorKind(event: SettlementEvent): ActivityLogErrorKind | undefined {
  return event.status === "completed"
    ? undefined
    : (CATALOG_REASON_ERROR_KIND[event.reason] ?? "internal");
}

function writeInvocationSettled(sink: ServerLogSink, event: SettlementEvent): void {
  sink.write(
    activityLogEvent(
      TOOL_CATALOG_INVOCATION_SETTLED_OPERATION,
      lifecycleEnvelope(event, settlementErrorKind(event)),
      settledFields(event),
    ),
  );
}

function writeCompletionDiscarded(
  sink: ServerLogSink,
  event: Extract<ToolLifecycleEvent, { readonly op: "tool-catalog.completion-discarded" }>,
): void {
  sink.write(
    activityLogEvent(
      TOOL_CATALOG_COMPLETION_DISCARDED_OPERATION,
      lifecycleEnvelope(event, "unknown"),
      {
        ...identityFields(event),
        invocationId: event.invocationId,
        toolCanonicalId: event.toolRef.canonicalId,
        toolContractVersion: event.toolRef.contractVersion,
        settlementId: event.settlementId,
        reason: event.reason,
        lossState: "event-dropped",
      },
    ),
  );
}

function writeLifecycle(sink: ServerLogSink, event: ToolLifecycleEvent): void {
  switch (event.op) {
    case "tool-catalog.projection":
      writeProjection(sink, event);
      break;
    case "tool-catalog.bind-ready":
      writeBindingReady(sink, event);
      break;
    case "tool-catalog.bind-unavailable":
      writeBindingUnavailable(sink, event);
      break;
    case "tool-catalog.invocation-started":
      writeInvocationStarted(sink, event);
      break;
    case "tool-catalog.invocation-settled":
      writeInvocationSettled(sink, event);
      break;
    case "tool-catalog.completion-discarded":
      writeCompletionDiscarded(sink, event);
      break;
  }
}

export interface CatalogLifecycleLogPort {
  readonly primary: ServerLogSink;
  readonly diagnostics: ServerDiagnosticSink;
  readonly auxiliary?: ServerLogSink;
}
function writeToSink(
  sink: ServerLogSink,
  event: ToolLifecycleEvent,
  diagnostics: ServerDiagnosticSink,
  source: "tool-catalog-lifecycle-primary" | "tool-catalog-lifecycle-auxiliary",
): void {
  try {
    writeLifecycle(sink, event);
  } catch (error) {
    // The lifecycle line is lost from this sink: counted in the process loss ledger, and the
    // failure itself reaches the operator diagnostic below.
    recordActivityLogLoss("port-sink-failed");
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: event.correlationId,
        operation: "tool-catalog.lifecycle-sink-failed",
        source,
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}
export function emitToolLifecycleEvent(port: CatalogLifecycleLogPort, source: unknown): void {
  const event = validateToolLifecycleEvent(source);
  // An auxiliary callback never runs before the primary durable-write attempt.
  writeToSink(port.primary, event, port.diagnostics, "tool-catalog-lifecycle-primary");
  if (port.auxiliary !== undefined)
    writeToSink(port.auxiliary, event, port.diagnostics, "tool-catalog-lifecycle-auxiliary");
}

export { redactLogFields } from "../observability/log-redaction.js";
