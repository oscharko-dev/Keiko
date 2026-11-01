import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  EPIC_LINK,
  POINTS,
  fixtureJira,
  syntheticProject,
  type FixtureIssue,
  type FixtureOptions,
} from "./jira-report.fixture.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSet,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import type { JiraReport } from "./jira-report-types.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const CONTEXT: ManagedMcpInvocationContext = {
  invocationId: "invocation",
  correlationId: "correlation",
  signal: new AbortController().signal,
  beforeEffect: () => true,
};
const GOOD = "## Context\nWhy\n## Acceptance criteria\n* it works";
const BAD = "## Context\nWhy";

function template(...rules: readonly string[]): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: REP",
      "issueType: Story",
      "activateOn: [edit]",
      ...rules,
      "---",
      "## Context",
      "## Acceptance criteria",
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}

/** Stories get the compliant description, except the first, which lacks a required section. */
function project(): {
  issues: readonly FixtureIssue[];
  violating: FixtureIssue;
  conforming: FixtureIssue;
} {
  const base = syntheticProject(40);
  const stories = base.filter((issue) => issue.type === "Story");
  const [violating, conforming] = stories;
  if (violating === undefined || conforming === undefined) throw new Error("fixture has stories");
  const issues = base.map((issue) =>
    issue.type === "Story"
      ? { ...issue, description: issue.key === violating.key ? BAD : GOOD }
      : issue,
  );
  return {
    issues,
    violating: { ...violating, description: BAD },
    conforming: { ...conforming, description: GOOD },
  };
}

async function runOf(
  source: JiraIssueTemplateSource | undefined,
  options: Partial<FixtureOptions> = {},
  extraArgs: CatalogJsonObject = {},
): Promise<{ readonly result: ManagedMcpToolResult; readonly report: JiraReport }> {
  const { issues } = project();
  // Create metadata that requires nothing: the instance's own required-field rule must not mix
  // into the template's, and the metadata stays readable so the report can complete.
  const fixture = fixtureJira({ issues, noRequiredFields: true, ...options });
  const store = createJiraReportStore({ now: () => NOW });
  const result = await executeJiraReportTool(
    { projectKey: "REP", ...extraArgs },
    CONTEXT,
    {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: fixture.http,
      ...(source === undefined ? {} : { issueTemplates: source }),
    },
    { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
  );
  const id = result.data.reportId;
  const report = typeof id === "string" ? store.get(id, "chat-1")?.report : undefined;
  if (report === undefined) throw new Error("the report must be complete");
  return { result, report };
}
async function reportOf(
  source: JiraIssueTemplateSource | undefined,
  options: Partial<FixtureOptions> = {},
  extraArgs: CatalogJsonObject = {},
): Promise<JiraReport> {
  return (await runOf(source, options, extraArgs)).report;
}

/** The write gate for an edit of the same issue, with the same template source. */
function gateOf(
  source: JiraIssueTemplateSource,
  issue: FixtureIssue,
): Promise<JiraTemplateGateResult> {
  const issueBody = {
    id: issue.key.slice(4),
    key: issue.key,
    fields: {
      project: { key: "REP" },
      issuetype: { id: "11", name: "Story" },
      status: { id: "1", name: "Open" },
      summary: issue.summary,
      description: issue.description ?? null,
      labels: [...issue.labels],
      issuelinks: [],
    },
  };
  const request = (path: string): Promise<AtlassianWriteHttpOutcome> =>
    Promise.resolve(
      path.startsWith("issue/")
        ? { ok: true, status: 200, body: issueBody }
        : { ok: true, status: 200, body: undefined, items: [] },
    );
  return gateJiraMutationByTemplates({
    request,
    source,
    operation: "edit",
    metadata: [],
    validated: { fields: {}, update: {} },
    target: { issueKey: issue.key },
  });
}

const SET = (...templates: JiraIssueTemplate[]): JiraIssueTemplateSet => ({
  templates,
  unreadable: 0,
});

function deviationKeys(report: JiraReport, ruleId: string): readonly string[] {
  return report.compliance.deviations
    .filter((deviation) => deviation.ruleIds.includes(ruleId))
    .map((deviation) => deviation.key);
}

describe("the report and the write gate share one template source", () => {
  it("lists an issue the gate refuses, and neither names a conforming one", async () => {
    const { violating, conforming } = project();
    const source: JiraIssueTemplateSource = () => SET(template());
    const report = await reportOf(source);
    const refused = await gateOf(source, violating);
    const allowed = await gateOf(source, conforming);

    expect(refused).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "section-missing", subject: "Acceptance criteria" }],
    });
    expect(allowed).toEqual({ ok: true });
    expect(deviationKeys(report, "section-missing")).toEqual([violating.key]);
    expect(deviationKeys(report, "section-missing")).not.toContain(conforming.key);
    expect(report.compliance).toMatchObject({ checker: "applied", issuesWithDeviations: 1 });
    expect(report.compliance.deviations[0]?.fieldIds).toEqual(["description"]);
    expect(report.completeness).toMatchObject({ complete: true });
  });

  it("agrees on rules a summary and a label raise", async () => {
    const source: JiraIssueTemplateSource = () =>
      SET(template("summaryMinLength: 200", "requiredLabels: [reviewed]"));
    const report = await reportOf(source);
    const { violating } = project();
    const refused = await gateOf(source, violating);
    const gateRules = refused.ok ? [] : (refused.violations ?? []).map((item) => item.ruleId);
    expect(gateRules).toEqual(expect.arrayContaining(["summary-too-short", "label-missing"]));
    for (const ruleId of gateRules) expect(deviationKeys(report, ruleId)).toContain(violating.key);
  });

  it("judges existing issues against a template activated on create, the way the product proposes one", async () => {
    // A lead imports the template the product proposes, which is activated on create only. The
    // issues that predate it are exactly what an evaluation of compliance has to name (#4181).
    const createOnly = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: REP\nissueType: Story\nactivateOn: [create]\n---\n## Acceptance criteria\n",
    );
    if (!createOnly.ok) throw new Error("fixture template must parse");
    const source: JiraIssueTemplateSource = () => SET(createOnly.template);
    const report = await reportOf(source);
    const { violating, conforming } = project();
    expect(report.compliance).toMatchObject({ checker: "applied" });
    expect(deviationKeys(report, "section-missing")).toContain(violating.key);
    expect(deviationKeys(report, "section-missing")).not.toContain(conforming.key);
    // A create-only template does not govern an edit, so the gate stays open: the report names
    // the existing violation without ever blocking the write the template was not written for.
    expect(await gateOf(source, violating)).toEqual({ ok: true });
  });

  it("names what is missing, not only the rule", async () => {
    const source: JiraIssueTemplateSource = () => SET(template("requiredLabels: [reviewed]"));
    const report = await reportOf(source);
    const { violating } = project();
    const entry = report.compliance.deviations.find((item) => item.key === violating.key);
    expect(entry?.details).toEqual(
      expect.arrayContaining(["section-missing: Acceptance criteria", "label-missing: reviewed"]),
    );
  });

  it("names a field by the instance's name when the template refers to it by id", async () => {
    const source: JiraIssueTemplateSource = () => SET(template(`requiredFields: [${POINTS}]`));
    const report = await reportOf(source);
    const details = report.compliance.deviations.flatMap((item) => item.details);
    expect(details).toContain("field-missing: Story Points");
  });

  it("hands the model what is wrong with each deviating issue in the summary and in the section", async () => {
    const source: JiraIssueTemplateSource = () => SET(template());
    const { violating } = project();
    const { result } = await runOf(source, {}, { section: "deviations", maxResults: 100 });
    const items = (result.data.section as { items: readonly Record<string, unknown>[] }).items;
    expect(items.find((item) => item.key === violating.key)).toMatchObject({
      ruleIds: ["section-missing"],
      details: ["section-missing: Acceptance criteria"],
    });
    const summary = await runOf(source);
    const listed = (
      summary.result.data.report as {
        compliance: { deviations: { items: readonly Record<string, unknown>[] } };
      }
    ).compliance.deviations.items;
    expect(listed[0]).toHaveProperty("details", ["section-missing: Acceptance criteria"]);
  });

  it("ignores a template that governs only a transition", async () => {
    const transitionOnly = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: REP\nissueType: Story\nactivateOn: [transition]\n---\n## Acceptance criteria\n",
    );
    if (!transitionOnly.ok) throw new Error("fixture template must parse");
    const source: JiraIssueTemplateSource = () => SET(transitionOnly.template);
    const report = await reportOf(source);
    expect(report.compliance).toMatchObject({ checker: "none", deviationCount: 0 });
  });

  it("reports no template check when the connection has no source", async () => {
    const report = await reportOf(undefined);
    expect(report.compliance).toMatchObject({ checker: "none", deviationCount: 0 });
  });
});

describe("an unreadable template source never reads as zero deviations", () => {
  const broken: JiraIssueTemplateSource = () => ({
    templates: [template()],
    unreadable: 1,
    unreadableNames: ["Story template"],
  });

  it("marks the report incomplete with a closed reason, and the gate refuses the same state", async () => {
    const report = await reportOf(broken);
    expect(report.compliance).toMatchObject({
      checker: "unavailable",
      issuesWithDeviations: 0,
      deviationCount: 0,
    });
    expect(report.completeness).toMatchObject({
      complete: false,
      reason: "template-unreadable",
    });
    expect(await gateOf(broken, project().conforming)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable", subject: "Story template" }],
    });
  });

  it("keeps the figures of every issue it read", async () => {
    const report = await reportOf(broken);
    expect(report.progress.project.total).toBe(project().issues.length);
  });

  it("surfaces a source that throws instead of reporting a pass", async () => {
    const { issues } = project();
    const fixture = fixtureJira({ issues });
    const store = createJiraReportStore({ now: () => NOW });
    const run = (): Promise<unknown> =>
      executeJiraReportTool(
        { projectKey: "REP" },
        CONTEXT,
        {
          deployment: "data-center",
          baseUrl: "https://jira.example.invalid/context",
          http: fixture.http,
          issueTemplates: () => {
            throw new Error("store unavailable");
          },
        },
        { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
      );
    await expect(run()).rejects.toThrow("store unavailable");
  });
});

describe("template field references", () => {
  const byName = (): JiraIssueTemplateSet => SET(template("requiredFields: [Does not exist]"));

  it("raises field-unavailable per issue when the instance field list was read", async () => {
    const report = await reportOf(byName);
    expect(report.compliance.checker).toBe("applied");
    expect(deviationKeys(report, "field-unavailable").length).toBeGreaterThan(0);
  });

  it("states the check unavailable when a name cannot be resolved because the list was not read", async () => {
    // Without the field list the hierarchy cannot be discovered; naming the parent field takes
    // that responsibility, which is the only way a report completes without the list.
    const report = await reportOf(byName, { omitFieldList: true }, { parentFieldIds: [EPIC_LINK] });
    expect(report.compliance).toMatchObject({ checker: "unavailable", deviationCount: 0 });
    expect(report.completeness).toMatchObject({ complete: false, reason: "template-unreadable" });
  });

  it("asks Jira for the fields the templates read", async () => {
    const { issues } = project();
    const fixture = fixtureJira({ issues });
    const store = createJiraReportStore({ now: () => NOW });
    const args: CatalogJsonObject = { projectKey: "REP" };
    await executeJiraReportTool(
      args,
      CONTEXT,
      {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: fixture.http,
        issueTemplates: () => SET(template("requiredFields: [customfield_10100]")),
      },
      { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
    );
    const search = fixture.requests.find((request) => request.includes("search?"));
    expect(search).toContain("customfield_10100");
    expect(search).toContain("description");
    expect(search).toContain("labels");
  });
});

function bugTemplate(): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    "---\nkeiko: jira-issue-template\nversion: 1\nproject: REP\nissueType: Bug\nactivateOn: [edit]\n---\n## Steps\n",
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}
function countOf(type: string): number {
  return project().issues.filter((issue) => issue.type === type).length;
}

describe("an issue no template covers is never reported as checked (#4181)", () => {
  it("counts the issues of a type without a template apart from the judged ones", async () => {
    const report = await reportOf(() => SET(template()));
    const total = project().issues.length;
    expect(report.compliance).toMatchObject({
      checker: "applied",
      issuesChecked: countOf("Story"),
      issuesWithoutTemplate: total - countOf("Story"),
    });
    const byType = report.compliance.withoutTemplateByType;
    expect(byType).toHaveLength(3);
    expect(byType).toEqual(
      expect.arrayContaining([
        { typeName: "Sub-task", count: countOf("Sub-task") },
        { typeName: "Bug", count: countOf("Bug") },
        { typeName: "Epic", count: countOf("Epic") },
      ]),
    );
    const counts = byType.map((item) => item.count);
    expect(counts).toEqual([...counts].sort((left, right) => right - left));
    expect(report.rows.filter((row) => row.issue.templateJudged)).toHaveLength(countOf("Story"));
  });

  it("judges a type once a template covers it", async () => {
    const report = await reportOf(() => SET(template(), bugTemplate()));
    expect(report.compliance.issuesChecked).toBe(countOf("Story") + countOf("Bug"));
    expect(report.compliance.withoutTemplateByType.map((item) => item.typeName)).not.toContain(
      "Bug",
    );
    expect(deviationKeys(report, "section-missing")).toEqual(
      expect.arrayContaining(
        project()
          .issues.filter((i) => i.type === "Bug")
          .map((i) => i.key),
      ),
    );
  });

  it("does not let a template of another project cover the issues", async () => {
    const other = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: OTHER\nissueType: Story\nactivateOn: [edit]\n---\n## Context\n",
    );
    if (!other.ok) throw new Error("fixture template must parse");
    const report = await reportOf(() => SET(other.template));
    expect(report.compliance).toMatchObject({ issuesChecked: 0 });
  });

  it("states that no template judged anything when none exists", async () => {
    const report = await reportOf(undefined);
    const total = project().issues.length;
    expect(report.compliance).toMatchObject({
      checker: "none",
      issuesWithoutTemplate: total,
    });
    expect(report.compliance.withoutTemplateByType.reduce((sum, item) => sum + item.count, 0)).toBe(
      total,
    );
    expect(report.rows.some((row) => row.issue.templateJudged)).toBe(false);
  });

  it("does not guess the coverage when the templates are unreadable", async () => {
    const broken: JiraIssueTemplateSource = () => ({ templates: [template()], unreadable: 1 });
    const report = await reportOf(broken);
    expect(report.compliance).toMatchObject({
      checker: "unavailable",
      issuesWithoutTemplate: 0,
      withoutTemplateByType: [],
    });
    expect(report.rows.some((row) => row.issue.templateJudged)).toBe(false);
  });

  it("carries the figures through the summary and moves the digest with them", async () => {
    const covered = await runOf(() => SET(template()));
    const wider = await runOf(() => SET(template(), bugTemplate()));
    const summary = covered.result.data.report as {
      compliance: {
        issuesChecked: number;
        issuesWithoutTemplate: number;
        withoutTemplateByType: unknown;
      };
    };
    expect(summary.compliance).toMatchObject({
      issuesChecked: covered.report.compliance.issuesChecked,
      issuesWithoutTemplate: covered.report.compliance.issuesWithoutTemplate,
      withoutTemplateByType: covered.report.compliance.withoutTemplateByType,
    });
    expect(covered.report.digest).not.toBe(wider.report.digest);
  });

  it("names the uncovered issues in the Markdown and the Jira comment", async () => {
    const report = await reportOf(() => SET(template()));
    const uncovered = String(report.compliance.issuesWithoutTemplate);
    const markdown = exportJiraReport(report, "markdown").content;
    expect(markdown).toContain(`${uncovered} issues are covered by no issue template`);
    expect(markdown).toContain("Bug");
    expect(jiraReportCommentText(report)).toContain(
      `Not judged by any template: ${uncovered} issues`,
    );
  });
});

describe("a cut summary list says how to read on (#4181)", () => {
  interface Listed {
    total: number;
    items: readonly unknown[];
    section?: string;
    nextStartAt?: number;
  }
  const source: JiraIssueTemplateSource = () => SET(template("requiredLabels: [reviewed]"));

  it("names the section and offset of a list it cut, and the section continues there", async () => {
    const { result } = await runOf(source);
    const deviations = (result.data.report as unknown as { compliance: { deviations: Listed } })
      .compliance.deviations;
    expect(deviations.total).toBeGreaterThan(deviations.items.length);
    expect(deviations).toMatchObject({
      section: "deviations",
      nextStartAt: deviations.items.length,
    });
    const next = await runOf(
      source,
      {},
      {
        section: "deviations",
        startAt: deviations.nextStartAt ?? 0,
        maxResults: 100,
      },
    );
    const page = next.result.data.section as { items: readonly unknown[]; total: number };
    expect(deviations.items.length + page.items.length).toBe(deviations.total);
  });

  it("carries nothing on a list it shows whole", async () => {
    const { result } = await runOf(source);
    const epics = (result.data.report as unknown as { epics: Listed }).epics;
    expect(epics.total).toBe(epics.items.length);
    expect(epics).not.toHaveProperty("nextStartAt");
    expect(epics).not.toHaveProperty("section");
  });
});
