// The `changes` view of `knowledge.requirements` (#4179, Epic #4173).
//
// A new version of a specification is compared with the backlog through the trace the write path
// left on each item, never through a model's reading of both. The backlog is a Jira report the Chat
// already read under its own grant (`jira.report`, scope chosen by the model); this module reads no
// Jira itself and so cannot widen the Chat's authority. The pure comparison is owned by
// keiko-quality-intelligence; this module bounds the lists and says what the baseline could not see.

import type { JiraReport, JiraReportStore } from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  compareRequirementsWithTrace,
  requirementReference,
  type RequirementChange,
  type RequirementChanges,
  type RequirementInventoryEntry,
} from "@oscharko-dev/keiko-quality-intelligence";

import type { RequirementCollection } from "./requirement-inventory.js";

export const CHANGE_LIST_MAX = 60;
export const UNTRACED_LIST_MAX = 200;
export const AFFECTED_ISSUES_MAX = 120;
const TITLE_CHARS_MAX = 160;

export type ChangesRefusal = "report-required" | "report-not-found";

export interface ChangesCounts {
  readonly changed: number;
  readonly removed: number;
  readonly untraced: number;
  readonly unchanged: number;
  readonly affectedIssues: number;
  readonly baselineIssues: number;
  readonly baselineComplete: boolean;
}

export type ChangesResolution =
  | { readonly ok: true; readonly report: JiraReport }
  | { readonly ok: false; readonly reason: ChangesRefusal };

/** The report belongs to this Chat or is indistinguishable from absent; one still reading has none. */
export function resolveChangesBaseline(
  reports: JiraReportStore | undefined,
  chatId: string,
  reportId: string | undefined,
): ChangesResolution {
  if (reportId === undefined) return { ok: false, reason: "report-required" };
  const report = reports?.get(reportId, chatId)?.report;
  return report === undefined ? { ok: false, reason: "report-not-found" } : { ok: true, report };
}

function bounded<Item>(
  items: readonly Item[],
  max: number,
  name: string,
  cut: string[],
): readonly Item[] {
  if (items.length > max) cut.push(name);
  return items.slice(0, max);
}

/** A plain identifier unless several documents define it; then the scoped reference. */
function nameOf(
  change: RequirementChange<RequirementInventoryEntry>,
  ambiguous: ReadonlySet<string>,
): string {
  return change.entry !== undefined && ambiguous.has(change.id)
    ? requirementReference(change.entry)
    : change.id;
}

export interface ChangesView {
  readonly data: CatalogJsonObject;
  readonly counts: ChangesCounts;
}

type Changes = RequirementChanges<RequirementInventoryEntry>;
type ChangeList = readonly RequirementChange<RequirementInventoryEntry>[];

function countsOf(result: Changes, report: JiraReport): ChangesCounts {
  const count = (status: RequirementChange["status"]): number =>
    result.items.filter((item) => item.status === status).length;
  return {
    changed: count("changed"),
    removed: count("removed"),
    untraced: count("untraced"),
    unchanged: result.unchangedCount,
    affectedIssues: result.affectedIssues.length,
    baselineIssues: result.tracedIssueCount,
    baselineComplete: report.completeness.complete,
  };
}

function baselineOf(result: Changes, report: JiraReport): CatalogJsonObject {
  const { completeness } = report;
  return {
    complete: completeness.complete,
    issuesRead: completeness.issuesRead,
    ...(completeness.issuesTotal === undefined ? {} : { issuesTotal: completeness.issuesTotal }),
    tracedIssueCount: result.tracedIssueCount,
    unmatchedIssueCount: result.unmatchedIssueCount,
  };
}

function listsOf(
  result: Changes,
  collection: RequirementCollection,
  redact: (value: string) => string,
): CatalogJsonObject {
  const ambiguous = new Set(collection.ambiguousIds);
  const cut: string[] = [];
  const of = (status: RequirementChange["status"]): ChangeList =>
    result.items.filter((item) => item.status === status);
  const changed = bounded(of("changed"), CHANGE_LIST_MAX, "changed", cut);
  const removed = bounded(of("removed"), CHANGE_LIST_MAX, "removed", cut);
  const untraced = bounded(of("untraced"), UNTRACED_LIST_MAX, "untraced", cut);
  const affected = bounded(result.affectedIssues, AFFECTED_ISSUES_MAX, "affectedIssues", cut);
  return {
    changed: changed.map((item): CatalogJsonObject => ({
      id: nameOf(item, ambiguous),
      title: redact(item.entry?.title ?? "").slice(0, TITLE_CHARS_MAX),
      issues: [...item.issues],
    })),
    removed: removed.map((item): CatalogJsonObject => ({
      id: item.id,
      issues: [...item.issues],
    })),
    untraced: untraced.map((item) => nameOf(item, ambiguous)),
    affectedIssues: [...affected],
    ...(cut.length === 0 ? {} : { truncated: cut }),
  };
}

export function changesView(
  collection: RequirementCollection,
  report: JiraReport,
  redact: (value: string) => string,
): ChangesView {
  const result = compareRequirementsWithTrace(
    collection.units.map((unit) => unit.entry),
    collection.documents.map((document) => document.documentScope),
    report.rows.map((row) => ({ key: row.issue.key, labels: row.issue.labels })),
  );
  const counts = countsOf(result, report);
  const data: CatalogJsonObject = {
    baseline: baselineOf(result, report),
    counts: {
      changed: counts.changed,
      removed: counts.removed,
      untraced: counts.untraced,
      unchanged: counts.unchanged,
    },
    ...listsOf(result, collection, redact),
  };
  return { data, counts };
}
