import {
  JIRA_REPORT_EXPORT_MEDIA_TYPES,
  type JiraReportExportFormat,
  type JiraReportExportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  JiraReport,
  JiraReportContainer,
  JiraReportProgress,
  JiraReportRow,
} from "./jira-report-types.js";

/** Columns of the CSV export. A parser needs nothing but this list and RFC 4180. */
export const JIRA_REPORT_CSV_COLUMNS = [
  "recordKind",
  "key",
  "issueType",
  "status",
  "statusCategory",
  "classification",
  "parentKey",
  "containerKeys",
  "estimate",
  "assigned",
  "dueDate",
  "overdue",
  "ruleIds",
  "fieldIds",
  "items",
  "itemsDone",
  "summary",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/u;

/** RFC 4180 quoting; a cell a spreadsheet would execute as a formula gains a leading apostrophe. */
export function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  const raw = String(value);
  const safe = FORMULA_START.test(raw) && typeof value === "string" ? `'${raw}` : raw;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
function csvRow(cells: readonly (string | number | boolean | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
function issueRow(row: JiraReportRow): string {
  const { issue } = row;
  return csvRow([
    "issue",
    issue.key,
    issue.typeName,
    issue.statusName,
    issue.category,
    row.classification,
    issue.parentKey,
    row.containerKeys.join(";"),
    issue.estimate,
    issue.assigned,
    issue.dueDate,
    row.overdue,
    [...new Set(issue.deviations.map((item) => item.ruleId))].join(";"),
    [
      ...new Set(
        issue.deviations.flatMap((item) => (item.fieldId === undefined ? [] : [item.fieldId])),
      ),
    ].join(";"),
    undefined,
    undefined,
    issue.summary,
  ]);
}
function requirementRows(report: JiraReport): readonly string[] {
  const requirements = report.coverage.requirements;
  if (requirements === undefined) return [];
  return [
    ...requirements.items.map((item) =>
      csvRow([
        "requirement",
        item.id,
        undefined,
        undefined,
        undefined,
        "covered",
        undefined,
        item.coveredBy.join(";"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        item.itemCount,
        item.done,
        undefined,
      ]),
    ),
    ...requirements.uncovered.map((id) =>
      csvRow(["requirement", id, undefined, undefined, undefined, "uncovered"]),
    ),
  ];
}
// Spreadsheet programs read a UTF-8 CSV as text in their own code page without this mark.
const BYTE_ORDER_MARK = "\uFEFF";
/** The unit of every estimate and the date overdue was judged against, stated beside the figures. */
function unitsText(report: JiraReport): string {
  const { estimateUnit, estimateFieldId, asOf, timeZone } = report.scope;
  const unit =
    estimateUnit === "seconds"
      ? "estimateUnit=seconds"
      : `estimateUnit=custom-field:${estimateFieldId ?? ""}`;
  return `${unit};asOf=${asOf} ${timeZone}`;
}
function csvOf(report: JiraReport): string {
  const scope = report.scope.projectKey ?? report.scope.jql;
  const summaryRow = csvRow([
    "report",
    report.digest,
    scope,
    report.completeness.complete
      ? "complete"
      : `incomplete:${report.completeness.reason ?? "unknown"}`,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    report.completeness.issuesRead,
    report.completeness.issuesTotal,
    unitsText(report),
  ]);
  return `${BYTE_ORDER_MARK}${[
    csvRow(JIRA_REPORT_CSV_COLUMNS),
    summaryRow,
    ...report.rows.map(issueRow),
    ...requirementRows(report),
  ].join("\r\n")}\r\n`;
}

// Jira text is untrusted: every character Markdown or inline HTML would act on is escaped, and
// line breaks are collapsed so a value cannot start a new block (heading, list, table row).
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+!<>|&~]/gu;
function markdownText(value: string | number): string {
  return String(value).replaceAll(/\s+/gu, " ").trim().replaceAll(MARKDOWN_SPECIAL, "\\$&");
}
function cell(value: string | number): string {
  return markdownText(value);
}
function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  if (rows.length === 0) return "_None._\n";
  return `${[
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")}\n`;
}
function progressRow(label: string, progress: JiraReportProgress): readonly (string | number)[] {
  return [
    label,
    progress.total,
    progress.new,
    progress.indeterminate,
    progress.done,
    progress.noCategory,
    `${String(progress.donePercent)}%`,
  ];
}
const PROGRESS_HEADER = ["", "Issues", "To do", "In progress", "Done", "No category", "Done"];

function progressSection(report: JiraReport): string {
  const { project, byType, unassigned, overdue } = report.progress;
  const { estimate } = project;
  const unit =
    report.scope.estimateUnit === "seconds"
      ? "seconds of original time estimate"
      : `the unit of field ${report.scope.estimateFieldId ?? ""}`;
  return [
    "## Progress\n",
    table(PROGRESS_HEADER, [progressRow("Project", project)]),
    `Estimate (${unit}): ${String(estimate.total)} total, ${String(estimate.done)} done, ${String(estimate.remaining)} remaining; ${String(estimate.unestimated)} issues without an estimate.\n`,
    `Open issues without an assignee: ${String(unassigned)}. Open issues past their due date on ${report.scope.asOf} (${report.scope.timeZone}): ${String(overdue)}.\n`,
    "### By issue type and status\n",
    table(
      ["Type", "Status", "Category", "Issues"],
      report.progress.byStatus.map((item) => [
        item.typeName,
        item.statusName,
        item.category,
        item.total,
      ]),
    ),
    "### By issue type\n",
    table(
      ["Type", "Issues", "Done"],
      byType.map((item) => [item.typeName, item.total, item.done]),
    ),
  ].join("\n");
}
function epicRow(epic: JiraReportContainer): readonly (string | number)[] {
  return [...progressRow(epic.key, epic.members), epic.linked.total, epic.summary];
}
function epicsSection(report: JiraReport): string {
  return [
    "## Epics and containers\n",
    table(
      [
        ...PROGRESS_HEADER.map((item, index) => (index === 0 ? "Container" : item)),
        "Linked",
        "Summary",
      ],
      report.epics.map(epicRow),
    ),
  ].join("\n");
}
function complianceSection(report: JiraReport): string {
  const { compliance } = report;
  return [
    "## Compliance\n",
    `Required-field rules: ${compliance.requiredFieldRules}. Template checker: ${compliance.checker}.\n`,
    `${String(compliance.issuesChecked)} issues checked, ${String(compliance.issuesWithDeviations)} with deviations, ${String(compliance.deviationCount)} deviations.\n`,
    table(
      ["Rule", "Issues"],
      compliance.byRule.map((item) => [item.ruleId, item.count]),
    ),
    "### Deviations per issue\n",
    table(
      ["Issue", "Rules", "Fields"],
      compliance.deviations.map((item) => [
        item.key,
        item.ruleIds.join(", "),
        item.fieldIds.join(", "),
      ]),
    ),
  ].join("\n");
}
function listOf(items: readonly string[]): string {
  return items.length === 0 ? "_None._\n" : `${items.join(", ")}\n`;
}
function coverageSection(report: JiraReport): string {
  const { coverage } = report;
  const lines = [
    "## Coverage\n",
    "### Epics without members\n",
    listOf(coverage.uncoveredEpics),
    "### Issues without an epic or parent\n",
    listOf(coverage.orphans),
  ];
  const requirements = coverage.requirements;
  if (requirements !== undefined)
    lines.push(
      "### Requirements\n",
      `${String(requirements.covered)} of ${String(requirements.declared)} requirements are named by an issue.\n`,
      table(
        ["Requirement", "Named by", "Items", "Done", "Types"],
        requirements.items.map((item) => [
          item.id,
          item.coveredBy.join(", "),
          item.itemCount,
          item.done,
          item.byType
            .map((type) => `${type.typeName} ${String(type.done)}/${String(type.total)}`)
            .join(", "),
        ]),
      ),
      "### Requirements without an issue\n",
      listOf(requirements.uncovered),
    );
  return lines.join("\n");
}
function scopeText(report: JiraReport): string {
  const project = report.scope.projectKey === undefined ? "" : `project ${report.scope.projectKey}`;
  const jql = report.scope.jql.length > 0 ? ` JQL: ${markdownText(report.scope.jql)}` : "";
  return `${markdownText(project)}${jql}`;
}
function markdownOf(report: JiraReport): string {
  const { completeness } = report;
  const state = completeness.complete
    ? "complete"
    : `incomplete (${completeness.reason ?? "unknown"})`;
  return [
    "# Jira report\n",
    `Scope: ${scopeText(report)}\n`,
    `Status: ${state}; ${String(completeness.issuesRead)} of ${String(completeness.issuesTotal ?? completeness.issuesRead)} issues read in ${String(completeness.pageCount)} pages.\n`,
    `Report digest: ${report.digest}. Generated ${report.generatedAt}. Every number is computed from the Jira data read, not by a model.\n`,
    progressSection(report),
    epicsSection(report),
    complianceSection(report),
    coverageSection(report),
  ].join("\n");
}

export function exportJiraReport(
  report: JiraReport,
  format: JiraReportExportFormat,
): JiraReportExportResponse {
  const content = format === "csv" ? csvOf(report) : markdownOf(report);
  return {
    format,
    fileName: `keiko-jira-report-${report.digest.slice(0, 12)}.${format === "csv" ? "csv" : "md"}`,
    mediaType: JIRA_REPORT_EXPORT_MEDIA_TYPES[format],
    content,
    byteCount: new TextEncoder().encode(content).byteLength,
    reportDigest: report.digest,
  };
}

const COMMENT_LIST_MAX = 100;
const COMMENT_MAX_CHARS = 30000;
function keyList(label: string, keys: readonly string[]): string {
  if (keys.length === 0) return `${label}: none`;
  const shown = keys.slice(0, COMMENT_LIST_MAX).join(", ");
  const more =
    keys.length > COMMENT_LIST_MAX ? ` and ${String(keys.length - COMMENT_LIST_MAX)} more` : "";
  return `${label} (${String(keys.length)}): ${shown}${more}`;
}
/** Numbers and issue keys only, so the text is safe in a Jira comment and cannot carry markup. */
export function jiraReportCommentText(report: JiraReport): string {
  const { project, unassigned, overdue } = report.progress;
  const { completeness, compliance, coverage } = report;
  const state = completeness.complete
    ? "complete"
    : "incomplete: " + (completeness.reason ?? "unknown");
  const total =
    completeness.issuesTotal === undefined ? "" : " of " + String(completeness.issuesTotal);
  const lines = [
    `Keiko Jira report ${report.scope.projectKey ?? ""} (${state}), digest ${report.digest}`,
    `Issues read: ${String(completeness.issuesRead)}${total}`,
    `Progress: ${String(project.total)} issues, ${String(project.new)} to do, ${String(project.indeterminate)} in progress, ${String(project.done)} done (${String(project.donePercent)}%), ${String(project.noCategory)} without category`,
    `Estimate (${report.scope.estimateUnit === "seconds" ? "seconds" : `unit of ${report.scope.estimateFieldId ?? "field"}`}): ${String(project.estimate.total)} total, ${String(project.estimate.done)} done, ${String(project.estimate.remaining)} remaining`,
    `Open and unassigned: ${String(unassigned)}; open and overdue: ${String(overdue)}`,
    `Compliance: ${String(compliance.issuesWithDeviations)} of ${String(compliance.issuesChecked)} issues deviate (${String(compliance.deviationCount)} deviations)`,
    ...compliance.byRule.map((item) => `Rule ${item.ruleId}: ${String(item.count)} issues`),
    keyList("Epics without members", coverage.uncoveredEpics),
    keyList("Issues without an epic or parent", coverage.orphans),
    ...(coverage.requirements === undefined
      ? []
      : [
          `Requirements named by an issue: ${String(coverage.requirements.covered)} of ${String(coverage.requirements.declared)}`,
          keyList("Requirements without an issue", coverage.requirements.uncovered),
        ]),
  ];
  return lines.join("\n").slice(0, COMMENT_MAX_CHARS);
}
