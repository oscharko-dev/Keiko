import {
  activityLogEvent,
  defineActivityLogOperation,
  SUPPORT_REPORT_FAILURES,
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
    ...COMPLETE,
  },
  proofIds: ["support.report.ui.completed.lifecycle"],
});
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
      values: [...SUPPORT_REPORT_FAILURES, "busy", "timeout", "unavailable", "cancelled"],
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
  getServerLogger().info(
    activityLogEvent(
      COMPLETED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        reportBytes: Buffer.byteLength(report.reportJson),
        completeness: "complete",
        loss: "none",
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
      errorKind: error.reason === "timeout" ? "timeout" : "internal",
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
  if (error.reason === "busy" || error.reason === "cancelled") getServerLogger().warn(event);
  else getServerLogger().error(event);
}
