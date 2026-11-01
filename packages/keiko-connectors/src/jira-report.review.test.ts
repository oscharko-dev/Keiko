import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { exportJiraReport } from "./jira-report-export.js";
import { syntheticProject, type FixtureIssue } from "./jira-report.fixture.js";
import { harness, idOf, NOW, record, reportOf } from "./jira-report.harness.js";
import { parseJiraReportArgs } from "./jira-report-args.js";
import { compareCodePoints } from "./jira-report-aggregate.js";
import { jqlIsBalanced } from "./jira-report-jql.js";
import { JIRA_REPORT_SESSION_MAX_BYTES, jiraReportIssueCost } from "./jira-report-session.js";
import { createJiraReportStore } from "./jira-report-store.js";

const without = (issues: readonly FixtureIssue[], key: string): readonly FixtureIssue[] =>
  issues.filter((issue) => issue.key !== key);

describe("a scope that moves while paging is never complete (review 1)", () => {
  it("detects a removal before the cursor that would skip an unseen issue", async () => {
    const all = syntheticProject(14);
    const h = harness({
      issues: all,
      pageClamp: 5,
      select: (_jql, call) => (call === 1 ? all : without(all, "REP-3")),
    });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness)).toMatchObject({
      complete: false,
      reason: "scope-changed",
    });
  });

  it("detects a removal paired with an addition although the total is unchanged", async () => {
    const all = syntheticProject(15);
    const before = without(all, "REP-15");
    const after = without(all, "REP-3");
    const h = harness({
      issues: all,
      pageClamp: 5,
      select: (_jql, call) => (call === 1 ? before : after),
    });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness).reason).toBe("scope-changed");
  });

  it("detects an issue entering the scope before the cursor", async () => {
    const all = syntheticProject(15);
    const h = harness({
      issues: all,
      pageClamp: 5,
      select: (_jql, call) => (call === 1 ? without(all, "REP-3") : all),
    });
    const result = await h.run({ projectKey: "REP" });
    expect(record(reportOf(result).completeness).reason).toBe("scope-changed");
  });

  it("still completes a stable scope read in overlapping pages", async () => {
    const all = syntheticProject(23);
    const h = harness({ issues: all, pageClamp: 5 });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("complete");
    expect(record(record(reportOf(result).progress).project).total).toBe(23);
  });
});

describe("required-field rules use the shared field id grammar (review 2)", () => {
  it("keeps mixed-case system fields such as fixVersions", async () => {
    const h = harness({ issues: syntheticProject(30), requireFixVersions: true });
    const result = await h.run({ projectKey: "REP" });
    const stored = h.session(idOf(result));
    expect(stored?.compliance.requiredFieldRules).toBe("applied");
    expect(
      stored?.compliance.deviations.some((item) => item.fieldIds.includes("fixVersions")),
    ).toBe(true);
  });
});

describe("initialization failures are never reported as a complete report (review 3)", () => {
  it("retries a transient failure of the field list on the next call", async () => {
    const h = harness({ issues: syntheticProject(40), fieldStatuses: [403] });
    const first = await h.run({ projectKey: "REP" });
    expect(first.data.status).toBe("reading");
    expect(first.data.report).toBeUndefined();
    const second = await h.run({ reportId: idOf(first) });
    expect(second.data.status).toBe("complete");
    expect(record(reportOf(second).hierarchy).discovery).toBe("complete");
  });

  it("ends incomplete with read-failed when the retry also fails", async () => {
    const h = harness({ issues: syntheticProject(40), fieldStatuses: [403, 403] });
    const first = await h.run({ projectKey: "REP" });
    const second = await h.run({ reportId: idOf(first) });
    expect(second.data.status).toBe("incomplete");
    expect(record(reportOf(second).completeness)).toMatchObject({
      complete: false,
      reason: "read-failed",
      failure: "permission",
    });
  });

  it("does not report complete when the required rules cannot be read", async () => {
    const h = harness({ issues: syntheticProject(40), noRequiredMetadata: true });
    const first = await h.run({ projectKey: "REP" });
    const second = await h.run({ reportId: idOf(first) });
    expect(second.data.status).toBe("incomplete");
    expect(record(reportOf(second).completeness).reason).toBe("read-failed");
  });
});

describe("an empty or escaping JQL scope is refused (reviews 4 and 5)", () => {
  it.each([
    [{ jql: "ORDER BY created" }],
    [{ jql: "   order   by key" }],
    [{ projectKey: "REP", jql: "x) OR (y" }],
    [{ jql: "(a = 1" }],
    [{ projectKey: "REP", jql: 'summary ~ "unterminated' }],
    [{ projectKey: "REP", jql: "a = 1))((" }],
  ])("refuses %j", (args) => {
    expect(parseJiraReportArgs(args as CatalogJsonObject)).toBeUndefined();
  });

  it.each([
    [{ projectKey: "REP", jql: "ORDER BY created" }],
    [{ projectKey: "REP", jql: 'summary ~ "a) OR (b" AND (x = 1 OR y = 2)' }],
    [{ jql: "summary ~ 'it\\'s (fine' ORDER BY key" }],
  ])("accepts %j", (args) => {
    expect(parseJiraReportArgs(args as CatalogJsonObject)).toBeDefined();
  });

  it("balances parentheses outside quoted strings only", () => {
    expect(jqlIsBalanced('a = "(" AND b = 1')).toBe(true);
    expect(jqlIsBalanced("((a))")).toBe(true);
    expect(jqlIsBalanced(")(")).toBe(false);
    expect(jqlIsBalanced("(a")).toBe(false);
  });
});

describe("the memory budget is real (review 6)", () => {
  it("charges a realistic per-issue cost against a per-report budget below the store budget", () => {
    const [issue] = syntheticProject(5).slice(4);
    if (issue === undefined) throw new Error("missing fixture");
    expect(
      jiraReportIssueCost({
        key: issue.key,
        typeName: "Story",
        subtask: false,
        summary: "",
        statusName: "",
        category: "new",
        parentKey: undefined,
        linkedKeys: [],
        assigned: true,
        dueDate: undefined,
        estimate: undefined,
        epicMarker: false,
        deviations: [],
        requirementIds: [],
        labels: [],
      }),
    ).toBeGreaterThanOrEqual(600);
    expect(JIRA_REPORT_SESSION_MAX_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it("stops a large read at the per-report budget with an honest reason", async () => {
    const issues = syntheticProject(400);
    const h = harness({ issues }, { memoryBudgetBytes: 150 * 800 });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness)).toMatchObject({ reason: "memory-budget" });
  });
});

describe("Markdown export escapes Jira text (review 7)", () => {
  it("neutralizes HTML, links and emphasis in cells and collapses the scope line", async () => {
    const spec = syntheticProject(8).map((issue) =>
      issue.key === "REP-1"
        ? {
            ...issue,
            summary: "<img src=x onerror=alert(1)> [click](http://evil.example) *b* _i_ #h ! \\",
          }
        : issue,
    );
    const h = harness({ issues: spec });
    const result = await h.run({
      projectKey: "REP",
      jql: "summary ~ `x`\n# injected\n<script>",
    });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("missing report");
    const markdown = exportJiraReport(report, "markdown").content;
    expect(markdown).not.toMatch(/(?<!\\)</u);
    expect(markdown).not.toContain("](http://evil.example)");
    expect(markdown).toContain("\\<img");
    expect(markdown).toContain("\\[click\\]\\(http://evil.example\\)");
    const scopeLine = markdown.split("\n").find((line) => line.startsWith("Scope:"));
    expect(scopeLine).toBeDefined();
    expect(markdown.split("\n").some((line) => line.startsWith("# injected"))).toBe(false);
  });
});

describe("binding, expiry and fairness (review 9)", () => {
  it("refuses a resume when the credential identity changed", async () => {
    const h = harness({ issues: syntheticProject(20), fieldStatuses: [403] });
    const first = await h.run({ projectKey: "REP" }, { identity: "credential-1" });
    const refused = await h.run({ reportId: idOf(first) }, { identity: "credential-2" });
    expect(refused.isError).toBe(true);
    expect(refused.data.reason).toBe("connection-changed");
  });

  it("refuses a resume against another base URL", async () => {
    const h = harness({ issues: syntheticProject(20), fieldStatuses: [403] });
    const first = await h.run({ projectKey: "REP" });
    const refused = await h.run(
      { reportId: idOf(first) },
      { baseUrl: "https://other.example.invalid" },
    );
    expect(refused.data.reason).toBe("connection-changed");
  });

  it("does not renew the expiry when the report is only exported", () => {
    let clock = 0;
    const store = createJiraReportStore({ now: () => clock, idleTtlMs: 1000, newId: () => "id-1" });
    const session = store.start("chat-1", {
      projectKey: "REP",
      jql: undefined,
      estimateFieldId: undefined,
      parentFieldIds: [],
      requirementIds: [],
      asOf: undefined,
    });
    clock = 900;
    expect(store.peek(session.id, "chat-1")).toBe(session);
    clock = 1200;
    expect(store.peek(session.id, "chat-1")).toBeUndefined();
  });

  it("keeps one Chat from evicting another Chat's reports", () => {
    let next = 0;
    const store = createJiraReportStore({
      newId: () => `id-${String(next++)}`,
      maxSessionsPerOwner: 2,
    });
    const request = {
      projectKey: "REP",
      jql: undefined,
      estimateFieldId: undefined,
      parentFieldIds: [],
      requirementIds: [],
      asOf: undefined,
    };
    const other = store.start("chat-b", request);
    for (let index = 0; index < 5; index += 1) store.start("chat-a", request);
    expect(store.get(other.id, "chat-b")).toBe(other);
    expect(store.size()).toBe(3);
  });
});

describe("the digest and ordering are reproducible (review 10)", () => {
  it("gives different digests and file names to reports with different rows", async () => {
    const base = syntheticProject(12);
    const other = base.map((issue) =>
      issue.key === "REP-6" ? { ...issue, summary: "Renamed" } : issue,
    );
    const a = harness({ issues: base });
    const b = harness({ issues: other });
    const first = a.session(idOf(await a.run({ projectKey: "REP" })));
    const second = b.session(idOf(await b.run({ projectKey: "REP" })));
    if (first === undefined || second === undefined) throw new Error("missing report");
    expect(first.progress).toEqual(second.progress);
    expect(first.digest).not.toBe(second.digest);
    expect(exportJiraReport(first, "csv").fileName).not.toBe(
      exportJiraReport(second, "csv").fileName,
    );
  });

  it("computes overdue against an explicit date, independent of the clock", async () => {
    const issues = syntheticProject(60);
    const early = harness({ issues }, { now: () => Date.parse("2026-10-31T23:59:59Z") });
    const late = harness({ issues }, { now: () => Date.parse("2026-11-01T00:00:01Z") });
    const a = await early.run({ projectKey: "REP", asOf: "2026-10-31" });
    const b = await late.run({ projectKey: "REP", asOf: "2026-10-31" });
    expect(reportOf(a).digest).toBe(reportOf(b).digest);
    expect(record(reportOf(a).scope)).toMatchObject({ asOf: "2026-10-31", timeZone: "UTC" });
    const future = await early.run({ projectKey: "REP", asOf: "3000-01-01" });
    expect(record(reportOf(future).progress).overdue).toBeGreaterThan(
      Number(record(reportOf(a).progress).overdue),
    );
    expect(NOW).toBeGreaterThan(0);
  });

  it("orders by code point, not by locale", () => {
    expect(["Ä", "Z", "a", "B"].sort(compareCodePoints)).toEqual(["B", "Z", "a", "Ä"]);
  });
});

describe("estimates carry their unit (review 11)", () => {
  it("labels seconds from time tracking and a custom field's own units", async () => {
    const h = harness({ issues: syntheticProject(30) });
    const seconds = h.session(idOf(await h.run({ projectKey: "REP" })));
    const points = h.session(
      idOf(await h.run({ projectKey: "REP", estimateFieldId: "customfield_10200" })),
    );
    expect(seconds?.scope.estimateUnit).toBe("seconds");
    expect(points?.scope.estimateUnit).toBe("custom-field");
    if (seconds === undefined || points === undefined) throw new Error("missing report");
    expect(exportJiraReport(seconds, "markdown").content).toContain("seconds");
    expect(exportJiraReport(points, "markdown").content).toContain("customfield_10200");
    expect(exportJiraReport(seconds, "csv").content).toContain("estimateUnit=seconds");
  });
});

describe("failure reasons and bounded results (review 12)", () => {
  it("surfaces a closed failure reason for an invalid query", async () => {
    const h = harness({ issues: syntheticProject(30), failSearchAt: 1, failSearchStatus: 400 });
    const result = await h.run({ projectKey: "REP", jql: "nonsense ~ ~" });
    expect(result.data.status).toBe("incomplete");
    expect(record(reportOf(result).completeness)).toMatchObject({
      reason: "read-failed",
      failure: "invalid-jql",
    });
  });

  it("never exceeds the result bound when a short requirement id matches thousands of issues", async () => {
    const issues = syntheticProject(4000).map((issue) => ({
      ...issue,
      summary: `${issue.summary} REQ-001`,
    }));
    const h = harness({ issues });
    const result = await h.run({ projectKey: "REP", requirementIds: ["REQ-001"] });
    expect(result.data.status).toBe("complete");
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(262144 - 4096);
    const items = record(record(record(reportOf(result).coverage).requirements).items)
      .items as readonly Record<string, unknown>[];
    expect(items[0]).toMatchObject({ id: "REQ-001", coveredByTotal: 4000 });
    expect((items[0]?.coveredBy as readonly string[]).length).toBeLessThanOrEqual(25);
    const section = await h.run({ reportId: idOf(result), section: "requirements" });
    expect(Buffer.byteLength(JSON.stringify(section.data))).toBeLessThan(262144 - 4096);
  });

  it("reports the covering issues' own progress so a leaf story does not read as zero", async () => {
    const h = harness({ issues: syntheticProject(60) });
    const result = await h.run({ projectKey: "REP", requirementIds: ["REQ-005"] });
    const stored = h.session(idOf(result))?.coverage.requirements?.items[0];
    expect(stored).toMatchObject({ id: "REQ-005", coveredBy: ["REP-41"] });
    expect(stored?.coveringTotal).toBe(1);
  });

  it("starts the CSV with a byte order mark for spreadsheet programs", async () => {
    const h = harness({ issues: syntheticProject(12) });
    const report = h.session(idOf(await h.run({ projectKey: "REP" })));
    if (report === undefined) throw new Error("missing report");
    expect(exportJiraReport(report, "csv").content.startsWith("﻿")).toBe(true);
  });
});
