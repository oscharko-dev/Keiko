import { describe, expect, it } from "vitest";
import { syntheticProject } from "./jira-report.fixture.js";
import { harness, idOf, record, reportOf } from "./jira-report.harness.js";
import { JIRA_REPORT_FIGURES_LINES_MAX, jiraReportFigures } from "./jira-report-figures.js";
import type { JiraReport } from "./jira-report-types.js";

async function figuresOf(count: number): Promise<{ report: JiraReport; text: string }> {
  const h = harness({ issues: syntheticProject(count) });
  const result = await h.run({ projectKey: "REP" });
  const report = h.session(idOf(result));
  if (report === undefined) throw new Error("the report must be complete");
  const text = record(reportOf(result)).figures;
  if (typeof text !== "string") throw new Error("the summary must carry the figures");
  return { report, text };
}

function withEstimate(report: JiraReport, total: number, done: number): JiraReport {
  const estimate = { ...report.progress.project.estimate, total, done, remaining: total - done };
  return {
    ...report,
    progress: { ...report.progress, project: { ...report.progress.project, estimate } },
  };
}

describe("the figures a weaker model quotes instead of computing (#4181)", () => {
  it("states every type and status combination, every epic and the estimate as plain lines", async () => {
    const { report, text } = await figuresOf(60);
    const lines = text.split("\n");
    for (const item of report.progress.byStatus)
      expect(lines).toContain(`${item.typeName};${item.statusName};${String(item.total)}`);
    for (const epic of report.epics.filter((item) => !item.external))
      expect(lines).toContain(
        `${epic.key};${epic.typeName};${String(epic.members.total)};${String(epic.members.done)}`,
      );
    const { estimate } = report.progress.project;
    expect(lines).toContain(
      `${String(estimate.total)};${String(estimate.done)};${String(estimate.remaining)}`,
    );
    expect(lines[0]).toBe(
      `Issues in the report: ${String(report.progress.project.total)}; done: ${String(report.progress.project.done)}`,
    );
  });

  it("is the same text from the same report", async () => {
    const { report, text } = await figuresOf(30);
    expect(jiraReportFigures(report)).toBe(text);
  });

  it("gives the estimate in hours beside the seconds, derived by arithmetic only", async () => {
    const { report, text } = await figuresOf(30);
    const lines = jiraReportFigures(withEstimate(report, 5400, 3600)).split("\n");
    expect(lines).toContain("5400;3600;1800");
    expect(lines).toContain("1.5;1;0.5");
    expect(text).toContain("Estimate in hours");
  });

  it("names the unit of a custom estimate field and gives no hours for it", async () => {
    const { report } = await figuresOf(30);
    const custom: JiraReport = {
      ...report,
      scope: {
        ...report.scope,
        estimateUnit: "custom-field",
        estimateFieldId: "customfield_10200",
      },
    };
    const text = jiraReportFigures(custom);
    expect(text).toContain("Estimate in the unit of field customfield_10200");
    expect(text).not.toContain("hours");
  });

  it("keeps a delimiter of a name from shifting the columns", async () => {
    const { report } = await figuresOf(30);
    const first = report.progress.byStatus[0];
    if (first === undefined) throw new Error("fixture has statuses");
    const odd: JiraReport = {
      ...report,
      progress: { ...report.progress, byStatus: [{ ...first, typeName: "Story;\nBug" }] },
    };
    expect(jiraReportFigures(odd).split("\n")).toContain(
      `Story Bug;${first.statusName};${String(first.total)}`,
    );
  });

  it("says how many lines it left out instead of cutting silently", async () => {
    const { report } = await figuresOf(30);
    const first = report.progress.byStatus[0];
    if (first === undefined) throw new Error("fixture has statuses");
    const many = Array.from({ length: JIRA_REPORT_FIGURES_LINES_MAX + 5 }, (_, index) => ({
      ...first,
      statusName: `S${String(index)}`,
    }));
    const text = jiraReportFigures({ ...report, progress: { ...report.progress, byStatus: many } });
    expect(text).toContain("(5 more not shown; page section statuses)");
    expect(text).not.toContain(`S${String(JIRA_REPORT_FIGURES_LINES_MAX)};`);
  });
});
