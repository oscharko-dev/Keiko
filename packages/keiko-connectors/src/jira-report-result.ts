import type {
  JiraReportExportFormat,
  JiraReportSection,
  JiraReportStatus,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_REPORT_EXPORT_FORMATS,
  JIRA_REPORT_RESULT_LIST_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraReportCommentText } from "./jira-report-export.js";
import type { JiraReport, JiraReportProgress } from "./jira-report-types.js";
import type { JiraReportSession } from "./jira-report-session.js";

/** Entries of each list in the default summary; the sections page through the rest. */
export const JIRA_REPORT_SUMMARY_LIST_MAX = 15;
const SUMMARY_TYPE_MAX = 50;
/** Type-status combinations in the default summary; a project rarely has more than this. */
export const JIRA_REPORT_SUMMARY_STATUS_MAX = 60;

function progress(value: JiraReportProgress): CatalogJsonObject {
  return {
    total: value.total,
    new: value.new,
    indeterminate: value.indeterminate,
    done: value.done,
    noCategory: value.noCategory,
    donePercent: value.donePercent,
    estimate: { ...value.estimate },
  };
}
function listed(
  items: readonly CatalogJsonValue[],
  max = JIRA_REPORT_SUMMARY_LIST_MAX,
): CatalogJsonObject {
  return { total: items.length, items: items.slice(0, max) };
}
/** A list bounded for a tool result, with the true size beside it; the export carries every entry. */
function capped<Item extends CatalogJsonValue>(
  items: readonly Item[],
): { readonly items: readonly Item[]; readonly total: number } {
  return { items: items.slice(0, JIRA_REPORT_RESULT_LIST_MAX), total: items.length };
}
function typeItems(
  types: readonly { readonly typeName: string; readonly total: number; readonly done: number }[],
): CatalogJsonObject {
  const { items, total } = capped(types.map((type) => ({ ...type })));
  return { items, total };
}
function epicItems(report: JiraReport): readonly CatalogJsonObject[] {
  return report.epics.map((epic) => ({
    key: epic.key,
    summary: epic.summary,
    typeName: epic.typeName,
    statusName: epic.statusName,
    category: epic.category,
    external: epic.external,
    members: progress(epic.members),
    linked: progress(epic.linked),
    byType: typeItems(epic.byType),
  }));
}
function statusItems(report: JiraReport): readonly CatalogJsonObject[] {
  return report.progress.byStatus.map((item) => ({ ...item }));
}
function orphanItems(report: JiraReport): readonly CatalogJsonObject[] {
  return report.rows
    .filter((row) => row.classification === "orphan")
    .map((row) => ({
      key: row.issue.key,
      summary: row.issue.summary,
      typeName: row.issue.typeName,
      statusName: row.issue.statusName,
    }));
}
function deviationItems(report: JiraReport): readonly CatalogJsonObject[] {
  return report.compliance.deviations.map((item) => ({
    key: item.key,
    ruleIds: capped(item.ruleIds).items,
    fieldIds: capped(item.fieldIds).items,
  }));
}
function requirementItems(report: JiraReport): readonly CatalogJsonObject[] {
  const requirements = report.coverage.requirements;
  if (requirements === undefined) return [];
  return [
    ...requirements.items.map((item) => ({
      id: item.id,
      covered: true,
      coveredBy: capped(item.coveredBy).items,
      coveredByTotal: item.coveredBy.length,
      coveringTotal: item.coveringTotal,
      coveringDone: item.coveringDone,
      itemCount: item.itemCount,
      done: item.done,
      byType: typeItems(item.byType),
    })),
    ...requirements.uncovered.map((id) => ({ id, covered: false })),
  ];
}
function requirementsSummary(report: JiraReport): CatalogJsonValue {
  const requirements = report.coverage.requirements;
  if (requirements === undefined) return null;
  return {
    declared: requirements.declared,
    covered: requirements.covered,
    uncovered: listed(requirements.uncovered),
    items: listed(requirementItems(report).filter((item) => item.covered === true)),
  };
}

/** The bounded default view. Every figure is copied from the computed report. */
export function jiraReportSummary(report: JiraReport): CatalogJsonObject {
  const { completeness, compliance, coverage } = report;
  return {
    digest: report.digest,
    generatedAt: report.generatedAt,
    scope: { ...report.scope },
    completeness: {
      complete: completeness.complete,
      ...(completeness.reason === undefined ? {} : { reason: completeness.reason }),
      ...(completeness.failure === undefined ? {} : { failure: completeness.failure }),
      issuesRead: completeness.issuesRead,
      ...(completeness.issuesTotal === undefined ? {} : { issuesTotal: completeness.issuesTotal }),
      pageCount: completeness.pageCount,
    },
    hierarchy: { ...report.hierarchy },
    progress: {
      project: progress(report.progress.project),
      byType: report.progress.byType.slice(0, SUMMARY_TYPE_MAX).map((type) => ({ ...type })),
      byStatus: listed(statusItems(report), JIRA_REPORT_SUMMARY_STATUS_MAX),
      unassigned: report.progress.unassigned,
      overdue: report.progress.overdue,
    },
    epics: listed(epicItems(report)),
    compliance: {
      requiredFieldRules: compliance.requiredFieldRules,
      checker: compliance.checker,
      issuesChecked: compliance.issuesChecked,
      issuesWithDeviations: compliance.issuesWithDeviations,
      deviationCount: compliance.deviationCount,
      byRule: compliance.byRule.map((item) => ({ ...item })),
      deviations: listed(deviationItems(report)),
    },
    coverage: {
      uncoveredEpics: listed(coverage.uncoveredEpics),
      orphans: listed(orphanItems(report)),
      requirements: requirementsSummary(report),
    },
  };
}

function sectionItems(report: JiraReport, section: JiraReportSection): readonly CatalogJsonValue[] {
  switch (section) {
    case "statuses":
      return statusItems(report);
    case "epics":
      return epicItems(report);
    case "deviations":
      return deviationItems(report);
    case "orphans":
      return orphanItems(report);
    case "uncovered":
      return [...report.coverage.uncoveredEpics];
    case "requirements":
      return requirementItems(report);
    default:
      return [];
  }
}
/** One page of a list of the finished report; `nextStartAt` is present while more remains. */
export function jiraReportSectionPage(
  report: JiraReport,
  section: JiraReportSection,
  startAt: number,
  maxResults: number,
): CatalogJsonObject {
  if (section === "comment") return { name: section, text: jiraReportCommentText(report) };
  const all = sectionItems(report, section);
  const items = all.slice(startAt, startAt + maxResults);
  return {
    name: section,
    total: all.length,
    startAt,
    items,
    ...(startAt + items.length < all.length ? { nextStartAt: startAt + items.length } : {}),
  };
}

export function jiraReportState(session: JiraReportSession): JiraReportStatus {
  if (session.report === undefined) return "reading";
  return session.report.completeness.complete ? "complete" : "incomplete";
}
export function jiraReportProgressView(
  session: JiraReportSession,
  elapsedMs: number,
): CatalogJsonObject {
  const completeness = session.report?.completeness;
  return {
    issuesRead: completeness?.issuesRead ?? session.issues.size,
    ...((completeness?.issuesTotal ?? session.total) === undefined
      ? {}
      : { issuesTotal: completeness?.issuesTotal ?? session.total ?? 0 }),
    pageCount: session.pageCount,
    elapsedMs,
  };
}
export const JIRA_REPORT_EXPORTS_VIEW: readonly JiraReportExportFormat[] =
  JIRA_REPORT_EXPORT_FORMATS;
