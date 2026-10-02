import {
  activityLogEvent,
  type ActivityLogErrorKind,
  defineActivityLogOperation,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  DIAGNOSTIC_SUFFICIENCY_STATUSES,
  SUPPORT_REPORT_FAILURES,
  SUPPORT_REPORT_SCHEMA_VERSION,
  type DiagnosticSufficiencyReason,
  type DiagnosticSufficiencyStatus,
  type SupportReportFailure,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  SafeArtifactFileError,
  type SafeArtifactFileFailureKind,
} from "@oscharko-dev/keiko-security/fs-hardening";
import { describeErrorKind, SupportReportError } from "@oscharko-dev/keiko-activity-log/reader";
import type { SupportReportPublication } from "./support-export.js";

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
    sufficiencyReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 17,
      values: [...DIAGNOSTIC_SUFFICIENCY_REASONS],
    },
    reportDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    // Export only: how the one report was committed and what the platform could assure for it.
    publication: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["published", "recovered"],
    },
    permissionAssurance: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified-private", "platform-inherited"],
    },
    durabilityAssurance: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified", "directory-sync-unavailable"],
    },
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
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...SUPPORT_REPORT_FAILURES],
    },
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

// An analysis that proceeds without the lazily loaded tool-lifecycle validator states it: the
// affected tool-catalog lines then read lifecycle-validator-unavailable instead of failing.
export const SUPPORT_REPORT_DEGRADED = defineActivityLogOperation({
  ...BASE,
  op: "support.report.degraded",
  emitter: "support-report-evidence.emitSupportReportDegraded",
  lifecycle: "state",
  analyzerProjection: "timeline",
  fields: {
    surface: SURFACE,
    reportSchemaVersion: COUNT,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["lifecycle-validator-unavailable"],
    },
    errorClass: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
      maxLength: 64,
    },
  },
  proofIds: ["support.report.degraded.lifecycle-validator"],
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
    sufficiencyReasons: readonly DiagnosticSufficiencyReason[];
    reportDigest: string;
    publication?: SupportReportPublication | undefined;
  },
): void {
  const { publication, ...counts } = summary;
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_COMPLETED,
      // An insufficient report is published honestly, and is still a warning for the operator.
      { level: summary.sufficiency === "insufficient" ? "warn" : "info", correlationId },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        ...counts,
        sufficiencyReasons: [...summary.sufficiencyReasons],
        ...(publication === undefined
          ? {}
          : {
              publication: publication.status,
              permissionAssurance: publication.permissionAssurance,
              durabilityAssurance: publication.durabilityAssurance,
            }),
      },
    ),
  );
}
export function emitSupportReportDegraded(
  sink: ServerLogSink,
  correlationId: string,
  surface: SupportReportSurface,
  error: unknown,
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_DEGRADED,
      { level: "warn", correlationId },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        reason: "lifecycle-validator-unavailable",
        errorClass: describeErrorKind(error),
        causeChain: [...causeChain(error)],
      },
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
      { level: "error", correlationId, errorKind: supportReportErrorKind(error) },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        ...(error instanceof SupportReportError ? { reason: error.reason } : {}),
        frames: [...keikoStackFrames(error)],
        causeChain: [...causeChain(error)],
      },
    ),
  );
}

const REPORT_FAILURE_ERROR_KINDS: Readonly<Record<SupportReportFailure, ActivityLogErrorKind>> = {
  "corrupt-report": "validation-failed",
  "unsafe-report": "validation-failed",
  "unsupported-report": "validation-failed",
  "report-budget-exceeded": "validation-failed",
  "legacy-input": "validation-failed",
  "selection-unavailable": "invalid-request",
  "seed-unavailable": "unavailable",
};

// Every hardened-file failure keeps a closed Activity Log kind; none collapses to internal.
const PUBLICATION_ERROR_KINDS: Readonly<Record<SafeArtifactFileFailureKind, ActivityLogErrorKind>> =
  {
    "invalid-publication": "validation-failed",
    "close-failed": "durability-failed",
    "durability-failed": "durability-failed",
    "open-failed": "open-failed",
    "permission-failed": "permission-denied",
    "permission-unsafe": "unsafe-target",
    "publish-failed": "write-failed",
    "publish-unsupported": "publish-unsupported",
    "read-failed": "read-failed",
    "recovery-conflict": "conflict",
    "replace-failed": "write-failed",
    "target-exists": "target-exists",
    "target-mutated": "target-mutated",
    "unsafe-ancestor": "unsafe-target",
    "unsafe-target": "unsafe-target",
    "write-failed": "write-failed",
  };

// A raw filesystem failure (for example creating the output directory) by its closed code.
const SYSTEM_ERROR_KINDS: ReadonlyMap<string, ActivityLogErrorKind> = new Map<
  string,
  ActivityLogErrorKind
>([
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "permission-denied"],
  ["EEXIST", "unsafe-target"],
  ["ENOTDIR", "unsafe-target"],
  ["EISDIR", "unsafe-target"],
  ["ENOSPC", "write-failed"],
  ["EDQUOT", "write-failed"],
  ["EIO", "write-failed"],
]);

function systemErrorKind(error: unknown): ActivityLogErrorKind {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return (typeof code === "string" ? SYSTEM_ERROR_KINDS.get(code) : undefined) ?? "internal";
}

export function supportReportErrorKind(error: unknown): ActivityLogErrorKind {
  if (error instanceof SafeArtifactFileError) return PUBLICATION_ERROR_KINDS[error.kind];
  if (error instanceof SupportReportError) return REPORT_FAILURE_ERROR_KINDS[error.reason];
  return systemErrorKind(error);
}

/** The closed failure the CLI prints: the report reason, the file failure, or the error kind. */
export function supportReportFailureReason(error: unknown): string {
  if (error instanceof SupportReportError) return error.reason;
  if (error instanceof SafeArtifactFileError) return error.kind;
  return supportReportErrorKind(error);
}
