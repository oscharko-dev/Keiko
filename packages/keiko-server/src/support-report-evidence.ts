import {
  activityLogEvent,
  defineActivityLogOperation,
  SUPPORT_REPORT_FAILURES,
  looksLikeSecret,
  looksLikePersonalIdentifier,
  isActivityLogCorrelationId,
  type ActivityLogCompletenessState,
  type ActivityLogLossState,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  type ActivityLogErrorKind,
  type DesktopSupportReportResponse,
  type DiagnosticSufficiencyStatus,
  type DiagnosticSufficiencyReason,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";
import { correlationIdOrUnknown } from "./correlation.js";
import type { SupportReportJobError } from "./support-report-job.js";

const BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "diagnostic",
  owner: "keiko-server",
  causal: "correlation",
  failureClasses: ["support-report"],
  releaseImpact: "minor",
} as const;
const COMPLETE = {
  completeness: { type: "string", dataClass: "completeness-state", required: true },
  loss: { type: "string", dataClass: "loss-state", required: true },
} as const;
const SELECTED_CORRELATION = {
  selectedCorrelationId: {
    type: "string",
    dataClass: "opaque-id",
    required: false,
    maxLength: 128,
  },
} as const;
const DELIVERY_FIELDS = {
  evidenceScope: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["server", "client-only"],
  },
  deliveryAuthority: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["session-bound", "client-only"],
  },
} as const;
const STARTED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.started",
  emitter: "support-report-evidence.emitSupportReportStarted",
  lifecycle: "start",
  analyzerProjection: "timeline",
  fields: {
    selector: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["correlation", "recent"],
    },
    ...SELECTED_CORRELATION,
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.started.lifecycle"],
});
const COMPLETED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.completed",
  emitter: "support-report-evidence.emitSupportReportCompleted",
  lifecycle: "end",
  analyzerProjection: "capability",
  fields: {
    ...SELECTED_CORRELATION,
    ...DELIVERY_FIELDS,
    pinDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pinned", "quota-exceeded", "rejected"],
    },
    availabilityReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "session-unavailable",
        "diagnostic-delivery-unavailable",
        "service-unavailable",
        "client-only-selected",
        "correlation-unavailable",
      ],
    },
    reportBytes: { type: "integer", dataClass: "count", required: true },
    recordCount: { type: "integer", dataClass: "count", required: false },
    reportDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    incidentId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 32 },
    manifestUnreadableCount: { type: "integer", dataClass: "count", required: false },
    manifestReusedCount: { type: "integer", dataClass: "count", required: false },
    sufficiency: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "degraded", "insufficient"],
    },
    reasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      maxItems: 32,
      values: DIAGNOSTIC_SUFFICIENCY_REASONS,
    },
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.completed.lifecycle"],
});
const DELIVERED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.delivered",
  emitter: "support-report-evidence.emitSupportReportDelivered",
  lifecycle: "state",
  analyzerProjection: "timeline",
  fields: {
    reportBytes: { type: "integer", dataClass: "count", required: true },
    transportBytes: { type: "integer", dataClass: "count", required: false },
    reportDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    ...DELIVERY_FIELDS,
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.delivered.line"],
});

export function emitSupportReportDelivered(
  correlationId: string | undefined,
  reportBytes: number,
  deliveryAuthority: "session-bound" | "client-only",
  parentCorrelationId?: string,
  reportDigest?: string,
  evidenceScope?: "server" | "client-only",
  transportBytes?: number,
): void {
  getServerLogger().info(
    activityLogEvent(DELIVERED, reportCorrelation(correlationId, parentCorrelationId), {
      reportBytes,
      ...(transportBytes === undefined ? {} : { transportBytes }),
      ...(reportDigest === undefined ? {} : { reportDigest }),
      deliveryAuthority,
      evidenceScope:
        evidenceScope ?? (deliveryAuthority === "client-only" ? "client-only" : "server"),
      completeness: "complete",
      loss: "none",
    }),
  );
}

const DELIVERY_RELEASED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.delivery-released",
  emitter: "support-report-evidence.emitSupportReportDeliveryReleased",
  lifecycle: "state",
  analyzerProjection: "timeline",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["expired", "byte-pressure", "entry-pressure"],
    },
    reportBytes: { type: "integer", dataClass: "count", required: true },
    retainedBytes: { type: "integer", dataClass: "count", required: true },
    ...DELIVERY_FIELDS,
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.delivery-released.line"],
});

export function emitSupportReportDeliveryReleased(
  correlationId: string | undefined,
  reason: "expired" | "byte-pressure" | "entry-pressure",
  reportBytes: number,
  retainedBytes: number,
  deliveryAuthority: "session-bound" | "client-only",
  evidenceScope: "server" | "client-only",
): void {
  getServerLogger().info(
    activityLogEvent(
      DELIVERY_RELEASED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        reason,
        reportBytes,
        retainedBytes,
        deliveryAuthority,
        evidenceScope,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

const DOWNLOAD_REFUSED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.download-refused",
  emitter: "support-report-evidence.emitSupportReportDownloadRefused",
  lifecycle: "state",
  analyzerProjection: "timeline",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["no-session", "other-session", "expired-or-unknown"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: true },
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.download-refused.line"],
});

export function emitSupportReportDownloadRefused(
  correlationId: string | undefined,
  reason: "no-session" | "other-session" | "expired-or-unknown",
  httpStatus: 403 | 404,
): void {
  getServerLogger().info(
    activityLogEvent(
      DOWNLOAD_REFUSED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { reason, httpStatus, completeness: "complete", loss: "none" },
    ),
  );
}

const FAILED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.ui.failed",
  emitter: "support-report-evidence.emitSupportReportFailed",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        ...SUPPORT_REPORT_FAILURES,
        "busy",
        "timeout",
        "unavailable",
        "cancelled",
        "quota-exhausted",
        "store-unavailable",
        "record-too-large",
        "evaluation-rate-limited",
        "delivery-capacity",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
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
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.failed.lifecycle"],
});

export function emitSupportReportStarted(
  correlationId: string | undefined,
  selected: boolean,
  selectedCorrelationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      STARTED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        selector: selected ? "correlation" : "recent",
        ...selectedCorrelationFields(selectedCorrelationId),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
type CompletionSummary = Partial<{
  [
    Key in
      | "recordCount"
      | "reportDigest"
      | "incidentId"
      | "manifestUnreadableCount"
      | "manifestReusedCount"
      | "pinDisposition"
      | "availabilityReason"
  ]: Exclude<NonNullable<DesktopSupportReportResponse["summary"]>[Key], undefined>;
}>;
function completionSummary(summary: DesktopSupportReportResponse["summary"]): CompletionSummary {
  if (summary === undefined) return {};
  return {
    recordCount: summary.recordCount,
    reportDigest: summary.reportDigest,
    incidentId: summary.incidentId,
    manifestUnreadableCount: summary.manifestUnreadableCount,
    manifestReusedCount: summary.manifestReusedCount,
    ...(summary.pinDisposition === undefined ? {} : { pinDisposition: summary.pinDisposition }),
    ...(summary.availabilityReason === undefined
      ? {}
      : { availabilityReason: summary.availabilityReason }),
  };
}
function completionState(report: DesktopSupportReportResponse): {
  sufficiency: DiagnosticSufficiencyStatus;
  reasons: readonly DiagnosticSufficiencyReason[];
  completeness: ActivityLogCompletenessState;
  loss: ActivityLogLossState;
} {
  const status = report.summary?.status ?? "degraded";
  return {
    sufficiency: status,
    reasons: report.summary?.reasons ?? ["evidence-partial"],
    completeness: report.summary?.completeness ?? "unknown",
    loss: report.summary?.loss ?? "event-location-unknown",
  };
}
export function emitSupportReportCompleted(
  correlationId: string | undefined,
  report: DesktopSupportReportResponse,
  selectedCorrelationId?: string,
): void {
  const summary = report.summary;
  const status = summary?.status ?? "degraded";
  getServerLogger()[status === "complete" ? "info" : "warn"](
    activityLogEvent(
      COMPLETED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        reportBytes: Buffer.byteLength(report.reportJson),
        ...selectedCorrelationFields(selectedCorrelationId),
        evidenceScope: report.evidenceScope ?? "server",
        deliveryAuthority: report.evidenceScope === "client-only" ? "client-only" : "session-bound",
        ...completionSummary(summary),
        ...completionState(report),
      },
    ),
  );
}
export function emitSupportReportFailed(
  correlationId: string | undefined,
  error: SupportReportJobError,
  parentCorrelationId?: string,
  reasonOverride?: "delivery-capacity",
): void {
  const reason = reasonOverride ?? error.reason;
  const event = activityLogEvent(
    FAILED,
    {
      ...reportCorrelation(correlationId, parentCorrelationId),
      errorKind: supportReportJobErrorKind(error),
    },
    {
      reason,
      failureKind: error.failureKind,
      ...(error.frames.length === 0 ? {} : { frames: error.frames }),
      ...(error.causeChain.length === 0 ? {} : { causeChain: error.causeChain }),
      completeness: "complete",
      loss: "none",
    },
  );
  if (EXPECTED_REFUSALS.has(reason)) getServerLogger().warn(event);
  else getServerLogger().error(event);
}

const EXPECTED_REFUSALS = new Set([
  "busy",
  "cancelled",
  "selection-unavailable",
  "quota-exhausted",
  "evaluation-rate-limited",
  "record-too-large",
  "delivery-capacity",
]);

function supportReportJobErrorKind(error: SupportReportJobError): ActivityLogErrorKind {
  if (
    error.reason === "busy" ||
    error.reason === "quota-exhausted" ||
    error.reason === "evaluation-rate-limited"
  )
    return "rate-limited";
  if (error.reason === "cancelled") return "cancelled";
  if (error.reason === "selection-unavailable") return "invalid-request";
  if (error.reason === "record-too-large") return "validation-failed";
  if (error.reason === "store-unavailable" || error.reason === "unavailable") return "unavailable";
  return error.reason === "timeout" ? "timeout" : "internal";
}

function safeReportCorrelation(value: string | undefined): string | undefined {
  return isActivityLogCorrelationId(value) &&
    !looksLikeSecret(value) &&
    !looksLikePersonalIdentifier(value)
    ? value
    : undefined;
}
function selectedCorrelationFields(value: string | undefined): { selectedCorrelationId?: string } {
  const selectedCorrelationId = safeReportCorrelation(value);
  return selectedCorrelationId === undefined ? {} : { selectedCorrelationId };
}
function reportCorrelation(
  correlationId: string | undefined,
  parent: string | undefined,
): { correlationId: string; parentCorrelationId?: string } {
  const parentCorrelationId = safeReportCorrelation(parent);
  return {
    correlationId: correlationIdOrUnknown(correlationId),
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
  };
}
