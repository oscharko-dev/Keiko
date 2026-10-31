import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  JiraReport,
  JiraReportCompleteness,
  JiraReportContainer,
  JiraReportDeviationRecord,
  JiraReportEstimate,
  JiraReportIssue,
  JiraReportIssueClass,
  JiraReportProgress,
  JiraReportRequirementCoverage,
  JiraReportRow,
  JiraReportScope,
  JiraReportStatusCount,
  JiraReportStatusCounts,
  JiraReportTypeProgress,
} from "./jira-report-types.js";

export interface JiraReportInput {
  readonly issues: readonly JiraReportIssue[];
  readonly scope: JiraReportScope;
  readonly completeness: JiraReportCompleteness;
  readonly hierarchy: JiraReport["hierarchy"];
  readonly requiredFieldRules: JiraReport["compliance"]["requiredFieldRules"];
  readonly checker: JiraReport["compliance"]["checker"];
  readonly declaredRequirements: readonly string[];
  readonly now: Date;
}

/** Issue keys order by project, then numerically; the same order everywhere in a report. */
export function compareJiraKeys(left: string, right: string): number {
  const split = (key: string): readonly [string, number] => {
    const at = key.lastIndexOf("-");
    const number = Number(key.slice(at + 1));
    return at < 0 || !Number.isFinite(number) ? [key, 0] : [key.slice(0, at), number];
  };
  const [leftProject, leftNumber] = split(left);
  const [rightProject, rightNumber] = split(right);
  return leftProject === rightProject
    ? leftNumber - rightNumber
    : leftProject.localeCompare(rightProject, "en");
}

interface Graph {
  readonly index: ReadonlyMap<string, JiraReportIssue>;
  readonly children: ReadonlyMap<string, readonly JiraReportIssue[]>;
  /** Top ancestor of every issue that has a parent; a key outside the scope marks an external one. */
  readonly rootOf: ReadonlyMap<string, string>;
  readonly containers: ReadonlySet<string>;
  /** Parentless leaf issues attached to a container through an issue link. */
  readonly linkedTo: ReadonlyMap<string, readonly string[]>;
  readonly membersByRoot: ReadonlyMap<string, readonly JiraReportIssue[]>;
  readonly linkedByRoot: ReadonlyMap<string, readonly JiraReportIssue[]>;
}

function childrenOf(issues: readonly JiraReportIssue[]): Map<string, JiraReportIssue[]> {
  const children = new Map<string, JiraReportIssue[]>();
  for (const issue of issues) {
    if (issue.parentKey === undefined) continue;
    const siblings = children.get(issue.parentKey) ?? [];
    siblings.push(issue);
    children.set(issue.parentKey, siblings);
  }
  return children;
}
function rootKey(issue: JiraReportIssue, index: ReadonlyMap<string, JiraReportIssue>): string {
  const path: string[] = [issue.key];
  let current = issue;
  while (current.parentKey !== undefined) {
    const parent = index.get(current.parentKey);
    if (parent === undefined) return current.parentKey;
    if (path.includes(parent.key))
      return path.slice(path.indexOf(parent.key)).sort(compareJiraKeys)[0] ?? parent.key;
    path.push(parent.key);
    current = parent;
  }
  return current.key;
}
function linkedAttachments(
  issues: readonly JiraReportIssue[],
  index: ReadonlyMap<string, JiraReportIssue>,
  rootOf: ReadonlyMap<string, string>,
  containers: ReadonlySet<string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.parentKey !== undefined || containers.has(issue.key)) continue;
    const targets = new Set<string>();
    for (const key of issue.linkedKeys) {
      if (!index.has(key)) continue;
      const root = rootOf.get(key) ?? key;
      if (root !== issue.key && containers.has(root)) targets.add(root);
    }
    if (targets.size > 0) result.set(issue.key, [...targets].sort(compareJiraKeys));
  }
  return result;
}
function groupBy(
  entries: Iterable<readonly [string, string]>,
  index: ReadonlyMap<string, JiraReportIssue>,
): Map<string, JiraReportIssue[]> {
  const groups = new Map<string, JiraReportIssue[]>();
  for (const [key, group] of entries) {
    const issue = index.get(key);
    if (issue === undefined) continue;
    const members = groups.get(group) ?? [];
    members.push(issue);
    groups.set(group, members);
  }
  return groups;
}
function buildGraph(issues: readonly JiraReportIssue[]): Graph {
  const index = new Map(issues.map((issue) => [issue.key, issue]));
  const rootOf = new Map<string, string>();
  for (const issue of issues)
    if (issue.parentKey !== undefined) rootOf.set(issue.key, rootKey(issue, index));
  // A root holding only sub-tasks is a task with its parts, not a container of work.
  const containers = new Set<string>();
  for (const issue of issues) {
    if (issue.epicMarker) containers.add(issue.key);
    const root = rootOf.get(issue.key);
    if (root !== undefined && !issue.subtask) containers.add(root);
  }
  const linkedTo = linkedAttachments(issues, index, rootOf, containers);
  // Issues arrive sorted by key, so every group keeps that order.
  const linkedEntries = [...linkedTo].flatMap(([key, roots]) =>
    roots.map((root): readonly [string, string] => [key, root]),
  );
  return {
    index,
    children: childrenOf(issues),
    rootOf,
    containers,
    linkedTo,
    membersByRoot: groupBy(rootOf, index),
    linkedByRoot: groupBy(linkedEntries, index),
  };
}

function emptyCounts(): {
  total: number;
  new: number;
  indeterminate: number;
  done: number;
  noCategory: number;
} {
  return { total: 0, new: 0, indeterminate: 0, done: 0, noCategory: 0 };
}
function countInto(counts: ReturnType<typeof emptyCounts>, issue: JiraReportIssue): void {
  counts.total += 1;
  if (issue.category === "undefined") counts.noCategory += 1;
  else counts[issue.category] += 1;
}
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
function estimateOf(issues: readonly JiraReportIssue[]): JiraReportEstimate {
  let total = 0;
  let done = 0;
  let unestimated = 0;
  for (const issue of issues) {
    if (issue.estimate === undefined) unestimated += 1;
    else {
      total += issue.estimate;
      if (issue.category === "done") done += issue.estimate;
    }
  }
  return { total: round6(total), done: round6(done), remaining: round6(total - done), unestimated };
}
function progressOf(issues: readonly JiraReportIssue[]): JiraReportProgress {
  const counts = emptyCounts();
  for (const issue of issues) countInto(counts, issue);
  const donePercent = counts.total === 0 ? 0 : Math.round((counts.done * 1000) / counts.total) / 10;
  return {
    ...(counts satisfies JiraReportStatusCounts),
    donePercent,
    estimate: estimateOf(issues),
  };
}
function byTypeOf(issues: readonly JiraReportIssue[]): readonly JiraReportTypeProgress[] {
  const types = new Map<string, { total: number; done: number }>();
  for (const issue of issues) {
    const entry = types.get(issue.typeName) ?? { total: 0, done: 0 };
    entry.total += 1;
    if (issue.category === "done") entry.done += 1;
    types.set(issue.typeName, entry);
  }
  return [...types.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([typeName, entry]) => ({ typeName, ...entry }));
}

function byStatusOf(issues: readonly JiraReportIssue[]): readonly JiraReportStatusCount[] {
  const counts = new Map<string, JiraReportStatusCount>();
  for (const issue of issues) {
    const id = `${issue.typeName}\u0000${issue.statusName}\u0000${issue.category}`;
    const entry = counts.get(id);
    counts.set(
      id,
      entry === undefined
        ? {
            typeName: issue.typeName,
            statusName: issue.statusName,
            category: issue.category,
            total: 1,
          }
        : { ...entry, total: entry.total + 1 },
    );
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.typeName.localeCompare(right.typeName, "en") ||
      left.statusName.localeCompare(right.statusName, "en") ||
      left.category.localeCompare(right.category, "en"),
  );
}
function membersOf(graph: Graph, root: string): readonly JiraReportIssue[] {
  return graph.membersByRoot.get(root) ?? [];
}
function linkedOf(graph: Graph, root: string): readonly JiraReportIssue[] {
  return graph.linkedByRoot.get(root) ?? [];
}
function containerOf(graph: Graph, key: string): JiraReportContainer {
  const issue = graph.index.get(key);
  const members = membersOf(graph, key);
  const linked = linkedOf(graph, key);
  return {
    key,
    summary: issue?.summary ?? "",
    typeName: issue?.typeName ?? "",
    statusName: issue?.statusName ?? "",
    category: issue?.category ?? "undefined",
    external: issue === undefined,
    members: progressOf(members),
    linked: progressOf(linked),
    byType: byTypeOf([...members, ...linked]),
  };
}

function complianceOf(
  issues: readonly JiraReportIssue[],
  input: JiraReportInput,
): JiraReport["compliance"] {
  const byRule = new Map<string, number>();
  const deviations: JiraReportDeviationRecord[] = [];
  let deviationCount = 0;
  for (const issue of issues) {
    if (issue.deviations.length === 0) continue;
    deviationCount += issue.deviations.length;
    for (const item of issue.deviations)
      byRule.set(item.ruleId, (byRule.get(item.ruleId) ?? 0) + 1);
    deviations.push({
      key: issue.key,
      ruleIds: [...new Set(issue.deviations.map((item) => item.ruleId))],
      fieldIds: [
        ...new Set(
          issue.deviations.flatMap((item) => (item.fieldId === undefined ? [] : [item.fieldId])),
        ),
      ].sort(compareStrings),
    });
  }
  return {
    requiredFieldRules: input.requiredFieldRules,
    checker: input.checker,
    issuesChecked: issues.length,
    issuesWithDeviations: deviations.length,
    deviationCount,
    byRule: [...byRule.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([ruleId, count]) => ({ ruleId, count })),
    deviations,
  };
}

function descendants(graph: Graph, key: string): readonly JiraReportIssue[] {
  const seen = new Set<string>([key]);
  const result: JiraReportIssue[] = [];
  const stack = [key];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const child of graph.children.get(current) ?? []) {
      if (seen.has(child.key)) continue;
      seen.add(child.key);
      result.push(child);
      stack.push(child.key);
    }
  }
  return result;
}
function requirementItems(graph: Graph, coveredBy: readonly string[]): readonly JiraReportIssue[] {
  const items = new Map<string, JiraReportIssue>();
  for (const key of coveredBy) {
    for (const issue of descendants(graph, key)) items.set(issue.key, issue);
    if (graph.containers.has(key))
      for (const issue of linkedOf(graph, key)) items.set(issue.key, issue);
  }
  for (const key of coveredBy) items.delete(key);
  return [...items.values()];
}
function requirementsOf(
  graph: Graph,
  issues: readonly JiraReportIssue[],
  declared: readonly string[],
): JiraReport["coverage"]["requirements"] {
  if (declared.length === 0) return undefined;
  const ids = [...new Set(declared)].sort((left, right) => left.localeCompare(right, "en"));
  const coverers = new Map<string, string[]>();
  for (const issue of issues)
    for (const id of issue.requirementIds)
      coverers.set(id, [...(coverers.get(id) ?? []), issue.key]);
  const items: JiraReportRequirementCoverage[] = [];
  const uncovered: string[] = [];
  for (const id of ids) {
    const coveredBy = coverers.get(id) ?? [];
    if (coveredBy.length === 0) {
      uncovered.push(id);
      continue;
    }
    const traced = requirementItems(graph, coveredBy);
    items.push({
      id,
      coveredBy,
      itemCount: traced.length,
      done: traced.filter((issue) => issue.category === "done").length,
      byType: byTypeOf(traced),
    });
  }
  return { declared: ids.length, covered: items.length, items, uncovered };
}

function classOf(graph: Graph, issue: JiraReportIssue): JiraReportIssueClass {
  if (graph.rootOf.has(issue.key)) return "member";
  if (graph.containers.has(issue.key)) return "container";
  return graph.linkedTo.has(issue.key) ? "linked" : "orphan";
}
function rowOf(graph: Graph, issue: JiraReportIssue, today: string): JiraReportRow {
  const classification = classOf(graph, issue);
  const root = graph.rootOf.get(issue.key);
  return {
    issue,
    classification,
    containerKeys: root === undefined ? (graph.linkedTo.get(issue.key) ?? []) : [root],
    overdue:
      issue.dueDate !== undefined &&
      issue.dueDate.slice(0, 10) < today &&
      issue.category !== "done",
  };
}

function withDigest(report: Omit<JiraReport, "digest">): JiraReport {
  // The digest covers what Jira holds; when it was read and in how many pages is not part of it.
  const { rows: _rows, generatedAt: _generatedAt, completeness, ...rest } = report;
  const { pageCount: _pageCount, ...stableCompleteness } = completeness;
  const stable = { ...rest, completeness: stableCompleteness };
  return { digest: sha256Hex(canonicalise(stable)), ...report };
}

/** The whole report as pure arithmetic over the records; the model never contributes a number. */
export function buildJiraReport(input: JiraReportInput): JiraReport {
  const issues = [...input.issues].sort((left, right) => compareJiraKeys(left.key, right.key));
  const graph = buildGraph(issues);
  const today = input.now.toISOString().slice(0, 10);
  const rows = issues.map((issue) => rowOf(graph, issue, today));
  const open = issues.filter((issue) => issue.category !== "done");
  const epics = [...graph.containers].sort(compareJiraKeys).map((key) => containerOf(graph, key));
  return withDigest({
    generatedAt: input.now.toISOString(),
    scope: input.scope,
    completeness: input.completeness,
    hierarchy: input.hierarchy,
    progress: {
      project: progressOf(issues),
      byType: byTypeOf(issues),
      byStatus: byStatusOf(issues),
      unassigned: open.filter((issue) => !issue.assigned).length,
      overdue: rows.filter((row) => row.overdue).length,
    },
    epics,
    compliance: complianceOf(issues, input),
    coverage: {
      uncoveredEpics: issues
        .filter((issue) => issue.epicMarker && graph.containers.has(issue.key))
        .filter(
          (issue) => membersOf(graph, issue.key).length + linkedOf(graph, issue.key).length === 0,
        )
        .map((issue) => issue.key),
      orphans: rows.filter((row) => row.classification === "orphan").map((row) => row.issue.key),
      requirements: requirementsOf(graph, issues, input.declaredRequirements),
    },
    rows,
  });
}
