import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { JiraReportActivity } from "@oscharko-dev/keiko-connectors";
import {
  JIRA_REPORT_ESTIMATE_SOURCES,
  JIRA_REPORT_ESTIMATE_UNAVAILABLE_REASONS,
  type JiraReportEstimateSource,
  type JiraReportEstimateUnavailableReason,
  type JiraReportExportFormat,
  type JiraReportFailureReason,
  type JiraReportIncompleteReason,
  type JiraReportStatus,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS } from "../activity-line-fields.js";

type JiraReportRefusalKind =
  | "invalid-input"
  | "unsupported-deployment"
  | "report-not-found"
  | "report-busy"
  | "connection-changed"
  | "requirements-unavailable"
  | "invalid-format"
  | "export-unavailable";

const OPTIONAL_COUNT = { type: "integer", dataClass: "count", required: false } as const;

const JIRA_REPORT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.jira-report",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraReportActivity.recordJiraReportActivity",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["read", "section", "refused", "export", "retain"],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["reading", "complete", "incomplete"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "read-failed",
        "scope-changed",
        "memory-budget",
        "issue-too-large",
        "template-unreadable",
      ],
    },
    failure: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-jql",
        "auth",
        "auth-unverified",
        "permission",
        "effect-denied",
        "cancelled",
        "not-found",
        "rate-limited",
        "timeout",
        "unavailable",
        "malformed-payload",
        "bounds-exceeded",
      ],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-input",
        "unsupported-deployment",
        "report-not-found",
        "report-busy",
        "connection-changed",
        "requirements-unavailable",
        "invalid-format",
        "export-unavailable",
      ],
    },
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["project", "jql", "project-jql", "epic", "report"],
    },
    continued: { type: "boolean", dataClass: "closed-enum", required: true },
    estimateSource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: JIRA_REPORT_ESTIMATE_SOURCES,
    },
    estimateUnavailableReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: JIRA_REPORT_ESTIMATE_UNAVAILABLE_REASONS,
    },
    format: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["markdown", "csv"],
    },
    issuesRead: OPTIONAL_COUNT,
    issuesTotal: OPTIONAL_COUNT,
    pageCount: OPTIONAL_COUNT,
    issuesWithDeviations: OPTIONAL_COUNT,
    deviationCount: OPTIONAL_COUNT,
    requirementCount: OPTIONAL_COUNT,
    hierarchyDiscovery: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["complete", "unavailable"],
    },
    hierarchyFieldCount: OPTIONAL_COUNT,
    hierarchyObservedFieldCount: OPTIONAL_COUNT,
    hierarchyRejectedFieldCount: OPTIONAL_COUNT,
    hierarchyInferredFieldCount: OPTIONAL_COUNT,
    byteCount: OPTIONAL_COUNT,
    retainedReportCount: OPTIONAL_COUNT,
    exportSource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["memory", "retained"],
    },
    invalidArgumentCount: OPTIONAL_COUNT,
    sectionItemCount: OPTIONAL_COUNT,
    sectionItemTotal: OPTIONAL_COUNT,
    sectionByteFitted: { type: "boolean", dataClass: "closed-enum", required: false },
    ruleIds: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 64,
      maxItems: 64,
    },
    durationMs: { type: "integer", dataClass: "duration", required: false },
    ...ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["atlassian.jira-report.line"],
  releaseImpact: "minor",
});

/** One report export; the file text never enters the line. */
export interface JiraReportExportActivity {
  readonly phase: "export" | "retain";
  readonly format?: JiraReportExportFormat;
  readonly refusal?: JiraReportRefusalKind;
  readonly byteCount?: number;
  readonly retainedReportCount?: number;
  readonly exportSource?: "memory" | "retained";
  readonly durationMs: number;
  /** Reduced to Keiko frames and cause classes before entering the Activity Log. */
  readonly error?: unknown;
}
export type JiraReportLogInput = JiraReportActivity | JiraReportExportActivity;

const REFUSAL_KIND: Readonly<Record<JiraReportRefusalKind, ActivityLogErrorKind>> = {
  "invalid-input": "invalid-request",
  "unsupported-deployment": "unavailable",
  "report-not-found": "invalid-request",
  "report-busy": "conflict",
  "connection-changed": "conflict",
  "requirements-unavailable": "unavailable",
  "invalid-format": "invalid-request",
  "export-unavailable": "unavailable",
};
const INCOMPLETE_KIND: Readonly<Record<string, ActivityLogErrorKind>> = {
  "read-failed": "read-failed",
  "issue-too-large": "read-failed",
  "scope-changed": "conflict",
  "memory-budget": "unavailable",
  "template-unreadable": "unavailable",
};

function errorKindOf(input: JiraReportLogInput): ActivityLogErrorKind | undefined {
  if (input.refusal !== undefined) return REFUSAL_KIND[input.refusal];
  const reason = "reason" in input ? input.reason : undefined;
  return reason === undefined ? undefined : INCOMPLETE_KIND[reason];
}
interface JiraReportLine {
  readonly phase: "read" | "section" | "refused" | "export" | "retain";
  readonly scopeKind: "project" | "jql" | "project-jql" | "epic" | "report";
  readonly continued: boolean;
  readonly durationMs: number;
  readonly status?: JiraReportStatus;
  readonly estimateSource?: JiraReportEstimateSource;
  readonly estimateUnavailableReason?: JiraReportEstimateUnavailableReason;
  readonly reason?: JiraReportIncompleteReason;
  readonly failure?: JiraReportFailureReason;
  readonly refusal?: JiraReportRefusalKind;
  readonly format?: JiraReportExportFormat;
  readonly issuesRead?: number;
  readonly issuesTotal?: number;
  readonly pageCount?: number;
  readonly issuesWithDeviations?: number;
  readonly deviationCount?: number;
  readonly requirementCount?: number;
  readonly hierarchyDiscovery?: "complete" | "unavailable";
  readonly hierarchyFieldCount?: number;
  readonly hierarchyObservedFieldCount?: number;
  readonly hierarchyRejectedFieldCount?: number;
  readonly hierarchyInferredFieldCount?: number;
  readonly byteCount?: number;
  readonly retainedReportCount?: number;
  readonly exportSource?: "memory" | "retained";
  readonly invalidArgumentCount?: number;
  readonly sectionItemCount?: number;
  readonly sectionItemTotal?: number;
  readonly sectionByteFitted?: boolean;
  readonly ruleIds?: readonly string[];
}

/** How the parent relation was found, once a report knows it: counts and one closed word. */
function hierarchyOf(
  input: JiraReportActivity,
): Pick<
  JiraReportLine,
  | "hierarchyDiscovery"
  | "hierarchyFieldCount"
  | "hierarchyObservedFieldCount"
  | "hierarchyRejectedFieldCount"
  | "hierarchyInferredFieldCount"
> {
  const { hierarchy } = input;
  return hierarchy === undefined
    ? {}
    : {
        hierarchyDiscovery: hierarchy.discovery,
        hierarchyFieldCount: hierarchy.fieldCount,
        hierarchyObservedFieldCount: hierarchy.observedFieldCount,
        hierarchyRejectedFieldCount: hierarchy.rejectedFieldCount,
        hierarchyInferredFieldCount: hierarchy.inferredFieldCount,
      };
}

function invalidArguments(input: JiraReportActivity): Pick<JiraReportLine, "invalidArgumentCount"> {
  return input.invalidArgumentCount === undefined
    ? {}
    : { invalidArgumentCount: input.invalidArgumentCount };
}

function estimateOf(
  input: JiraReportActivity,
): Pick<JiraReportLine, "estimateSource" | "estimateUnavailableReason"> {
  return {
    ...(input.estimateSource === undefined ? {} : { estimateSource: input.estimateSource }),
    ...(input.estimateUnavailableReason === undefined
      ? {}
      : { estimateUnavailableReason: input.estimateUnavailableReason }),
  };
}

// A section page: how many entries it returned of how many, and whether the byte fit cut it short
// of the page size (S12 of epic #4173).
function sectionPageOf(
  input: JiraReportActivity,
): Pick<JiraReportLine, "sectionItemCount" | "sectionItemTotal" | "sectionByteFitted"> {
  const page = input.sectionPage;
  return page === undefined
    ? {}
    : {
        sectionItemCount: page.itemCount,
        sectionItemTotal: page.total,
        sectionByteFitted: page.byteFitted,
      };
}

function lineOf(input: JiraReportLogInput): JiraReportLine {
  if (!("scopeKind" in input)) return exportLine(input);
  return {
    phase: input.phase,
    scopeKind: input.scopeKind,
    continued: input.continued,
    durationMs: input.durationMs,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
    issuesRead: input.issuesRead,
    ...(input.issuesTotal === undefined ? {} : { issuesTotal: input.issuesTotal }),
    pageCount: input.pageCount,
    issuesWithDeviations: input.issuesWithDeviations,
    deviationCount: input.deviationCount,
    requirementCount: input.requirementCount,
    ...hierarchyOf(input),
    ...estimateOf(input),
    ...invalidArguments(input),
    ...sectionPageOf(input),
    ruleIds: input.ruleIds,
  };
}

function exportLine(input: JiraReportExportActivity): JiraReportLine {
  return {
    phase: input.phase,
    scopeKind: "report",
    continued: false,
    durationMs: input.durationMs,
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
    ...(input.byteCount === undefined ? {} : { byteCount: input.byteCount }),
    ...(input.retainedReportCount === undefined
      ? {}
      : { retainedReportCount: input.retainedReportCount }),
    ...(input.exportSource === undefined ? {} : { exportSource: input.exportSource }),
  };
}

/** Body-free evidence only: no scope text, issue key, summary or report content. */
export function recordJiraReportActivity(
  log: ServerLogSink | undefined,
  correlationId: string,
  input: JiraReportLogInput,
): void {
  const errorKind = errorKindOf(input);
  const degraded = input.refusal !== undefined || errorKind !== undefined;
  (log ?? processServerLogSink()).write(
    activityLogEvent(
      JIRA_REPORT_OPERATION,
      {
        correlationId,
        level: degraded ? "warn" : "info",
        ...(errorKind === undefined ? {} : { errorKind }),
      },
      {
        ...lineOf(input),
        ...("error" in input && input.error !== undefined
          ? { frames: keikoStackFrames(input.error), causeChain: causeChain(input.error) }
          : {}),
        completeness: degraded ? "partial" : "complete",
        loss: "none",
      },
    ),
  );
}
