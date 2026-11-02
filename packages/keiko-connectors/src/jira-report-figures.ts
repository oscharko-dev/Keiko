import { Buffer } from "node:buffer";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraReport, JiraReportContainer } from "./jira-report-types.js";

/** Lines per list; the sections page the rest, and the block says how many it left out. */
export const JIRA_REPORT_FIGURES_LINES_MAX = 300;
const SECONDS_PER_HOUR = 3600;
/** The text is one string of the tool result, so the catalog's encoded scalar bound is its ceiling. */
const FIGURES_BYTES_MAX = TOOL_CATALOG_LIMITS.maxStringBytes;
/** Room kept for the line that says how many entries a list left out, per list. */
const MORE_LINE_BYTES = 96;

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
function bytesOf(text: string): number {
  return Buffer.byteLength(text) + 1;
}
/** The leading lines that fit the line cap and the encoded byte budget. */
function cut(lines: readonly string[], byteBudget: number): readonly string[] {
  let used = 0;
  let shown = 0;
  for (const text of lines.slice(0, JIRA_REPORT_FIGURES_LINES_MAX)) {
    used += bytesOf(text);
    if (used > byteBudget) break;
    shown += 1;
  }
  return lines.slice(0, shown);
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

interface Listing {
  readonly lines: readonly string[];
  readonly more: readonly string[];
}
/**
 * One list after another shares what is left of the byte bound: each takes at most an equal share
 * of the rest among the lists still to come, so a list that needs less leaves the remainder to the
 * others.
 */
function fitter(
  budget: number,
  listCount: number,
): (lines: readonly string[], section: string) => Listing {
  let remaining = budget;
  let waiting = listCount;
  return (lines, section) => {
    const share = Math.floor(remaining / Math.max(1, waiting));
    const kept = cut(lines, Math.max(0, share - MORE_LINE_BYTES));
    const note = more(lines.length, kept.length, section);
    remaining -= fixedBytes(kept) + (note.length > 0 ? MORE_LINE_BYTES : 0);
    waiting -= 1;
    return { lines: kept, more: note };
  };
}
function fixedBytes(lines: readonly string[]): number {
  return lines.reduce((sum, text) => sum + bytesOf(text), 0);
}

/**
 * The numbers of the report as plain lines a model can quote without computing or reshaping them:
 * every issue type and status combination, every container's issues and done issues, and the
 * estimate totals. It is derived from the computed report only, so a weaker model that copies a
 * line states exactly what the report holds (#4181). A list longer than the line cap or than the
 * encoded size the tool result allows one string says how many entries it left out.
 */
export function jiraReportFigures(report: JiraReport): string {
  const { project, byStatus } = report.progress;
  const inScope = report.epics.filter((item) => !item.external);
  const outside = report.epics.filter((item) => item.external);
  const head = [
    `Issues in the report: ${String(project.total)}; done: ${String(project.done)}`,
    "Issues per type and status (type;status;issues):",
  ];
  const epicsHead = "Issues per epic or container (key;type;issues in it;of which done):";
  const outsideHead =
    "Containers outside the scope that hold issues of it (key;type;issues in it;of which done):";
  const estimate = estimateLines(report);
  const fit = fitter(
    FIGURES_BYTES_MAX - fixedBytes([...head, epicsHead, outsideHead, ...estimate]),
    outside.length === 0 ? 2 : 3,
  );
  const statuses = fit(
    byStatus.map((item) => line([item.typeName, item.statusName, item.total])),
    "statuses",
  );
  const epics = fit(containerLines(inScope), "epics");
  const external = fit(containerLines(outside), "epics");
  const lines = [
    ...head,
    ...statuses.lines,
    ...statuses.more,
    epicsHead,
    ...epics.lines,
    ...epics.more,
    ...(outside.length === 0 ? [] : [outsideHead, ...external.lines, ...external.more]),
    ...estimate,
  ];
  return lines.join("\n");
}
