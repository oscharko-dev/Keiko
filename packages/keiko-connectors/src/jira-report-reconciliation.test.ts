import { describe, expect, it } from "vitest";
import {
  CONNECTION,
  CONTEXT,
  NOW,
  harness,
  idOf,
  record,
  reportOf,
} from "./jira-report.harness.js";
import { fixtureJira, syntheticProject } from "./jira-report.fixture.js";
import {
  jqlCount,
  selectForJql,
  withoutEstimateConfiguration,
} from "./jira-report-reconciliation.fixture.js";
import { jiraReportCommentText } from "./jira-report-export.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import { createJiraReportStore } from "./jira-report-store.js";

const issues = syntheticProject(257).map((issue, index) =>
  index === 4 ? { ...issue, seconds: 0 } : issue,
);
const requirementIds = ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006"];

describe("AC3 figures reconcile with independent count-only JQL", () => {
  it("matches totals, every type, estimates, done/open and measurable gaps over the same paged project", async () => {
    const h = harness({ issues, pageClamp: 31, select: (jql) => selectForJql(issues, jql) });
    const result = await h.run({ projectKey: "REP", requirementIds });
    expect(result.data.status).toBe("complete");
    const report = h.session(idOf(result));
    if (report === undefined) throw new TypeError("Missing finished report");
    const count = (jql = ""): Promise<number> => jqlCount(h.fixture.http, jql);
    const { project } = report.progress;
    expect(project.total).toBe(await count());
    expect(project.done).toBe(await count('statusCategory = "done"'));
    expect(project.new + project.indeterminate + project.noCategory).toBe(
      await count('statusCategory != "done"'),
    );
    expect(project.estimate?.unestimated).toBe(await count("originalEstimate IS EMPTY"));
    expect(await count("originalEstimate = 0m")).toBe(1);
    let seconds = 0;
    let doneSeconds = 0;
    for (const value of [0, 900, 1800, 3600, 7200, 10800, 14400, 18000]) {
      seconds += value * (await count(`originalEstimate = ${String(value / 60)}m`));
      doneSeconds +=
        value *
        (await count(`statusCategory = "done" AND originalEstimate = ${String(value / 60)}m`));
    }
    expect(project.estimate).toMatchObject({
      total: seconds,
      done: doneSeconds,
      remaining: seconds - doneSeconds,
    });
    const modelProgress = record(reportOf(result).progress);
    expect(modelProgress.project).toEqual(project);
    expect(modelProgress.byType).toEqual(report.progress.byType);

    for (const type of report.progress.byType) {
      const clause = `issuetype = "${type.typeName}"`;
      expect(type.total).toBe(await count(clause));
      expect(type.done).toBe(await count(`${clause} AND statusCategory = "done"`));
      expect(type.estimated).toBe(await count(`${clause} AND originalEstimate IS NOT EMPTY`));
      expect(type.unestimated).toBe(await count(`${clause} AND originalEstimate IS EMPTY`));
    }
    expect(report.progress.byType.map((type) => type.typeName)).toEqual([
      "Bug",
      "Epic",
      "Story",
      "Sub-task",
    ]);
    expect(report.progress.unassigned).toBe(
      await count('statusCategory != "done" AND assignee IS EMPTY'),
    );
    expect(report.progress.overdue).toBe(
      await count('statusCategory != "done" AND duedate < "2026-10-31"'),
    );
    expect(report.compliance.issuesWithDeviations).toBe(
      await count('issuetype = "Story" AND "Acceptance Criteria" IS EMPTY'),
    );
    const uncovered: string[] = [];
    for (const id of requirementIds) if ((await count(`text ~ "${id}"`)) === 0) uncovered.push(id);
    expect(report.coverage.requirements?.uncovered).toEqual(uncovered);
    expect(uncovered).toEqual(["REQ-006"]);
    expect(report.coverage.requirements?.covered).toBe(requirementIds.length - uncovered.length);
    expect(h.fixture.searches.filter((query) => query.maxResults !== 0).length).toBeGreaterThan(1);
    expect(await count('issuetype = "Unseen Type"')).toBe(0);
  });

  it("reconciles orphan work and empty epic gaps without using the report graph as its oracle", async () => {
    const selected = syntheticProject(9)
      .filter((issue) =>
        new Set(["REP-1", "REP-4", "REP-5", "REP-6", "REP-7", "REP-9"]).has(issue.key),
      )
      .map((issue) => {
        if (issue.type === "Bug") return { ...issue, links: [] };
        return issue.key === "REP-5" ? { ...issue, epic: "REP-1" } : issue;
      });
    const h = harness({ issues: selected, select: (jql) => selectForJql(selected, jql) });
    const result = await h.run({ projectKey: "REP" });
    expect(result.data.status).toBe("complete");
    const report = h.session(idOf(result));
    if (report === undefined) throw new TypeError("Missing finished report");
    const count = (jql: string): Promise<number> => jqlCount(h.fixture.http, jql);
    expect(report.coverage.orphans).toHaveLength(
      (await count('issuetype = "Story" AND "Epic Link" IS EMPTY')) +
        (await count('issuetype = "Bug"')),
    );
    const emptyEpics: string[] = [];
    for (const key of ["REP-1", "REP-4"])
      if ((await count(`"Epic Link" = "${key}"`)) === 0) emptyEpics.push(key);
    expect(report.coverage.uncoveredEpics).toEqual(emptyEpics);
    expect(emptyEpics).toEqual(["REP-4"]);
    const modelCoverage = record(reportOf(result).coverage);
    expect(record(modelCoverage.orphans).total).toBe(report.coverage.orphans.length);
    expect(record(modelCoverage.uncoveredEpics).items).toEqual(emptyEpics);
  });

  it("exposes unavailable estimate configuration as a gap in model, stored report and comment, never zero", async () => {
    const fixture = fixtureJira({ issues });
    const store = createJiraReportStore({ now: () => NOW });
    const result = await executeJiraReportTool(
      { projectKey: "REP" },
      CONTEXT,
      {
        ...CONNECTION(fixture),
        http: withoutEstimateConfiguration(fixture.http),
      },
      { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
    );
    expect(result.data.status).toBe("complete");
    const report = reportOf(result);
    expect(record(report.scope)).toMatchObject({
      estimateUnit: "unavailable",
      estimateSource: "unavailable",
      estimateUnavailableReason: "metadata-unavailable",
    });
    expect(record(record(report.progress).project).estimate).toBeNull();
    const types = record(report.progress).byType as readonly Record<string, unknown>[];
    expect(types).toHaveLength(4);
    for (const type of types) {
      expect(type.estimated).toBeNull();
      expect(type.unestimated).toBeNull();
    }
    expect(report.figures).toContain("Estimate: unavailable");
    expect(report.figures).not.toContain("0 total");
    const stored = store.get(idOf(result), "chat-1")?.report;
    if (stored === undefined) throw new TypeError("Missing finished report");
    expect(stored.progress.project.estimate).toBeNull();
    expect(jiraReportCommentText(stored)).toContain("Estimate: unavailable");
  });
});
