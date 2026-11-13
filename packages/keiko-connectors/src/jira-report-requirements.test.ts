import { describe, expect, it } from "vitest";
import { JIRA_REPORT_REQUIREMENT_ID_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { syntheticProject } from "./jira-report.fixture.js";
import { harness, idOf, record } from "./jira-report.harness.js";
import type { JiraReportRequirementIds } from "./jira-report-tool.js";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";

const LISTED = (ids: readonly string[]): JiraReportRequirementIds => ({ ok: true, ids });

function requirementItems(data: Record<string, unknown>): readonly Record<string, unknown>[] {
  return record(data.section).items as readonly Record<string, unknown>[];
}

describe("requirements listed by Keiko (requirementsFromPods, #4181)", () => {
  it("covers the Chat's requirements without the model copying a single identifier", async () => {
    const calls: ManagedMcpInvocationContext[] = [];
    const h = harness(
      { issues: syntheticProject(60) },
      {
        requirements: (context) => {
          calls.push(context);
          return LISTED(["REQ-005", "REQ-999"]);
        },
      },
    );
    const result = await h.run({
      projectKey: "REP",
      requirementsFromPods: true,
      section: "requirements",
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(requirementItems(result.data)).toEqual([
      expect.objectContaining({ id: "REQ-005", covered: true, coveredBy: ["REP-41"] }),
      { id: "REQ-999", covered: false },
    ]);
    expect(h.activity.at(-1)).toMatchObject({ phase: "section", requirementCount: 2 });
  });

  it("adds the identifiers the model named and drops one no issue could name", async () => {
    const h = harness(
      { issues: syntheticProject(60) },
      { requirements: () => LISTED(["REQ-005", "has space", "x".repeat(65)]) },
    );
    const result = await h.run({
      projectKey: "REP",
      requirementIds: ["REQ-001"],
      requirementsFromPods: true,
      section: "requirements",
    });
    expect(requirementItems(result.data).map((item) => item.id)).toEqual(["REQ-001", "REQ-005"]);
  });

  it("states the fix in plain words, and starts no report, when the Chat has no list", async () => {
    const h = harness({ issues: syntheticProject(12) });
    const result = await h.run({ projectKey: "REP", requirementsFromPods: true });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "failed",
      reason: "requirements-unavailable",
      message: expect.stringContaining("requirementIds") as unknown,
    });
    expect(h.store.size()).toBe(0);
    expect(h.fixture.requests).toEqual([]);
    expect(h.activity).toEqual([
      expect.objectContaining({ phase: "refused", refusal: "requirements-unavailable" }),
    ]);
  });

  it("passes the reason a Chat's list is unavailable on to the model", async () => {
    const message = "This Chat has no Knowledge Pod with requirements.";
    const h = harness(
      { issues: syntheticProject(12) },
      { requirements: () => ({ ok: false, message }) },
    );
    const result = await h.run({ projectKey: "REP", requirementsFromPods: true });
    expect(result.data).toMatchObject({ reason: "requirements-unavailable", message });
    expect(h.store.size()).toBe(0);
  });

  it("refuses a list longer than a report can hold instead of covering part of it", async () => {
    const ids = Array.from(
      { length: JIRA_REPORT_REQUIREMENT_ID_MAX + 1 },
      (_, index) => `R${String(index)}`,
    );
    const h = harness({ issues: syntheticProject(12) }, { requirements: () => LISTED(ids) });
    const result = await h.run({ projectKey: "REP", requirementsFromPods: true });
    expect(result.data).toMatchObject({ reason: "requirements-unavailable" });
    expect(h.store.size()).toBe(0);
  });

  it("names the argument when the flag is not a boolean", async () => {
    const h = harness({ issues: syntheticProject(12) }, { requirements: () => LISTED(["REQ-1"]) });
    const result = await h.run({ projectKey: "REP", requirementsFromPods: "yes" });
    expect(result.data).toMatchObject({
      reason: "invalid-input",
      invalidArguments: ["requirementsFromPods"],
    });
  });

  it("returns a whole section in one page when the model names no maxResults (S12 of #4173)", async () => {
    // Qwen paged a 41-row coverage list as 15 + 25 rows, never read the last row and reasoned
    // until its output was exhausted.
    const ids = Array.from(
      { length: 41 },
      (_, index) => `REQ-${String(index + 1).padStart(3, "0")}`,
    );
    const h = harness({ issues: syntheticProject(60) }, { requirements: () => LISTED(ids) });
    const first = await h.run({ projectKey: "REP", requirementsFromPods: true });
    const page = await h.run({ reportId: idOf(first), section: "requirements" });
    expect(requirementItems(page.data).map((item) => item.id)).toEqual(ids);
    expect(record(page.data.section)).not.toHaveProperty("nextStartAt");
    expect(h.activity.at(-1)).toMatchObject({
      phase: "section",
      sectionPage: { itemCount: 41, total: 41, byteFitted: false },
    });
  });

  it("does not list requirements for a continuation of a report", async () => {
    let calls = 0;
    const h = harness(
      { issues: syntheticProject(60) },
      {
        requirements: () => {
          calls += 1;
          return LISTED(["REQ-005"]);
        },
      },
    );
    const first = await h.run({ projectKey: "REP", requirementsFromPods: true });
    await h.run({ reportId: idOf(first), section: "requirements" });
    expect(calls).toBe(1);
  });
});

describe("an uncovered derived requirement is named readably (#4356)", () => {
  const LABEL = "Ausgangslage: Das Portal soll Belege ermöglichen";
  const listed = (): JiraReportRequirementIds => ({
    ok: true,
    ids: ["DRV-ABCDEFGH", "REQ-005", "REQ-999"],
    labels: { "DRV-ABCDEFGH": LABEL },
  });

  it("states the statement beside the handle in the figures, the section page, the export and the card data", async () => {
    const h = harness({ issues: syntheticProject(60) }, { requirements: listed });
    const result = await h.run({ projectKey: "REP", requirementsFromPods: true });
    const report = record(result.data.report);
    const lines = String(report.figures).split("\n");
    expect(lines).toContain("Requirements named by an issue: 1 of 3");
    expect(lines).toContain(`DRV-ABCDEFGH;${LABEL}`);
    expect(lines).toContain("REQ-999;");
    const page = await h.run({ reportId: idOf(result), section: "requirements" });
    expect(requirementItems(page.data)).toContainEqual({
      id: "DRV-ABCDEFGH",
      covered: false,
      label: LABEL,
    });
    expect(requirementItems(page.data)).toContainEqual({ id: "REQ-999", covered: false });
    const stored = h.session(idOf(result));
    if (stored === undefined) throw new Error("Missing report");
    expect(exportJiraReport(stored, "markdown").content).toContain(`DRV-ABCDEFGH (${LABEL})`);
    expect(exportJiraReport(stored, "csv").content).toContain(`requirement,DRV-ABCDEFGH`);
    expect(exportJiraReport(stored, "csv").content).toContain(LABEL);
    // A Jira comment carries identifiers and numbers only, never text from a document.
    expect(jiraReportCommentText(stored)).not.toContain("Portal");
  });

  it("leaves a report without derived handles unchanged", async () => {
    const h = harness(
      { issues: syntheticProject(60) },
      { requirements: () => ({ ok: true, ids: ["REQ-005", "REQ-999"] }) },
    );
    const result = await h.run({ projectKey: "REP", requirementsFromPods: true });
    expect(String(record(result.data.report).figures)).toContain("REQ-999;");
  });
});
