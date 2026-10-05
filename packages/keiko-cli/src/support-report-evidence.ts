import {
  activityLogEvent,
  type ActivityLogErrorKind,
  defineActivityLogOperation,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  DIAGNOSTIC_SUFFICIENCY_STATUSES,
  SUPPORT_REPORT_FAILURES,
  SUPPORT_INCIDENT_TRIGGERS,
  SUPPORT_INCIDENT_PIN_STATUSES,
  type SupportIncidentPinStatus,
  type SupportIncidentTrigger,
  SUPPORT_REPORT_AVAILABILITY_REASONS,
  type SupportReportAvailabilityReason,
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
import type { SupportReportInputFacts, SupportReportPublication } from "./support-export.js";

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

const INPUT_FIELDS = {
  inputTransport: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["raw", "gzip"],
  },
  inputBytes: { ...COUNT, required: false },
} as const;

const EVIDENCE_SCOPE_FIELDS = {
  evidenceScope: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["full", "client-only"],
  },
  clientAvailabilityReason: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: [...SUPPORT_REPORT_AVAILABILITY_REASONS],
  },
} as const;

export interface SupportReportScopeEvidence {
  readonly evidenceScope: "full" | "client-only";
  readonly clientAvailabilityReason?: SupportReportAvailabilityReason;
}

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
    ...INPUT_FIELDS,
    ...EVIDENCE_SCOPE_FIELDS,
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
    incidentId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 32 },
    selectedCorrelationId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    incidentTrigger: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: SUPPORT_INCIDENT_TRIGGERS,
    },
    retentionDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["stored", "transient"],
    },
    pinDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: SUPPORT_INCIDENT_PIN_STATUSES,
    },
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
    // Analyze only: which view was produced, whose correlation a seed used, and whether an
    // explicitly selected replay fixture was published beside it.
    analysisView: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["analysis", "clusters", "timeline", "seed"],
    },
    seedCorrelation: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["incident", "selected"],
    },
    // The SHA-256 of the seed's correlation id: which reproduction was prepared, never the id.
    seedCorrelationDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    fixture: { type: "string", dataClass: "closed-enum", required: false, values: ["published"] },
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
    ...INPUT_FIELDS,
    ...EVIDENCE_SCOPE_FIELDS,
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
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxItems: 8,
      maxLength: 512,
    },
  },
  proofIds: ["support.report.degraded.lifecycle-validator"],
});

export type SupportReportSurface = "export" | "analyze";

/** What an analysis produced: its view, a seed's correlation, and a published replay fixture. */
export interface SupportReportAnalysisOutcome {
  readonly analysisView: "analysis" | "clusters" | "timeline" | "seed";
  readonly seedCorrelation?: "incident" | "selected" | undefined;
  readonly seedCorrelationDigest?: string | undefined;
  readonly fixture?: "published" | undefined;
}
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
export interface SupportReportExportEvidence {
  readonly incidentId: string;
  readonly incidentTrigger: SupportIncidentTrigger;
  readonly selectedCorrelationId?: string;
  readonly retentionDisposition: "stored" | "transient";
  readonly pinDisposition?: SupportIncidentPinStatus;
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
    exportEvidence?: SupportReportExportEvidence;
    analysis?: SupportReportAnalysisOutcome | undefined;
    inputBytes?: number;
    inputTransport?: "raw" | "gzip";
    evidenceScope?: "full" | "client-only";
    clientAvailabilityReason?: SupportReportAvailabilityReason;
  },
): void {
  const { publication, analysis, exportEvidence, ...counts } = summary;
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_COMPLETED,
      // An insufficient report is published honestly, and is still a warning for the operator.
      { level: summary.sufficiency === "insufficient" ? "warn" : "info", correlationId },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        ...counts,
        ...exportEvidence,
        sufficiencyReasons: [...summary.sufficiencyReasons],
        ...(publication === undefined
          ? {}
          : {
              publication: publication.status,
              permissionAssurance: publication.permissionAssurance,
              durabilityAssurance: publication.durabilityAssurance,
            }),
        ...analysisOutcomeFields(analysis),
      },
    ),
  );
}
// A native loader rejection (ERR_MODULE_NOT_FOUND) carries no Keiko frame. The catch site's own
// dist-anchored frames then locate the failing load, so the degraded line always names its site.
function degradedSiteFrames(error: unknown): readonly string[] {
  const frames = keikoStackFrames(error);
  if (frames.length > 0) return frames;
  const site: { stack?: string } = {};
  Error.captureStackTrace(site);
  return keikoStackFrames(site);
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
      { level: "warn", correlationId, errorKind: "unavailable" },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        reason: "lifecycle-validator-unavailable",
        errorClass: describeErrorKind(error),
        causeChain: [...causeChain(error)],
        frames: [...degradedSiteFrames(error)],
      },
    ),
  );
}
// The persisted fields carry no explicit undefined: an absent outcome adds nothing.
interface AnalysisOutcomeFields {
  readonly analysisView?: SupportReportAnalysisOutcome["analysisView"];
  readonly seedCorrelation?: "incident" | "selected";
  readonly seedCorrelationDigest?: string;
  readonly fixture?: "published";
}

function analysisOutcomeFields(
  analysis: SupportReportAnalysisOutcome | undefined,
): AnalysisOutcomeFields {
  if (analysis === undefined) return {};
  return {
    analysisView: analysis.analysisView,
    ...(analysis.seedCorrelation === undefined
      ? {}
      : { seedCorrelation: analysis.seedCorrelation }),
    ...(analysis.seedCorrelationDigest === undefined
      ? {}
      : { seedCorrelationDigest: analysis.seedCorrelationDigest }),
    ...(analysis.fixture === undefined ? {} : { fixture: analysis.fixture }),
  };
}

export function emitSupportReportFailed(
  sink: ServerLogSink,
  correlationId: string,
  surface: SupportReportSurface,
  error: unknown,
  input?: Partial<SupportReportInputFacts & SupportReportScopeEvidence>,
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_REPORT_FAILED,
      { level: "error", correlationId, errorKind: supportReportErrorKind(error) },
      {
        surface,
        reportSchemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
        ...input,
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
