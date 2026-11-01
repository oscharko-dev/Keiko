import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION,
  CONTEXT,
  NOW,
  harness,
  idOf,
  record,
  reportOf,
} from "./jira-report.harness.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";
import {
  ACCEPTANCE,
  fixtureJira,
  syntheticProject,
  type FixtureIssue,
} from "./jira-report.fixture.js";
import { invalidJiraReportArguments, parseJiraReportArgs } from "./jira-report-args.js";
import { reportJql, stripJqlOrdering } from "./jira-report-session.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import type { JiraReport, JiraReportComplianceChecker } from "./jira-report-types.js";

// ─── The independent oracle: plain loops over the seeded specification ───────────────────────────
function count(issues: readonly FixtureIssue[], category: string): number {
  return issues.filter((issue) => issue.category === category).length;
}
function epicOf(issue: FixtureIssue, all: readonly FixtureIssue[]): string | undefined {
  if (issue.epic !== undefined) return issue.epic;
  const parent = all.find((candidate) => candidate.key === issue.parent);
  return parent?.epic;
}
function linkedEpic(issue: FixtureIssue, all: readonly FixtureIssue[]): string | undefined {
  const target = all.find((candidate) => candidate.key === issue.links[0]);
  return target === undefined ? undefined : epicOf(target, all);
}
interface Oracle {
  readonly total: number;
  readonly byCategory: Record<string, number>;
  readonly estimate: { total: number; done: number; unestimated: number };
  readonly unassigned: number;
  readonly overdue: number;
  readonly byTypeStatus: Map<string, number>;
  readonly members: Map<string, FixtureIssue[]>;
  readonly linked: Map<string, FixtureIssue[]>;
  readonly orphans: string[];
  readonly deviations: string[];
}
function push(map: Map<string, FixtureIssue[]>, key: string, issue: FixtureIssue): void {
  map.set(key, [...(map.get(key) ?? []), issue]);
}
function placement(all: readonly FixtureIssue[]): {
  members: Map<string, FixtureIssue[]>;
  linked: Map<string, FixtureIssue[]>;
  orphans: string[];
} {
  const members = new Map<string, FixtureIssue[]>();
  const linked = new Map<string, FixtureIssue[]>();
  const orphans: string[] = [];
  for (const issue of all) {
    const epic = epicOf(issue, all);
    const via = issue.type === "Bug" ? linkedEpic(issue, all) : undefined;
    if (issue.type === "Epic") continue;
    if (epic !== undefined) push(members, epic, issue);
    else if (via !== undefined) push(linked, via, issue);
    else if (issue.type !== "Sub-task") orphans.push(issue.key);
  }
  return { members, linked, orphans };
}
function sum(issues: readonly FixtureIssue[]): number {
  return issues.reduce((total, issue) => total + (issue.seconds ?? 0), 0);
}
function oracle(all: readonly FixtureIssue[]): Oracle {
  const byTypeStatus = new Map<string, number>();
  for (const issue of all) {
    const id = `${issue.type};${issue.status}`;
    byTypeStatus.set(id, (byTypeStatus.get(id) ?? 0) + 1);
  }
  const open = all.filter((issue) => issue.category !== "done");
  return {
    total: all.length,
    byCategory: {
      new: count(all, "new"),
      indeterminate: count(all, "indeterminate"),
      done: count(all, "done"),
    },
    estimate: {
      total: sum(all),
      done: sum(all.filter((issue) => issue.category === "done")),
      unestimated: all.filter((issue) => issue.seconds === undefined).length,
    },
    unassigned: open.filter((issue) => !issue.assignee).length,
    overdue: open.filter((issue) => issue.due !== undefined && issue.due < "2026-10-31").length,
    byTypeStatus,
    ...placement(all),
    deviations: all
      .filter((issue) => issue.type === "Story" && issue.acceptance === null)
      .map((issue) => issue.key),
  };
}

describe("jira.report over a project of any size", () => {
  const issues = syntheticProject(2350);
  const expected = oracle(issues);

  it("reads every page and equals the independent aggregation exactly", async () => {
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP" });
    expect(result.isError).not.toBe(true);
    expect(result.data.status).toBe("complete");
    const report = reportOf(result);
    expect(record(report.completeness)).toMatchObject({
      complete: true,
      issuesRead: 2350,
      issuesTotal: 2350,
    });
    const progress = record(record(report.progress).project);
    expect(progress).toMatchObject({
      total: expected.total,
      new: expected.byCategory.new,
      indeterminate: expected.byCategory.indeterminate,
      done: expected.byCategory.done,
      noCategory: 0,
    });
    expect(record(progress.estimate)).toMatchObject(expected.estimate);
    expect(record(report.progress)).toMatchObject({
      unassigned: expected.unassigned,
      overdue: expected.overdue,
    });
    // More than one page was needed and the page size grew while pages stayed within the cap.
    expect(h.fixture.searches.length).toBeGreaterThan(3);
    expect(Math.max(...h.fixture.searches.map((s) => s.maxResults))).toBeGreaterThan(100);
  });

  it("reports the count per issue type and status name that a JQL aggregation gives", async () => {
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP" });
    const id = idOf(result);
    const section = await h.run({ reportId: id, section: "statuses", maxResults: 100 });
    const items = record(section.data.section).items as readonly Record<string, unknown>[];
    const reported = new Map(
      items.map((item) => [`${String(item.typeName)};${String(item.statusName)}`, item.total]),
    );
    expect(reported).toEqual(expected.byTypeStatus);
  });

  it("returns the named section of a new report once it completes in the same call (#4181)", async () => {
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP", section: "statuses", maxResults: 100 });
    expect(result.isError).not.toBe(true);
    expect(result.data.reportId).toBeTypeOf("string");
    const items = record(result.data.section).items as readonly Record<string, unknown>[];
    const reported = new Map(
      items.map((item) => [`${String(item.typeName)};${String(item.statusName)}`, item.total]),
    );
    expect(reported).toEqual(expected.byTypeStatus);
    expect(h.activity.at(-1)).toMatchObject({ phase: "section", continued: false });
  });

  it("names the report a section page belongs to, also for the comment of a new report (#4173)", async () => {
    const h = harness({ issues });
    const comment = await h.run({ projectKey: "REP", section: "comment" });
    const identity = record(comment.data.report);
    expect(Object.keys(identity).sort()).toEqual(["completeness", "digest", "generatedAt"]);
    expect(record(identity.completeness)).toMatchObject({
      complete: true,
      issuesRead: issues.length,
    });
    expect(record(comment.data.section).text).toBeTypeOf("string");
    const summary = reportOf(await h.run({ reportId: idOf(comment) }));
    expect(identity.digest).toBe(summary.digest);
    const page = await h.run({ reportId: idOf(comment), section: "statuses", maxResults: 100 });
    expect(record(page.data.report).digest).toBe(summary.digest);
  });

  it("computes progress per epic, uncovered epics and orphans from the hierarchy", async () => {
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP" });
    const id = idOf(result);
    const epics = record(
      (await h.run({ reportId: id, section: "epics", maxResults: 100 })).data.section,
    ).items as readonly Record<string, unknown>[];
    for (const epic of epics) {
      const key = String(epic.key);
      const members = expected.members.get(key) ?? [];
      const linked = expected.linked.get(key) ?? [];
      expect(record(epic.members)).toMatchObject({
        total: members.length,
        new: count(members, "new"),
        indeterminate: count(members, "indeterminate"),
        done: count(members, "done"),
      });
      expect(record(epic.linked)).toMatchObject({ total: linked.length });
    }
    expect(epics.map((epic) => epic.key)).toEqual(["REP-1", "REP-2", "REP-3", "REP-4"]);
    const report = reportOf(result);
    expect(record(record(report.coverage).uncoveredEpics).items).toEqual(["REP-4"]);
    const orphans = await h.run({ reportId: id, section: "orphans", maxResults: 100 });
    const orphanKeys = (
      record(orphans.data.section).items as readonly Record<string, unknown>[]
    ).map((i) => i.key);
    const allOrphans: unknown[] = [...orphanKeys];
    let next = record(orphans.data.section).nextStartAt;
    while (typeof next === "number") {
      const page = record(
        (await h.run({ reportId: id, section: "orphans", startAt: next, maxResults: 100 })).data
          .section,
      );
      allOrphans.push(...(page.items as readonly Record<string, unknown>[]).map((i) => i.key));
      next = page.nextStartAt;
    }
    expect([...allOrphans].sort()).toEqual([...expected.orphans].sort());
    expect(record(record(report.coverage).orphans).total).toBe(expected.orphans.length);
  });

  it("lists exactly the issues that miss a field the instance requires on create", async () => {
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP" });
    const compliance = record(reportOf(result).compliance);
    expect(compliance).toMatchObject({
      requiredFieldRules: "applied",
      checker: "none",
      issuesChecked: 2350,
      issuesWithDeviations: expected.deviations.length,
      deviationCount: expected.deviations.length,
      byRule: [{ ruleId: "required-field-empty", count: expected.deviations.length }],
    });
    const stored = h.session(idOf(result));
    expect(stored?.compliance.deviations.map((d) => d.key).sort()).toEqual(
      [...expected.deviations].sort(),
    );
    expect(stored?.compliance.deviations[0]).toMatchObject({
      ruleIds: ["required-field-empty"],
      fieldIds: [ACCEPTANCE],
    });
  });

  it("adapts the page size when a response exceeds the transport cap and still reads everything", async () => {
    const h = harness({ issues: syntheticProject(400), truncateAbove: 700 });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("complete");
    const sizes = h.fixture.searches.map((s) => s.maxResults);
    expect(sizes[0]).toBe(100);
    expect(Math.min(...sizes)).toBeLessThan(100);
    expect(record(record(reportOf(result).completeness)).issuesRead).toBe(400);
  });

  it("reports honestly when a single issue never fits the response cap", async () => {
    const h = harness({ issues: syntheticProject(30), truncateAbove: 1 });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(record(reportOf(result).completeness))).toMatchObject({
      complete: false,
      reason: "issue-too-large",
    });
  });
});

describe("resuming a report across tool calls", () => {
  it("returns progress while reading and the same report when it is finished", async () => {
    const issues = syntheticProject(1200);
    let clock = NOW;
    const h = harness({ issues, pageClamp: 100 }, { now: () => (clock += 400), sliceMs: 1000 });
    const first = await h.run({ projectKey: "REP" });
    expect(first.data.status).toBe("reading");
    expect(first.data.report).toBeUndefined();
    const progress = record(first.data.progress);
    expect(progress.issuesRead).toBeGreaterThan(0);
    expect(progress.issuesTotal).toBe(1200);
    expect(typeof first.data.nextStartAt).toBe("number");
    const id = idOf(first);
    let last = first;
    for (let step = 0; step < 40 && last.data.status === "reading"; step += 1)
      last = await h.run({ reportId: id });
    expect(last.data.status).toBe("complete");
    const single = harness({ issues }, { now: () => NOW });
    const direct = await single.run({ projectKey: "REP" });
    expect(record(reportOf(last).progress)).toEqual(record(reportOf(direct).progress));
    expect(record(reportOf(last).compliance)).toEqual(record(reportOf(direct).compliance));
    expect(reportOf(last).digest).toBe(reportOf(direct).digest);
  });

  it("binds a report to the Chat that started it", async () => {
    const h = harness({ issues: syntheticProject(20) });
    const done = await h.run({ projectKey: "REP" });
    const other = harness(
      { issues: syntheticProject(20) },
      { owner: () => "chat-2", store: h.store },
    );
    const refused = await other.run({ reportId: idOf(done) });
    expect(refused.isError).toBe(true);
    expect(refused.data.reason).toBe("report-not-found");
  });

  it("refuses a concurrent call for the same report", async () => {
    const h = harness({ issues: syntheticProject(20) });
    const done = await h.run({ projectKey: "REP" });
    const session = h.store.get(idOf(done), "chat-1");
    if (session === undefined) throw new Error("missing session");
    session.busy = true;
    const refused = await h.run({ reportId: session.id });
    expect(refused.data.reason).toBe("report-busy");
  });
});

describe("incomplete reads are never reported as complete", () => {
  it("marks a scope that changed while paging", async () => {
    const issues = syntheticProject(250);
    const h = harness({ issues, totalFor: (call, total) => (call > 1 ? total + 3 : total) });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness)).toMatchObject({
      complete: false,
      reason: "scope-changed",
      issuesRead: 100,
      issuesTotal: 250,
    });
  });

  it("marks a read that keeps failing and keeps the issues read so far", async () => {
    const h = harness({ issues: syntheticProject(500), pageClamp: 100, failSearchAt: 3 });
    // Pages overlap by the last issue read, so the second page adds 99 to the first 100.
    let result = await h.run({ projectKey: "REP" });
    const id = idOf(result);
    for (let step = 0; step < 5 && result.data.status === "reading"; step += 1) {
      expect(result.data.lastFailure).toBe("unavailable");
      result = await h.run({ reportId: id });
    }
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness)).toMatchObject({
      complete: false,
      reason: "read-failed",
      issuesRead: 199,
      failure: "unavailable",
    });
  });

  it("stops at the memory budget and says so", async () => {
    const h = harness({ issues: syntheticProject(300) }, { memoryBudgetBytes: 20_000 });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness).reason).toBe("memory-budget");
  });

  it("treats an unreadable hierarchy field list as unavailable, not as no hierarchy", async () => {
    const h = harness({ issues: syntheticProject(60), omitFieldList: true });
    const first = await h.run({ projectKey: "REP" });
    expect(first.data.status).toBe("reading");
    const result = await h.run({ reportId: idOf(first) });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).hierarchy).discovery).toBe("unavailable");
    const named = await harness({ issues: syntheticProject(60), omitFieldList: true }).run({
      projectKey: "REP",
      parentFieldIds: ["customfield_10014"],
    });
    // The hierarchy the named field yields is all there is: epics are read from it, not from a list.
    expect(record(record(reportOf(named).coverage).uncoveredEpics).items).toEqual(["REP-4"]);
    expect(record(reportOf(named).hierarchy)).toMatchObject({
      discovery: "unavailable",
      fieldCount: 1,
      observedFieldCount: 1,
      rejectedFieldCount: 0,
    });
  });
});

describe("scope and compliance sources", () => {
  it("combines the project with a JQL clause in a stable order and drops caller ordering", async () => {
    const h = harness({ issues: syntheticProject(50) });
    await h.run({ projectKey: "REP", jql: "issuetype = Bug ORDER BY created DESC" });
    expect(h.fixture.searches[0]?.jql).toBe(
      'project = "REP" AND (issuetype = Bug) ORDER BY key ASC',
    );
  });

  it("does not claim required-field rules for a JQL-only scope", async () => {
    const h = harness({ issues: syntheticProject(50) });
    const result = await h.run({ jql: "project = REP" });
    expect(record(reportOf(result).compliance).requiredFieldRules).toBe("not-requested");
    expect(h.fixture.requests.some((request) => request.includes("createmeta"))).toBe(false);
  });

  it("marks required-field rules unavailable when createmeta cannot be read", async () => {
    const h = harness({ issues: syntheticProject(50), noRequiredMetadata: true });
    const first = await h.run({ projectKey: "REP" });
    const result = await h.run({ reportId: idOf(first) });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).compliance).requiredFieldRules).toBe("unavailable");
  });

  it("raises exactly the deviations of the shared template checker and drops malformed rule ids", async () => {
    const check = vi.fn((facts: { key: string; typeName: string }) =>
      facts.typeName === "Bug" && facts.key.endsWith("6")
        ? [
            { ruleId: "template.bug.reproduction", fieldId: "description" },
            { ruleId: "Not A Rule Id" },
          ]
        : [],
    );
    const checker: JiraReportComplianceChecker = { fieldIds: ["description"], check };
    const h = harness({ issues: syntheticProject(60) }, { checker });
    const result = await h.run({ projectKey: "REP" });
    const expectedKeys = syntheticProject(60)
      .filter((issue) => issue.type === "Bug" && issue.key.endsWith("6"))
      .map((issue) => issue.key);
    const stored = h.session(idOf(result));
    expect(stored?.compliance.checker).toBe("applied");
    expect(
      stored?.compliance.deviations
        .filter((d) => d.ruleIds.includes("template.bug.reproduction"))
        .map((d) => d.key),
    ).toEqual(expectedKeys);
    expect(stored?.compliance.byRule.map((item) => item.ruleId)).not.toContain("Not A Rule Id");
    expect(h.fixture.requests.some((request) => request.includes("description"))).toBe(true);
  });
});

describe("requirement coverage", () => {
  const issues = syntheticProject(200);
  it("traces declared requirement identifiers through epics to their tasks and lists uncovered ones", async () => {
    const h = harness({ issues });
    const ids = ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006"];
    const result = await h.run({ projectKey: "REP", requirementIds: ids });
    const requirements = record(record(reportOf(result).coverage).requirements);
    expect(requirements).toMatchObject({ declared: 6, covered: 5 });
    expect(record(requirements.uncovered).items).toEqual(["REQ-006"]);
    const stored = h.session(idOf(result))?.coverage.requirements;
    const by = new Map(stored?.items.map((item) => [item.id, item.coveredBy]));
    expect(by.get("REQ-001")).toEqual(["REP-1"]);
    expect(by.get("REQ-002")).toEqual(["REP-2", "REP-45"]);
    expect(by.get("REQ-003")).toEqual(["REP-3", "REP-61"]);
    expect(by.get("REQ-004")).toEqual(["REP-1"]);
    expect(by.get("REQ-005")).toEqual(["REP-41"]);
    const first = stored?.items.find((item) => item.id === "REQ-001");
    const epicMembers = issues.filter((issue) => epicOf(issue, issues) === "REP-1");
    const epicBugs = issues.filter(
      (issue) =>
        issue.type === "Bug" && issue.epic === undefined && linkedEpic(issue, issues) === "REP-1",
    );
    expect(first?.itemCount).toBe(epicMembers.length + epicBugs.length);
    expect(first?.done).toBe(count([...epicMembers, ...epicBugs], "done"));
    expect(h.fixture.requests.some((request) => request.includes("description"))).toBe(true);
  });

  it("does not request descriptions without declared requirements", async () => {
    const h = harness({ issues });
    await h.run({ projectKey: "REP" });
    const search = h.fixture.requests.find((request) => request.includes("search?"));
    expect(search).not.toContain("description");
  });
});

describe("labels of a report row (#4179)", () => {
  it("keeps the labels of each issue so the trace a write left on it can be read back", async () => {
    const h = harness({ issues: syntheticProject(60) });
    const result = await h.run({ projectKey: "REP" });
    const rows = h.session(idOf(result))?.rows ?? [];
    const labelsOf = (key: string): readonly string[] | undefined =>
      rows.find((row) => row.issue.key === key)?.issue.labels;
    expect(labelsOf("REP-45")).toEqual(["REQ-002"]);
    expect(labelsOf("REP-2")).toEqual([]);
  });
});

describe("arguments", () => {
  it.each([
    [{}],
    [{ projectKey: "bad key" }],
    [{ jql: "" }],
    [{ projectKey: "REP", estimateFieldId: "not a field" }],
    [{ projectKey: "REP", requirementIds: ["ok", "has space"] }],
    [{ projectKey: "REP", unknown: true }],
    [{ reportId: "not-a-uuid" }],
    [{ reportId: "00000000-0000-4000-8000-000000000000", projectKey: "REP" }],
    [{ reportId: "00000000-0000-4000-8000-000000000000", section: "nope" }],
  ] as const)("refuses %j", (args) => {
    expect(parseJiraReportArgs(args as CatalogJsonObject)).toBeUndefined();
  });

  it("refuses with a closed reason, logs the refusal and never reads Jira", async () => {
    const h = harness({ issues: syntheticProject(10) });
    const result = await h.run({ projectKey: "REP", model: "claims numbers" });
    expect(result.isError).toBe(true);
    expect(result.data.reason).toBe("invalid-input");
    expect(h.fixture.requests).toEqual([]);
    expect(h.activity).toMatchObject([{ phase: "refused", refusal: "invalid-input" }]);
  });

  it("names the arguments a refused call has to fix, never their values (#4181)", async () => {
    const h = harness({ issues: syntheticProject(10) });
    const result = await h.run({ projectKey: "REP", section: "nope", model: "claims numbers" });
    expect(result.data.invalidArguments).toEqual(["model", "section"]);
    expect(JSON.stringify(result.data)).not.toContain("claims numbers");
    expect(h.activity).toMatchObject([{ refusal: "invalid-input", invalidArgumentCount: 2 }]);
  });

  it.each([
    [{}, ["jql", "projectKey"]],
    [{ jql: "ORDER BY key" }, ["jql", "projectKey"]],
    [{ projectKey: "bad key" }, ["projectKey"]],
    [{ projectKey: "REP", asOf: "2026-02-30" }, ["asOf"]],
    [{ projectKey: "REP", startAt: -1, maxResults: 101 }, ["maxResults", "startAt"]],
    [{ projectKey: "REP", "bad key!": 1 }, ["(unnamed)"]],
    [{ reportId: "00000000-0000-4000-8000-000000000000", projectKey: "REP" }, ["projectKey"]],
    [{ reportId: "not-a-uuid" }, ["reportId"]],
  ] as const)("names the invalid arguments of %j", (args, invalid) => {
    expect(parseJiraReportArgs(args as CatalogJsonObject)).toBeUndefined();
    expect(invalidJiraReportArguments(args as CatalogJsonObject)).toEqual(invalid);
  });

  it("accepts a section and paging on a new report", () => {
    expect(
      parseJiraReportArgs({ projectKey: "REP", section: "deviations", startAt: 25 }),
    ).toMatchObject({ kind: "new", section: "deviations", startAt: 25, maxResults: 25 });
    expect(invalidJiraReportArguments({ projectKey: "REP", section: "epics" })).toEqual([]);
  });

  it("refuses a Cloud connection", async () => {
    const fixture = fixtureJira({ issues: syntheticProject(10) });
    const result = await executeJiraReportTool(
      { projectKey: "REP" },
      CONTEXT,
      { ...CONNECTION(fixture), deployment: "cloud" },
      { store: createJiraReportStore(), owner: () => "chat-1" },
    );
    expect(result.data.reason).toBe("unsupported-deployment");
  });

  it("strips ordering outside quotes only", () => {
    expect(stripJqlOrdering('summary ~ "order by" ORDER BY key')).toBe('summary ~ "order by"');
    expect(stripJqlOrdering("ORDER BY key")).toBe("");
    expect(stripJqlOrdering("a = 1")).toBe("a = 1");
    expect(reportJql(undefined, "a = 1")).toBe("a = 1 ORDER BY key ASC");
  });
});

describe("activity", () => {
  it("records counts, closed words and rule ids only", async () => {
    const h = harness({ issues: syntheticProject(100) });
    await h.run({ projectKey: "REP", requirementIds: ["REQ-001"] });
    expect(h.activity).toHaveLength(1);
    const [line] = h.activity;
    expect(line).toMatchObject({
      phase: "read",
      status: "complete",
      scopeKind: "project",
      continued: false,
      issuesRead: 100,
      requirementCount: 1,
      ruleIds: ["required-field-empty"],
      hierarchy: {
        discovery: "complete",
        fieldCount: 3,
        observedFieldCount: 1,
        rejectedFieldCount: 2,
      },
    });
    expect(JSON.stringify(line)).not.toMatch(/REP-|jira\.example|Story|customfield/u);
  });

  it("records an unread hierarchy as unavailable, not as an empty one", async () => {
    const h = harness({ issues: syntheticProject(60), omitFieldList: true });
    await h.run({ projectKey: "REP" });
    expect(h.activity.at(-1)).toMatchObject({ hierarchy: { discovery: "unavailable" } });
  });
});

describe("export", () => {
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (quoted) {
        if (char === '"' && text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        row.push(cell);
        cell = "";
      } else if (char === "\r") {
        // the line break is \r\n
      } else if (char === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += char;
    }
    return rows;
  }
  async function finished(): Promise<{ report: JiraReport; spec: readonly FixtureIssue[] }> {
    const spec = syntheticProject(500);
    const h = harness({ issues: spec });
    const result = await h.run({ projectKey: "REP", requirementIds: ["REQ-001", "REQ-006"] });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("missing report");
    return { report, spec };
  }

  it("exports CSV that parses back to exactly the report's numbers", async () => {
    const { report, spec } = await finished();
    const file = exportJiraReport(report, "csv");
    expect(file).toMatchObject({
      format: "csv",
      mediaType: "text/csv",
      reportDigest: report.digest,
    });
    expect(file.byteCount).toBe(Buffer.byteLength(file.content));
    expect(file.content.startsWith("\uFEFF")).toBe(true);
    const [header, summary, ...rest] = parseCsv(file.content.slice(1));
    const column = (name: string): number => header?.indexOf(name) ?? -1;
    expect(summary?.[column("recordKind")]).toBe("report");
    expect(summary?.[column("key")]).toBe(report.digest);
    expect(summary?.[column("items")]).toBe("500");
    const issueRows = rest.filter((row) => row[column("recordKind")] === "issue");
    expect(issueRows).toHaveLength(spec.length);
    const byCategory = (name: string): number =>
      issueRows.filter((row) => row[column("statusCategory")] === name).length;
    expect(byCategory("new")).toBe(report.progress.project.new);
    expect(byCategory("indeterminate")).toBe(report.progress.project.indeterminate);
    expect(byCategory("done")).toBe(report.progress.project.done);
    expect(
      issueRows
        .filter((row) => row[column("classification")] === "orphan")
        .map((row) => row[column("key")]),
    ).toEqual(report.coverage.orphans);
    expect(
      issueRows
        .filter((row) => (row[column("ruleIds")] ?? "") !== "")
        .map((row) => row[column("key")]),
    ).toEqual(report.compliance.deviations.map((item) => item.key));
    const requirements = rest.filter((row) => row[column("recordKind")] === "requirement");
    expect(requirements.map((row) => [row[column("key")], row[column("classification")]])).toEqual([
      ["REQ-001", "covered"],
      ["REQ-006", "uncovered"],
    ]);
  });

  it("neutralizes spreadsheet formulas and quotes separators", async () => {
    const spec = syntheticProject(6).map((issue) =>
      issue.key === "REP-6" ? { ...issue, summary: '=HYPERLINK("x"), a,b' } : issue,
    );
    const h = harness({ issues: spec });
    const result = await h.run({ projectKey: "REP" });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("missing report");
    expect(exportJiraReport(report, "csv").content).toContain(`"'=HYPERLINK(""x""), a,b"`);
  });

  it("exports Markdown with the digest, completeness and every deviation", async () => {
    const { report } = await finished();
    const file = exportJiraReport(report, "markdown");
    expect(file.mediaType).toBe("text/markdown");
    expect(file.fileName).toBe(`keiko-jira-report-${report.digest.slice(0, 12)}.md`);
    expect(file.content).toContain(report.digest);
    expect(file.content).toContain("500 of 500 issues read");
    for (const deviation of report.compliance.deviations)
      expect(file.content).toContain(deviation.key);
    expect(file.content).toContain("REQ-006");
  });

  it("builds a comment text of numbers and issue keys only, within the Jira comment bound", async () => {
    const { report } = await finished();
    const text = jiraReportCommentText(report);
    expect(text).toContain(report.digest);
    expect(text).toContain(`${String(report.progress.project.total)} issues`);
    expect(text.length).toBeLessThanOrEqual(30000);
    expect(text).not.toContain("|");
    expect(text).not.toContain("Story 5");
  });

  it("gives the same digest for the same Jira data, whoever narrates it", async () => {
    const a = await finished();
    const b = await finished();
    expect(a.report.digest).toBe(b.report.digest);
    expect(exportJiraReport(a.report, "csv").content).toBe(
      exportJiraReport(b.report, "csv").content,
    );
  });
});
