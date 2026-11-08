import { describe, expect, it } from "vitest";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";
import { syntheticProject } from "./jira-report.fixture.js";
import { harness, idOf } from "./jira-report.harness.js";

describe("report exports preserve the availability of their evidence", () => {
  it("does not turn an unreadable native total into a measured zero", async () => {
    const h = harness({
      issues: syntheticProject(23),
      failSearchAt: 1,
      failSearchStatus: 403,
    });
    const result = await h.run({ projectKey: "REP" });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("Missing report fixture");
    expect(report.completeness).toMatchObject({ complete: false, issuesRead: 0 });
    expect(report.completeness.issuesTotal).toBeUndefined();
    const markdown = exportJiraReport(report, "markdown").content;
    expect(markdown).toContain("0 of an unknown total issues read");
    expect(markdown).not.toContain("0 of 0 issues read");
    expect(jiraReportCommentText(report)).toContain("Issues read: 0 of an unknown total");
  });

  it("keeps a genuinely empty native scope distinct from an unknown total", async () => {
    const h = harness({ issues: [] });
    const result = await h.run({ projectKey: "REP" });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("Missing report fixture");
    expect(report.completeness).toMatchObject({ complete: true, issuesRead: 0, issuesTotal: 0 });
    expect(exportJiraReport(report, "markdown").content).toContain("0 of 0 issues read");
    expect(jiraReportCommentText(report)).toContain("Issues read: 0 of 0");
  });

  it("exports unavailable template checking and the unestimated count beside native totals", async () => {
    const issues = syntheticProject(23);
    const h = harness(
      { issues, pageClamp: 5 },
      { checker: { bind: () => "unavailable" } },
    );
    const result = await h.run({ projectKey: "REP" });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("Missing report fixture");
    expect(report.completeness).toMatchObject({
      complete: false,
      reason: "template-unreadable",
      issuesRead: 23,
      issuesTotal: 23,
    });
    expect(report.completeness.pageCount).toBeGreaterThan(2);
    const text = jiraReportCommentText(report);
    const unestimated = issues.filter((issue) => issue.seconds === undefined).length;
    expect(text).toContain(`${String(unestimated)} issues without an estimate`);
    expect(text).toContain("Required-field rules: applied. Template checker: unavailable.");
    expect(text).not.toContain("Not judged by any template: 0");
    expect(text).toContain(`of ${String(report.compliance.issuesJudged)} issues deviate`);
  });

  it("keeps an old source footer a textual reference rather than proof of its revision", async () => {
    const issues = syntheticProject(23).map((issue) =>
      issue.key === "REP-15"
        ? {
            ...issue,
            description:
              "----\nKeiko traceability\nRequirement: REQ-999\nRevision: old\nEnd of Keiko traceability",
          }
        : issue,
    );
    const h = harness({ issues, pageClamp: 5 });
    const result = await h.run({ projectKey: "REP", requirementIds: ["REQ-999"] });
    const report = h.session(idOf(result));
    if (report === undefined) throw new Error("Missing report fixture");
    expect(report.coverage.requirements).toMatchObject({
      declared: 1,
      covered: 1,
      items: [expect.objectContaining({ id: "REQ-999", coveredBy: ["REP-15"] })],
    });
    const note = "Source revisions and requirement satisfaction are not verified.";
    expect(exportJiraReport(report, "markdown").content).toContain(note);
    expect(jiraReportCommentText(report)).toContain(note);
  });
});
