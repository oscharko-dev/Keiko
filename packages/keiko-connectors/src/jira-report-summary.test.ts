import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { JIRA_REPORT_RESULT_BYTES_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { exportJiraReport } from "./jira-report-export.js";
import {
  JIRA_REPORT_SUMMARY_LIST_MAX,
  JIRA_REPORT_SUMMARY_STATUS_MAX,
  jiraReportSummary,
} from "./jira-report-result.js";
import { syntheticProject, type FixtureIssue } from "./jira-report.fixture.js";
import { harness, idOf, record } from "./jira-report.harness.js";
import type { JiraReport } from "./jira-report-types.js";

const EPICS = 37;

/** Thirty-seven epics REP-1..REP-37, each with one story, so every epic row differs. */
function manyEpics(): readonly FixtureIssue[] {
  const epics = Array.from({ length: EPICS }, (_, index): FixtureIssue => {
    const key = `REP-${String(index + 1)}`;
    return {
      key,
      type: "Epic",
      category: index % 3 === 0 ? "done" : "indeterminate",
      status: index % 3 === 0 ? "Closed" : "Working",
      summary: `Epic ${key}`,
      links: [],
      assignee: true,
      acceptance: "n/a",
      labels: [],
    };
  });
  const stories = epics.map((epic, index): FixtureIssue => ({
    key: `REP-${String(EPICS + index + 1)}`,
    type: "Story",
    category: "new",
    status: "Open",
    summary: `Story of ${epic.key}`,
    epic: epic.key,
    links: [],
    assignee: true,
    acceptance: "Given when then",
    labels: [],
  }));
  return [...epics, ...stories];
}

async function summaryOf(issues: readonly FixtureIssue[]): Promise<{
  readonly data: Record<string, unknown>;
  readonly report: JiraReport;
  readonly id: string;
  readonly run: ReturnType<typeof harness>["run"];
}> {
  const h = harness({ issues });
  const result = await h.run({ projectKey: "REP" });
  const report = h.session(idOf(result));
  if (report === undefined) throw new Error("the report must be complete");
  return { data: result.data, report, id: idOf(result), run: h.run };
}

function figureLines(data: Record<string, unknown>): readonly string[] {
  const { figures } = record(data.report);
  if (typeof figures !== "string") throw new TypeError("the summary must carry the figures");
  return figures.split("\n");
}

describe("the summary hands the model one copy of a table, not a complete and a cut one (#4356)", () => {
  it("states each of 37 epics exactly once, in the figures, and only points at the epic section", async () => {
    const { data, report, id, run } = await summaryOf(manyEpics());
    expect(report.epics).toHaveLength(EPICS);
    const lines = figureLines(data);
    for (const epic of report.epics) {
      const own = lines.filter((line) => line.startsWith(`${epic.key};`));
      expect(own, epic.key).toHaveLength(1);
    }
    const listed = record(record(data.report).epics);
    // Nothing that reads as "the list": no items, only the size and where to page.
    expect(listed).toEqual({ total: EPICS, section: "epics", nextStartAt: 0 });
    expect(JSON.stringify(data)).not.toContain('"summary":"Epic REP-1"');
    // The section views keep their paging exactly.
    const first = record(
      (await run({ reportId: id, section: "epics", maxResults: 100 })).data.section,
    );
    expect(first.total).toBe(EPICS);
    expect(first.items).toHaveLength(EPICS);
    expect(first).not.toHaveProperty("nextStartAt");
    const paged = record(
      (await run({ reportId: id, section: "epics", startAt: 0, maxResults: 10 })).data.section,
    );
    expect(paged).toMatchObject({ total: EPICS, startAt: 0, nextStartAt: 10 });
  });

  it("stays inside the byte bound of a result for the 37-epic project", async () => {
    const { data } = await summaryOf(manyEpics());
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(JIRA_REPORT_RESULT_BYTES_MAX);
  });

  it("shows a table whole when it is whole, and gives a cut table no partial items", async () => {
    const { data, report } = await summaryOf(syntheticProject(30));
    expect(report.epics).toHaveLength(4);
    expect(record(record(data.report).epics)).toMatchObject({
      total: 4,
      items: expect.any(Array) as unknown,
    });
    const cut = (count: number): JiraReport => ({
      ...report,
      progress: {
        ...report.progress,
        byStatus: Array.from({ length: count }, (_, index) => ({
          ...(report.progress.byStatus[0] ?? { typeName: "", category: "new", total: 1 }),
          statusName: `S${String(index)}`,
        })) as unknown as JiraReport["progress"]["byStatus"],
      },
    });
    const whole = record(
      record(jiraReportSummary(cut(JIRA_REPORT_SUMMARY_STATUS_MAX)).progress).byStatus,
    );
    expect(whole.items).toHaveLength(JIRA_REPORT_SUMMARY_STATUS_MAX);
    const over = record(
      record(jiraReportSummary(cut(JIRA_REPORT_SUMMARY_STATUS_MAX + 1)).progress).byStatus,
    );
    expect(over).toEqual({
      total: JIRA_REPORT_SUMMARY_STATUS_MAX + 1,
      section: "statuses",
      nextStartAt: 0,
    });
  });

  it("does the same for the uncovered requirements that the figures name in full", async () => {
    const { report } = await summaryOf(syntheticProject(30));
    const uncovered = Array.from(
      { length: JIRA_REPORT_SUMMARY_LIST_MAX + 5 },
      (_, index) => `REQ-${String(100 + index)}`,
    );
    const withRequirements: JiraReport = {
      ...report,
      coverage: {
        ...report.coverage,
        requirements: {
          declared: uncovered.length,
          covered: 0,
          items: [],
          uncovered,
          uncoveredLabels: {},
        },
      },
    };
    const summary = jiraReportSummary(withRequirements);
    const requirements = record(record(summary.coverage).requirements);
    expect(requirements.uncovered).toEqual({
      total: uncovered.length,
      section: "requirements",
      nextStartAt: 0,
    });
    const { figures } = summary;
    if (typeof figures !== "string") throw new TypeError("the summary must carry the figures");
    const lines = figures.split("\n");
    for (const id of uncovered)
      expect(lines.filter((line) => line.startsWith(`${id};`))).toHaveLength(1);
  });
});

describe("the Markdown export holds every row of the tables the summary no longer lists (#4356)", () => {
  it("has one epic row per epic and one type and status row per combination", async () => {
    const { report } = await summaryOf(manyEpics());
    const many = Array.from({ length: 70 }, (_, index) => ({
      ...(report.progress.byStatus[0] ?? { typeName: "Story", category: "new", total: 1 }),
      statusName: `Status ${String(index)}`,
    })) as unknown as JiraReport["progress"]["byStatus"];
    const wide: JiraReport = { ...report, progress: { ...report.progress, byStatus: many } };
    const content = exportJiraReport(wide, "markdown").content;
    const rows = (heading: string): number => {
      const after = content.split(heading)[1] ?? "";
      const table = after.split(/\n#/u)[0] ?? "";
      return table.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---"))
        .length;
    };
    // One header row per table.
    expect(rows("## Epics and containers")).toBe(EPICS + 1);
    expect(rows("### By issue type and status")).toBe(70 + 1);
  });
});
