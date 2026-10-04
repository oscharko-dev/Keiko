import {
  activityLogEvent,
  defineActivityLogOperation,
  SUPPORT_REPORT_FAILURES,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  type ActivityLogErrorKind,
  type DesktopSupportReportResponse,
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
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.delivered.line"],
});

export function emitSupportReportDelivered(
  correlationId: string | undefined,
  reportBytes: number,
): void {
  getServerLogger().info(
    activityLogEvent(
      DELIVERED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { reportBytes, completeness: "complete", loss: "none" },
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
): void {
  getServerLogger().info(
    activityLogEvent(
      STARTED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        selector: selected ? "correlation" : "recent",
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
export function emitSupportReportCompleted(
  correlationId: string | undefined,
  report: DesktopSupportReportResponse,
): void {
  const summary = report.summary;
  const status = summary?.status ?? "degraded";
  getServerLogger()[status === "complete" ? "info" : "warn"](
    activityLogEvent(
      COMPLETED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        reportBytes: Buffer.byteLength(report.reportJson),
        ...(summary === undefined
          ? {}
          : {
              recordCount: summary.recordCount,
              reportDigest: summary.reportDigest,
              incidentId: summary.incidentId,
              manifestUnreadableCount: summary.manifestUnreadableCount,
              manifestReusedCount: summary.manifestReusedCount,
            }),
        sufficiency: status,
        reasons: summary?.reasons ?? ["evidence-partial"],
        completeness: status === "complete" ? "complete" : "partial",
        loss:
          status === "complete" || report.evidenceScope === "client-only"
            ? "none"
            : "event-location-unknown",
      },
    ),
  );
}
export function emitSupportReportFailed(
  correlationId: string | undefined,
  error: SupportReportJobError,
): void {
  const event = activityLogEvent(
    FAILED,
    {
      correlationId: correlationIdOrUnknown(correlationId),
      errorKind: supportReportJobErrorKind(error),
    },
    {
      reason: error.reason,
      failureKind: error.failureKind,
      ...(error.frames.length === 0 ? {} : { frames: error.frames }),
      ...(error.causeChain.length === 0 ? {} : { causeChain: error.causeChain }),
      completeness: "complete",
      loss: "none",
    },
  );
  if (EXPECTED_REFUSALS.has(error.reason)) getServerLogger().warn(event);
  else getServerLogger().error(event);
}

const EXPECTED_REFUSALS = new Set([
  "busy",
  "cancelled",
  "selection-unavailable",
  "quota-exhausted",
  "evaluation-rate-limited",
  "record-too-large",
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
