import type { JiraReport, JiraReportContainer } from "./jira-report-types.js";

/** Lines per list; the sections page the rest, and the block says how many it left out. */
export const JIRA_REPORT_FIGURES_LINES_MAX = 300;
const SECONDS_PER_HOUR = 3600;

/** One line of cells: a delimiter inside a cell would shift the columns, so it becomes a space. */
function line(cells: readonly (string | number)[]): string {
  return cells
    .map((cell) =>
      String(cell)
        .replaceAll(/[;\r\n]+/gu, " ")
        .trim(),
    )
    .join(";");
}
function cut(lines: readonly string[], shown: number): readonly string[] {
  return lines.length <= shown ? lines : lines.slice(0, shown);
}
function more(total: number, shown: number, section: string): readonly string[] {
  return total > shown
    ? [`(${String(total - shown)} more not shown; page section ${section})`]
    : [];
}
/** Two decimals at most, without trailing zeros: 3600 s is 1 h, 5400 s is 1.5 h. */
function hours(seconds: number): number {
  return Math.round((seconds / SECONDS_PER_HOUR) * 100) / 100;
}
function containerLines(containers: readonly JiraReportContainer[]): readonly string[] {
  return containers.map((item) =>
    line([item.key, item.typeName, item.members.total, item.members.done]),
  );
}
function estimateLines(report: JiraReport): readonly string[] {
  const { estimate } = report.progress.project;
  const { total, done, remaining, unestimated } = estimate;
  const unit = report.scope.estimateUnit;
  return [
    unit === "seconds"
      ? "Estimate in seconds of original estimate (total;done;remaining):"
      : `Estimate in the unit of field ${report.scope.estimateFieldId ?? ""} (total;done;remaining):`,
    line([total, done, remaining]),
    ...(unit === "seconds"
      ? [
          "Estimate in hours (total;done;remaining):",
          line([hours(total), hours(done), hours(remaining)]),
        ]
      : []),
    `Issues without an estimate: ${String(unestimated)}`,
  ];
}

/**
 * The numbers of the report as plain lines a model can quote without computing or reshaping them:
 * every issue type and status combination, every container's issues and done issues, and the
 * estimate totals. It is derived from the computed report only, so a weaker model that copies a
 * line states exactly what the report holds (#4181). A list longer than the bound says so.
 */
export function jiraReportFigures(report: JiraReport): string {
  const { project, byStatus } = report.progress;
  const inScope = report.epics.filter((item) => !item.external);
  const outside = report.epics.filter((item) => item.external);
  const statusLines = byStatus.map((item) => line([item.typeName, item.statusName, item.total]));
  const inScopeLines = containerLines(inScope);
  const lines = [
    `Issues in the report: ${String(project.total)}; done: ${String(project.done)}`,
    "Issues per type and status (type;status;issues):",
    ...cut(statusLines, JIRA_REPORT_FIGURES_LINES_MAX),
    ...more(statusLines.length, JIRA_REPORT_FIGURES_LINES_MAX, "statuses"),
    "Issues per epic or container (key;type;issues in it;of which done):",
    ...cut(inScopeLines, JIRA_REPORT_FIGURES_LINES_MAX),
    ...more(inScopeLines.length, JIRA_REPORT_FIGURES_LINES_MAX, "epics"),
    ...(outside.length === 0
      ? []
      : [
          "Containers outside the scope that hold issues of it (key;type;issues in it;of which done):",
          ...cut(containerLines(outside), JIRA_REPORT_FIGURES_LINES_MAX),
        ]),
    ...estimateLines(report),
  ];
  return lines.join("\n");
}
