import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  evaluateJiraTemplateChange,
  jiraTemplateFieldsFullyChecked,
  validateJiraIssueTemplateAgainstInstance,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";

// PR #4464 owner review: the response limit never decides edit admission, the parent clause carries
// its own field reference, and a link clause is not a field.
function template(lines: readonly string[]): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: ABC",
      "issueType: Story",
      "activateOn: [create, edit]",
      ...lines,
      "---",
      "# T",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return parsed.template;
}

describe("the response limit never decides edit admission", () => {
  const noisy = (count: number): JiraIssueTemplate => ({
    ...template(["summaryMinLength: 1"]),
    requiredSections: Array.from({ length: count }, (_unused, index) => `Section ${String(index)}`),
  });
  const requiring = template(["requiredFields: [Team]"]);
  const catalog: readonly JiraFieldCatalogEntry[] = [{ id: "customfield_9", name: "Team" }];
  const subject = (fields: Record<string, unknown>): JiraTemplateSubject => ({
    operation: "edit",
    projectKey: "ABC",
    issueType: { id: "10001", name: "Story" },
    fields: { summary: "S", description: "", ...fields },
  });
  const verdictOf = (
    templates: readonly JiraIssueTemplate[],
  ): ReturnType<typeof evaluateJiraTemplateChange> =>
    evaluateJiraTemplateChange({
      templates,
      before: subject({ customfield_9: "set" }),
      after: subject({ customfield_9: null }),
      touched: new Set(["customfield_9"]),
      catalog,
    });

  it.each([24, 25, 40])(
    "refuses a cleared required field behind %i earlier notices, in either template order",
    (count) => {
      for (const templates of [
        [noisy(count), requiring],
        [requiring, noisy(count)],
      ]) {
        const verdict = verdictOf(templates);
        expect(verdict.blocking.map((violation) => violation.ruleId)).toEqual(["field-missing"]);
        expect(verdict.blocking.length + verdict.notices.length).toBeLessThanOrEqual(25);
      }
    },
  );

  it("keeps the bounded result at the limit when only notices exist", () => {
    const verdict = evaluateJiraTemplateChange({
      templates: [noisy(40)],
      before: subject({}),
      after: subject({}),
      touched: new Set(["summary"]),
      catalog,
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.notices).toHaveLength(25);
  });
});

describe("the parent clause carries its own field reference", () => {
  const subject = (parent: string): JiraTemplateSubject => ({
    operation: "edit",
    projectKey: "ABC",
    issueType: { id: "10001", name: "Story" },
    fields: { summary: "S", customfield_5: { key: parent } },
    parentIssueTypes: { customfield_5: { id: "1", name: "Bug" } },
  });
  it.each(["Team: Parent", "Team Parent"])(
    "refuses changing %s from one wrong-typed parent to another",
    (field) => {
      const verdict = evaluateJiraTemplateChange({
        templates: [template([`parentField: ${field}`, "parentIssueTypes: [Epic]"])],
        before: subject("ABC-1"),
        after: subject("ABC-2"),
        touched: new Set(["customfield_5"]),
        catalog: [
          { id: "customfield_5", name: field },
          { id: "customfield_6", name: "Team" },
        ],
      });
      expect(verdict.blocking.map((violation) => violation.ruleId)).toEqual([
        "parent-type-mismatch",
      ]);
    },
  );
});

describe("a link clause is not a field", () => {
  const rule = template(["parentLink: Blocks"]);
  const catalog: readonly JiraFieldCatalogEntry[] = [
    { id: "customfield_7", name: "Blocks" },
    { id: "issuelinks", name: "Linked Issues" },
  ];
  const facts = {
    key: "ABC-1",
    projectKey: "ABC",
    issueTypeId: "10001",
    typeName: "Story",
    category: "indeterminate" as const,
    fields: { summary: "S", customfield_7: "filled", issuelinks: [] },
  };
  const subject = (fields: Record<string, unknown>): JiraTemplateSubject => ({
    operation: "edit",
    projectKey: "ABC",
    issueType: { id: "10001", name: "Story" },
    fields,
    linkTypes: [],
  });

  it("reports the missing link against the link list, not the custom field of that name", async () => {
    const checker = createJiraReportTemplateChecker(() => ({ templates: [rule], unreadable: 0 }));
    const bind = checker.bind(catalog);
    if (bind === "none" || bind === "unavailable") throw new TypeError("Expected a checker");
    expect(await bind.check(facts)).toEqual([
      { ruleId: "parent-missing", fieldId: "issuelinks", subject: "Blocks" },
    ]);
  });

  it("does not refuse an edit of the same-named custom field for the missing link", () => {
    const verdict = evaluateJiraTemplateChange({
      templates: [rule],
      before: subject(facts.fields),
      after: subject({ ...facts.fields, customfield_7: "changed" }),
      touched: new Set(["customfield_7"]),
      catalog,
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.notices).toHaveLength(1);
  });

  it("still refuses an edit that touches the link list", () => {
    const verdict = evaluateJiraTemplateChange({
      templates: [rule],
      before: subject(facts.fields),
      after: subject(facts.fields),
      touched: new Set(["issuelinks"]),
      catalog,
    });
    expect(verdict.blocking).toHaveLength(1);
  });
});

describe("unverified field references are neither judged nor reported as checked", () => {
  const rule = template(["requiredFields: [Team]", "parentField: Anchor"]);
  const fields: readonly JiraFieldCatalogEntry[] = [{ id: "customfield_1", name: "Team" }];
  const fieldCodes = (instance: Parameters<typeof jiraTemplateFieldsFullyChecked>[1]): string[] =>
    validateJiraIssueTemplateAgainstInstance(rule, instance)
      .filter((finding) => finding.code === "unknown-field")
      .map((finding) => finding.subject);
  it("skips the unknown-field finding of an unverified reference and keeps the others", () => {
    const instance = { fields, unverifiedFieldReferences: ["Anchor"] };
    expect(fieldCodes(instance)).toEqual([]);
    expect(fieldCodes({ fields })).toEqual(["Anchor"]);
    expect(jiraTemplateFieldsFullyChecked(rule, instance)).toBe(false);
  });
  it("certifies a template whose references are all confirmed", () => {
    expect(jiraTemplateFieldsFullyChecked(rule, { fields })).toBe(true);
    expect(jiraTemplateFieldsFullyChecked(rule, {})).toBe(false);
  });
});
