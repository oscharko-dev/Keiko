// The `changes` view of `knowledge.requirements` (#4179, Epic #4173).
//
// A new version of a specification is compared with the backlog through the trace the write path
// left on each item, never through a model's reading of both. The backlog is a Jira report the Chat
// already read under its own grant (`jira.report`, scope chosen by the model); this module reads no
// Jira itself and so cannot widen the Chat's authority. The pure comparison is owned by
// keiko-quality-intelligence; this module resolves the report, bounds the lists and says what the
// baseline could not see.

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
export const UNCHANGED_LIST_MAX = 200;
export const AFFECTED_ISSUES_MAX = 120;
const TITLE_CHARS_MAX = 160;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export type ChangesRefusal = "report-required" | "report-reading" | "report-not-found";

export interface ChangesCounts {
  readonly changed: number;
  readonly removed: number;
  readonly untraced: number;
  readonly unchanged: number;
  readonly affectedIssues: number;
  readonly baselineIssues: number;
  readonly baselineComplete: boolean;
}

/** Which Jira report the comparison read: the one the model named, or the Chat's own of this turn. */
export type ChangesBaselineSource = "explicit" | "turn";

export interface ChangesBaselineQuery {
  readonly reportId: string | undefined;
  readonly projectKey: string | undefined;
  /** When the turn began; a report read earlier may predate edits made since. */
  readonly turnStartedAtMs: number | undefined;
}

export type ChangesResolution =
  | { readonly ok: true; readonly report: JiraReport; readonly source: ChangesBaselineSource }
  | { readonly ok: false; readonly reason: ChangesRefusal; readonly nextStep: string };

const REPORT_CALL = "Call jira.report";

function refusal(reason: ChangesRefusal, nextStep: string): ChangesResolution {
  return { ok: false, reason, nextStep };
}

function requiredStep(projectKey: string | undefined): string {
  const key = projectKey !== undefined && PROJECT_KEY.test(projectKey) ? projectKey : "<project>";
  return (
    `No Jira report was read in this turn. ${REPORT_CALL} with {"projectKey":"${key}"} ` +
    "(repeat with its reportId until status is finished), then call this tool again with " +
    'view "changes".'
  );
}

function sameProject(report: JiraReport, projectKey: string | undefined): boolean {
  return (
    projectKey === undefined || report.scope.projectKey?.toLowerCase() === projectKey.toLowerCase()
  );
}

function readThisTurn(report: JiraReport, turnStartedAtMs: number | undefined): boolean {
  return turnStartedAtMs === undefined || Date.parse(report.generatedAt) >= turnStartedAtMs;
}

function explicitBaseline(
  reports: JiraReportStore | undefined,
  chatId: string,
  reportId: string,
): ChangesResolution {
  const session = reports?.get(reportId, chatId);
  if (session === undefined)
    return refusal(
      "report-not-found",
      `That reportId is unknown to this Chat. Omit reportId, or ${REPORT_CALL} for the project first.`,
    );
  return session.report === undefined
    ? refusal(
        "report-reading",
        `That report is still being read. ${REPORT_CALL} with {"reportId":"${reportId}"} until ` +
          "its status is finished, then repeat this call.",
      )
    : { ok: true, report: session.report, source: "explicit" };
}

/**
 * The report the comparison reads. A `reportId` names one; without it the Chat's newest finished
 * report of this turn (of `projectKey`, when given) is the baseline, so the model needs no report
 * id. A report belongs to the Chat that read it: another Chat's is indistinguishable from absent.
 * A refusal names the exact next step.
 */
export function resolveChangesBaseline(
  reports: JiraReportStore | undefined,
  chatId: string,
  query: ChangesBaselineQuery,
): ChangesResolution {
  if (query.reportId !== undefined) return explicitBaseline(reports, chatId, query.reportId);
  const report = reports
    ?.finished(chatId)
    .flatMap((session) => (session.report === undefined ? [] : [session.report]))
    .find(
      (candidate) =>
        sameProject(candidate, query.projectKey) && readThisTurn(candidate, query.turnStartedAtMs),
    );
  return report === undefined
    ? refusal("report-required", requiredStep(query.projectKey))
    : { ok: true, report, source: "turn" };
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
  id: string,
  entry: RequirementInventoryEntry | undefined,
  ambiguous: ReadonlySet<string>,
): string {
  return entry !== undefined && ambiguous.has(id) ? requirementReference(entry) : id;
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
    generatedAt: report.generatedAt,
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
  const unchanged = bounded(result.unchanged, UNCHANGED_LIST_MAX, "unchanged", cut);
  const affected = bounded(result.affectedIssues, AFFECTED_ISSUES_MAX, "affectedIssues", cut);
  return {
    changed: changed.map((item): CatalogJsonObject => ({
      id: nameOf(item.id, item.entry, ambiguous),
      title: redact(item.entry?.title ?? "").slice(0, TITLE_CHARS_MAX),
      issues: [...item.issues],
    })),
    removed: removed.map((item): CatalogJsonObject => ({
      id: item.id,
      issues: [...item.issues],
    })),
    untraced: untraced.map((item) => nameOf(item.id, item.entry, ambiguous)),
    unchanged: unchanged.map((entry) => nameOf(entry.id, entry, ambiguous)),
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
