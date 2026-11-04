import {
  JIRA_REPORT_INCOMPLETE_REASONS,
  JIRA_REPORT_STATUSES,
  type JiraReportIncompleteReason,
  type JiraReportStatus,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/** What the report card shows. Every figure is copied from the tool result; none is derived here. */
export interface JiraReportView {
  readonly reportId: string;
  readonly status: JiraReportStatus;
  readonly issuesRead: number;
  readonly issuesTotal: number | undefined;
  readonly reason: JiraReportIncompleteReason | undefined;
  readonly figures:
    | {
        readonly total: number;
        readonly new: number;
        readonly indeterminate: number;
        readonly done: number;
        readonly donePercent: number;
        readonly issuesWithDeviations: number;
        readonly issuesJudged: number;
        readonly deviationCount: number;
        readonly uncoveredEpics: number;
        readonly orphans: number;
        /** `unobserved`: the scope shows no container, so the epic count is no established zero. */
        readonly containerRoles: "observed" | "unobserved";
        /** Parent relations that rest on a custom field whose role Jira does not state. */
        readonly inferredParentFields: number;
      }
    | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function listTotal(value: unknown): number | undefined {
  return count(record(value)?.total);
}
/** Every named member read as a count, or nothing at all when one is missing. */
function counts<Key extends string>(
  source: Record<string, unknown> | undefined,
  keys: readonly Key[],
): Record<Key, number> | undefined {
  const values = keys.map((key) => count(source?.[key]));
  return values.every((value) => value !== undefined)
    ? (Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Record<Key, number>)
    : undefined;
}
type Figures = NonNullable<JiraReportView["figures"]>;
function coverageOf(
  report: Record<string, unknown>,
): Pick<Figures, "uncoveredEpics" | "orphans" | "containerRoles"> | undefined {
  const coverage = record(report.coverage);
  const uncoveredEpics = listTotal(coverage?.uncoveredEpics);
  const orphans = listTotal(coverage?.orphans);
  const roles = coverage?.containerRoles;
  if (uncoveredEpics === undefined || orphans === undefined) return undefined;
  if (roles !== "observed" && roles !== "unobserved") return undefined;
  return { uncoveredEpics, orphans, containerRoles: roles };
}
function figuresOf(report: Record<string, unknown>): JiraReportView["figures"] {
  const project = record(record(report.progress)?.project);
  const status = counts(project, ["total", "new", "indeterminate", "done"] as const);
  const audit = counts(record(report.compliance), [
    "issuesWithDeviations",
    "issuesJudged",
    "deviationCount",
  ] as const);
  const coverage = coverageOf(report);
  const inferred = count(record(report.hierarchy)?.inferredFieldCount);
  const percent = project?.donePercent;
  if (status === undefined || audit === undefined || coverage === undefined) return undefined;
  if (inferred === undefined || typeof percent !== "number") return undefined;
  return { ...status, ...audit, ...coverage, donePercent: percent, inferredParentFields: inferred };
}

/** Undefined for anything that is not a well-formed `jira.report` result. */
export function jiraReportView(data: unknown): JiraReportView | undefined {
  const result = record(data);
  const progress = record(result?.progress);
  const status = JIRA_REPORT_STATUSES.find((item) => item === result?.status);
  const read = count(progress?.issuesRead);
  if (
    result?.outcome !== "succeeded" ||
    typeof result.reportId !== "string" ||
    status === undefined ||
    read === undefined
  )
    return undefined;
  const report = record(result.report);
  const reason = JIRA_REPORT_INCOMPLETE_REASONS.find(
    (item) => item === record(report?.completeness)?.reason,
  );
  return {
    reportId: result.reportId,
    status,
    issuesRead: read,
    issuesTotal: count(progress?.issuesTotal),
    reason,
    figures: report === undefined ? undefined : figuresOf(report),
  };
}
