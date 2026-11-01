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
        readonly issuesChecked: number;
        readonly deviationCount: number;
        readonly uncoveredEpics: number;
        readonly orphans: number;
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
function figuresOf(report: Record<string, unknown>): JiraReportView["figures"] {
  const project = record(record(report.progress)?.project);
  const compliance = record(report.compliance);
  const coverage = record(report.coverage);
  const status = counts(project, ["total", "new", "indeterminate", "done"] as const);
  const audit = counts(compliance, [
    "issuesWithDeviations",
    "issuesChecked",
    "deviationCount",
  ] as const);
  const uncoveredEpics = listTotal(coverage?.uncoveredEpics);
  const orphans = listTotal(coverage?.orphans);
  const percent = project?.donePercent;
  if (
    status === undefined ||
    audit === undefined ||
    uncoveredEpics === undefined ||
    orphans === undefined ||
    typeof percent !== "number"
  )
    return undefined;
  return { ...status, ...audit, uncoveredEpics, orphans, donePercent: percent };
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
