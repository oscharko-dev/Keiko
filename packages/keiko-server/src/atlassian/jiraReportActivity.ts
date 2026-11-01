import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { JiraReportActivity } from "@oscharko-dev/keiko-connectors";
import {
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

type JiraReportRefusalKind =
  | "invalid-input"
  | "unsupported-deployment"
  | "report-not-found"
  | "report-busy"
  | "connection-changed"
  | "invalid-format"
  | "export-unavailable";

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
      values: ["read", "section", "refused", "export"],
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
        "permission",
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
        "invalid-format",
        "export-unavailable",
      ],
    },
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["project", "jql", "project-jql", "report"],
    },
    continued: { type: "boolean", dataClass: "closed-enum", required: true },
    format: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["markdown", "csv"],
    },
    issuesRead: { type: "integer", dataClass: "count", required: false },
    issuesTotal: { type: "integer", dataClass: "count", required: false },
    pageCount: { type: "integer", dataClass: "count", required: false },
    issuesWithDeviations: { type: "integer", dataClass: "count", required: false },
    deviationCount: { type: "integer", dataClass: "count", required: false },
    requirementCount: { type: "integer", dataClass: "count", required: false },
    hierarchyDiscovery: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["complete", "unavailable"],
    },
    hierarchyFieldCount: { type: "integer", dataClass: "count", required: false },
    hierarchyObservedFieldCount: { type: "integer", dataClass: "count", required: false },
    byteCount: { type: "integer", dataClass: "count", required: false },
    invalidArgumentCount: { type: "integer", dataClass: "count", required: false },
    ruleIds: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 64,
      maxItems: 64,
    },
    durationMs: { type: "integer", dataClass: "duration", required: false },
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
  readonly phase: "export";
  readonly format?: JiraReportExportFormat;
  readonly refusal?: JiraReportRefusalKind;
  readonly byteCount?: number;
  readonly durationMs: number;
}
export type JiraReportLogInput = JiraReportActivity | JiraReportExportActivity;

const REFUSAL_KIND: Readonly<Record<JiraReportRefusalKind, ActivityLogErrorKind>> = {
  "invalid-input": "invalid-request",
  "unsupported-deployment": "unavailable",
  "report-not-found": "invalid-request",
  "report-busy": "conflict",
  "connection-changed": "conflict",
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
  readonly phase: "read" | "section" | "refused" | "export";
  readonly scopeKind: "project" | "jql" | "project-jql" | "report";
  readonly continued: boolean;
  readonly durationMs: number;
  readonly status?: JiraReportStatus;
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
  readonly byteCount?: number;
  readonly invalidArgumentCount?: number;
  readonly ruleIds?: readonly string[];
}

/** How the parent relation was found, once a report knows it: counts and one closed word. */
function hierarchyOf(
  input: JiraReportActivity,
): Pick<
  JiraReportLine,
  "hierarchyDiscovery" | "hierarchyFieldCount" | "hierarchyObservedFieldCount"
> {
  const { hierarchy } = input;
  return hierarchy === undefined
    ? {}
    : {
        hierarchyDiscovery: hierarchy.discovery,
        hierarchyFieldCount: hierarchy.fieldCount,
        hierarchyObservedFieldCount: hierarchy.observedFieldCount,
      };
}

function invalidArguments(input: JiraReportActivity): Pick<JiraReportLine, "invalidArgumentCount"> {
  return input.invalidArgumentCount === undefined
    ? {}
    : { invalidArgumentCount: input.invalidArgumentCount };
}

function lineOf(input: JiraReportLogInput): JiraReportLine {
  if (input.phase === "export")
    return {
      phase: "export",
      scopeKind: "report",
      continued: false,
      durationMs: input.durationMs,
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      ...(input.byteCount === undefined ? {} : { byteCount: input.byteCount }),
    };
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
    ...invalidArguments(input),
    ruleIds: input.ruleIds,
  };
}

/** Counts, closed words and rule ids only: no scope text, issue key, summary or report content. */
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
      { ...lineOf(input), completeness: degraded ? "partial" : "complete", loss: "none" },
    ),
  );
}
