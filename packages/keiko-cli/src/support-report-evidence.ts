import {
  activityLogEvent,
  defineActivityLogOperation,
  DIAGNOSTIC_SUFFICIENCY_STATUSES,
  SUPPORT_REPORT_SCHEMA_VERSION,
  type DiagnosticSufficiencyStatus,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";

const SURFACE = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ["export", "analyze"],
} as const;
const COUNT = { type: "integer", dataClass: "count", required: true } as const;
const BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "diagnostic",
  owner: "keiko-cli",
  causal: "correlation",
  failureClasses: ["support-report"],
  releaseImpact: "minor",
} as const;

export const SUPPORT_REPORT_STARTED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.started",
  emitter: "support-report-evidence.emitSupportReportStarted",
  lifecycle: "start",
  analyzerProjection: "timeline",
  fields: { surface: SURFACE, reportSchemaVersion: COUNT, maxBytes: COUNT },
  proofIds: ["support.report.started.report-lifecycle"],
});
export const SUPPORT_REPORT_COMPLETED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.completed",
  emitter: "support-report-evidence.emitSupportReportCompleted",
  lifecycle: "end",
  analyzerProjection: "capability",
  fields: {
    surface: SURFACE,
    reportSchemaVersion: COUNT,
    reportBytes: COUNT,
    recordCount: COUNT,
    sufficiency: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...DIAGNOSTIC_SUFFICIENCY_STATUSES],
    },
    reportDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  proofIds: ["support.report.completed.report-lifecycle"],
});
export const SUPPORT_REPORT_FAILED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.failed",
  emitter: "support-report-evidence.emitSupportReportFailed",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  fields: {
    surface: SURFACE,
    reportSchemaVersion: COUNT,
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
      maxLength: 64,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxItems: 8,
      maxLength: 512,
    },
  },
  proofIds: ["support.report.failed.report-lifecycle"],
});

export type SupportReportSurface = "export" | "analyze";
export function emitSupportReportStarted(
  sink: ServerLogSink,
  correlationId: string,
  surface: SupportReportSurface,
  maxBytes: number,
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_STARTED,
      { correlationId },
      { surface, reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION, maxBytes },
    ),
  );
}
export function emitSupportReportCompleted(
  sink: ServerLogSink,
  correlationId: string,
  surface: SupportReportSurface,
  summary: {
    reportBytes: number;
    recordCount: number;
    sufficiency: DiagnosticSufficiencyStatus;
    reportDigest: string;
  },
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_COMPLETED,
      { correlationId },
      { surface, reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION, ...summary },
    ),
  );
}
export function emitSupportReportFailed(
  sink: ServerLogSink,
  correlationId: string,
  surface: SupportReportSurface,
  error: unknown,
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_FAILED,
      { correlationId, errorKind: "validation-failed" },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        frames: [...keikoStackFrames(error)],
        causeChain: [...causeChain(error)],
      },
    ),
  );
}
