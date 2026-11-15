import {
  JIRA_REPORT_EXPORT_MEDIA_TYPES,
  type JiraReportExportFormat,
  type JiraReportExportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  JiraReport,
  JiraReportContainer,
  JiraReportProgress,
  JiraReportRequirementCoverage,
  JiraReportRow,
} from "./jira-report-types.js";
import { jiraReportDataText, jiraReportWikiPlainText } from "./jira-report-data-text.js";
import { jiraReportEstimateSummary } from "./jira-report-figures.js";

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

/** The index of the `summary` column, where an uncovered derived requirement states its name. */
const CSV_SUMMARY_COLUMN = 16;

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
function coveredRow(item: JiraReportRequirementCoverage, kind: string): string {
  return csvRow([
    kind,
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
  ]);
}
function uncoveredRow(id: string, kind: string, name: string | undefined): string {
  return csvRow([
    kind,
    id,
    undefined,
    undefined,
    undefined,
    "uncovered",
    ...Array.from({ length: CSV_SUMMARY_COLUMN - 6 }, () => undefined),
    name,
  ]);
}
/** Derived units are rows of their own kind, so a spreadsheet never mixes them into the headline. */
function requirementRows(report: JiraReport): readonly string[] {
  const requirements = report.coverage.requirements;
  if (requirements === undefined) return [];
  const { derived } = requirements;
  return [
    ...requirements.items.map((item) => coveredRow(item, "requirement")),
    ...requirements.uncovered.map((id) =>
      uncoveredRow(id, "requirement", requirements.uncoveredLabels[id]),
    ),
    ...(derived?.items.map((item) => coveredRow(item, "derived-requirement")) ?? []),
    ...(derived?.uncovered.map((id) =>
      uncoveredRow(id, "derived-requirement", derived.names[id]),
    ) ?? []),
  ];
}
// Spreadsheet programs read a UTF-8 CSV as text in their own code page without this mark.
const BYTE_ORDER_MARK = "\uFEFF";
/** The unit of every estimate and the date overdue was judged against, stated beside the figures. */
function unitsText(report: JiraReport): string {
  const { estimateUnit, estimateFieldId, asOf, timeZone } = report.scope;
  if (estimateUnit === "unavailable")
    return `estimateUnit=unavailable;estimateReason=${report.scope.estimateUnavailableReason ?? "metadata-unavailable"};asOf=${asOf} ${timeZone}`;
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
  return String(value)
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(MARKDOWN_SPECIAL, String.raw`\$&`);
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

/** A field name in the Markdown export: neutralised, quoted and escaped like every Jira text there. */
const markdownLabel = (name: string): string => `"${markdownText(jiraReportDataText(name))}"`;

function progressSection(report: JiraReport): string {
  const { project, byType, unassigned, overdue } = report.progress;
  return [
    "## Progress\n",
    table(PROGRESS_HEADER, [progressRow("Project", project)]),
    `${jiraReportEstimateSummary(report, markdownLabel)}.\n`,
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
    `${String(compliance.issuesJudged)} issues judged, ${String(compliance.issuesWithDeviations)} with deviations, ${String(compliance.deviationCount)} deviations.\n`,
    ...(compliance.issuesWithoutTemplate === 0
      ? []
      : [
          `${String(compliance.issuesWithoutTemplate)} issues are covered by no issue template and were not judged against one.\n`,
          table(
            ["Issue type without template", "Issues"],
            compliance.withoutTemplateByType.map((item) => [item.typeName, item.count]),
          ),
        ]),
    table(
      ["Rule", "Issues"],
      compliance.byRule.map((item) => [item.ruleId, item.count]),
    ),
    "### Deviations per issue\n",
    table(
      ["Issue", "Rules", "Fields", "Details"],
      compliance.deviations.map((item) => [
        item.key,
        item.ruleIds.join(", "),
        item.fieldIds.join(", "),
        item.details.join("; "),
      ]),
    ),
  ].join("\n");
}
function listOf(items: readonly string[]): string {
  return items.length === 0 ? "_None._\n" : `${items.join(", ")}\n`;
}
const UNOBSERVED_ROLES_NOTE =
  "_Not determinable: no issue in this scope holds work, so empty containers cannot be told from standalone issues._\n";
const INFERRED_PARENT_NOTE =
  "_Not verified: the parent relation comes from a custom field whose role Jira does not state; name it in parentFieldIds to confirm it._\n";
const REQUIREMENT_REFERENCE_NOTE =
  "Requirement coverage counts textual references in the issues read. Source revisions and requirement satisfaction are not verified.";
function derivedSection(
  derived: NonNullable<NonNullable<JiraReport["coverage"]["requirements"]>["derived"]>,
): readonly string[] {
  return [
    "### Derived requirements\n",
    `${String(derived.covered)} of ${String(derived.declared)} units Keiko derived from statements without an identifier are named by an issue. They are not counted above.\n`,
    table(
      ["Derived requirement", "Statement", "Named by"],
      [
        ...derived.items.map((item) => [
          item.id,
          markdownText(derived.names[item.id] ?? ""),
          item.coveredBy.join(", "),
        ]),
        ...derived.uncovered.map((id) => [id, markdownText(derived.names[id] ?? ""), ""]),
      ],
    ),
  ];
}
function coverageSection(report: JiraReport): string {
  const { coverage } = report;
  const lines = [
    "## Coverage\n",
    ...(report.hierarchy.inferredFieldCount > 0 ? [INFERRED_PARENT_NOTE] : []),
    "### Epics without members\n",
    ...(coverage.containerRoles === "unobserved" ? [UNOBSERVED_ROLES_NOTE] : []),
    listOf(coverage.uncoveredEpics),
    "### Issues without an epic or parent\n",
    listOf(coverage.orphans),
  ];
  const requirements = coverage.requirements;
  if (requirements !== undefined)
    lines.push(
      "### Requirements\n",
      `${String(requirements.covered)} of ${String(requirements.declared)} requirements are named by an issue.\n`,
      REQUIREMENT_REFERENCE_NOTE,
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
      listOf(
        requirements.uncovered.map((id) => {
          const label = requirements.uncoveredLabels[id];
          return label === undefined ? id : `${id} (${markdownText(label)})`;
        }),
      ),
    );
  if (requirements?.derived !== undefined) lines.push(...derivedSection(requirements.derived));
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
    `Status: ${state}; ${readText(report)} issues read in ${String(completeness.pageCount)} pages.\n`,
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
function stateText(report: JiraReport): string {
  const { completeness } = report;
  return completeness.complete ? "complete" : `incomplete: ${completeness.reason ?? "unknown"}`;
}
function readText(report: JiraReport): string {
  const { issuesRead, issuesTotal } = report.completeness;
  const total = issuesTotal === undefined ? " of an unknown total" : ` of ${String(issuesTotal)}`;
  return `${String(issuesRead)}${total}`;
}
/** A field name in a Jira comment: letters, digits and spaces only, since Jira renders the comment as wiki markup. */
const wikiLabel = (name: string): string => `"${jiraReportWikiPlainText(name)}"`;

/**
 * Numbers, issue keys and field names reduced to plain letters and digits, so the text is safe in a
 * Jira comment, which Jira renders as wiki markup, and cannot carry markup, an image or a link.
 */
export function jiraReportCommentText(report: JiraReport): string {
  const { project, unassigned, overdue } = report.progress;
  const { compliance, coverage } = report;
  const lines = [
    `Keiko Jira report ${report.scope.projectKey ?? ""} (${stateText(report)}), digest ${report.digest}`,
    `Issues read: ${readText(report)}`,
    `Progress: ${String(project.total)} issues, ${String(project.new)} to do, ${String(project.indeterminate)} in progress, ${String(project.done)} done (${String(project.donePercent)}%), ${String(project.noCategory)} without category`,
    jiraReportEstimateSummary(report, wikiLabel),
    `Open and unassigned: ${String(unassigned)}; open and overdue: ${String(overdue)}`,
    `Compliance: ${String(compliance.issuesWithDeviations)} of ${String(compliance.issuesJudged)} issues deviate (${String(compliance.deviationCount)} deviations)`,
    `Required-field rules: ${compliance.requiredFieldRules}. Template checker: ${compliance.checker}.`,
    ...(compliance.issuesWithoutTemplate === 0
      ? []
      : [
          `Not judged by any template: ${String(compliance.issuesWithoutTemplate)} issues of ${String(compliance.withoutTemplateByType.length)} issue types`,
        ]),
    ...compliance.byRule.map((item) => `Rule ${item.ruleId}: ${String(item.count)} issues`),
    ...(report.hierarchy.inferredFieldCount > 0
      ? ["Parent relation: not verified, inferred from a custom field of unstated role"]
      : []),
    ...(coverage.containerRoles === "unobserved"
      ? ["Epics without members: not determinable, no issue in this scope holds work"]
      : [keyList("Epics without members", coverage.uncoveredEpics)]),
    keyList("Issues without an epic or parent", coverage.orphans),
    ...(coverage.requirements === undefined
      ? []
      : [
          `Requirements named by an issue: ${String(coverage.requirements.covered)} of ${String(coverage.requirements.declared)}`,
          REQUIREMENT_REFERENCE_NOTE,
          keyList("Requirements without an issue", coverage.requirements.uncovered),
          ...(coverage.requirements.derived === undefined
            ? []
            : [
                `Derived requirements named by an issue: ${String(coverage.requirements.derived.covered)} of ${String(coverage.requirements.derived.declared)}`,
              ]),
        ]),
  ];
  return lines.join("\n").slice(0, COMMENT_MAX_CHARS);
}
