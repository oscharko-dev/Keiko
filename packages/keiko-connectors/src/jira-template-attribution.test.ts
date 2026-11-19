import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  evaluateJiraTemplateChange,
  jiraTransitionsFullyChecked,
  validateJiraIssueTemplateAgainstInstance,
  type JiraFieldCatalogEntry,
  type JiraTemplateInstanceMetadata,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";

// PR #4464 owner review findings: a template keeps the identity of the violations it produced, and a
// transition target that a status list cannot disprove is unverified rather than unknown.
function template(lines: readonly string[], activateOn = "[create, edit]"): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: ABC",
      "issueType: Story",
      `activateOn: ${activateOn}`,
      ...lines,
      "---",
      "# T",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return parsed.template;
}

function bound(
  typed: JiraIssueTemplate,
  ids: { readonly requiredFieldIds?: readonly string[]; readonly parentFieldId?: string },
): JiraIssueTemplate {
  return { ...typed, binding: { digest: "0".repeat(32), issueTypeId: "10001", ...ids } };
}

const CATALOG: readonly JiraFieldCatalogEntry[] = [
  { id: "parent", name: "Parent" },
  { id: "customfield_1", name: "Parent" },
  { id: "customfield_2", name: "Parent" },
];

describe("finding C: a transition id or action name is not disproved by a status list", () => {
  const project = { key: "ABC", issueTypes: [{ id: "10001", name: "Story" }] };
  const instance: JiraTemplateInstanceMetadata = { project, statuses: ["To Do", "Done"] };
  const codes = (target: string): readonly string[] =>
    validateJiraIssueTemplateAgainstInstance(
      template(["summaryMinLength: 3"], `[transition:${target}]`),
      instance,
    ).map((finding) => finding.code);
  const checked = (target: string): boolean =>
    jiraTransitionsFullyChecked(
      template(["summaryMinLength: 3"], `[transition:${target}]`),
      instance,
    );

  it.each(["31", "Close issue"])("reports transition:%s as unverified, not unknown", (target) => {
    expect(codes(target)).not.toContain("unknown-transition-target");
    expect(checked(target)).toBe(false);
  });

  it("still certifies a target the destination status list names", () => {
    expect(codes("Done")).toEqual([]);
    expect(checked("Done")).toBe(true);
  });

  it("still reports a bound status id a complete status list lacks", () => {
    const typed = bound(template(["summaryMinLength: 3"], "[transition:Done]"), {});
    const gone = {
      ...typed,
      binding: { digest: "0".repeat(32), issueTypeId: "10001", transitionStatusIds: ["9"] },
    };
    const complete: JiraTemplateInstanceMetadata = {
      project,
      statuses: ["Done"],
      statusRefs: [{ id: "3", name: "Done" }],
    };
    expect(validateJiraIssueTemplateAgainstInstance(gone, complete).map((f) => f.code)).toEqual([
      "unknown-transition-target",
    ]);
  });
});

describe("finding D: the report names the field of the clause that failed", () => {
  it("names the native parent, not the filled required field with the same written name", async () => {
    const typed = template(["requiredFields: [Parent]", "parentField: Parent"]);
    const rule = bound(typed, { requiredFieldIds: ["customfield_1"], parentFieldId: "parent" });
    const checker = createJiraReportTemplateChecker(() => ({ templates: [rule], unreadable: 0 }));
    const bind = checker.bind([
      { id: "customfield_1", name: "Parent" },
      { id: "parent", name: "Parent" },
    ]);
    if (bind === "none" || bind === "unavailable") throw new TypeError("Expected a checker");
    const result = await bind.check({
      key: "ABC-1",
      projectKey: "ABC",
      issueTypeId: "10001",
      typeName: "Story",
      category: "indeterminate",
      fields: { customfield_1: "filled", parent: null },
    });
    expect(result).toEqual([
      expect.objectContaining({ ruleId: "parent-missing", fieldId: "parent" }),
    ]);
  });
});

describe("finding E: edit admission keeps the violating template and its bound field", () => {
  const first = bound(template(["requiredFields: [Parent]"]), {
    requiredFieldIds: ["customfield_1"],
  });
  const second = bound(template(["requiredFields: [Parent]"]), {
    requiredFieldIds: ["customfield_2"],
  });
  const subject = (fields: Record<string, unknown>): JiraTemplateSubject => ({
    operation: "edit",
    projectKey: "ABC",
    issueType: { id: "10001", name: "Story" },
    fields,
  });

  it("blocks a newly violated required field of the second template", () => {
    const verdict = evaluateJiraTemplateChange({
      templates: [first, second],
      before: subject({ customfield_1: null, customfield_2: "set" }),
      after: subject({ customfield_1: null, customfield_2: null }),
      touched: new Set<string>(),
      catalog: CATALOG,
    });
    expect(verdict.blocking.map((violation) => violation.template)).toEqual(["ABC/Story #2"]);
    expect(verdict.notices.map((violation) => violation.template)).toEqual(["ABC/Story #1"]);
  });

  it("keeps a violation that existed in the same template and field a notice", () => {
    const fields = { customfield_1: null, customfield_2: null };
    const verdict = evaluateJiraTemplateChange({
      templates: [first, second],
      before: subject(fields),
      after: subject({ ...fields, labels: ["x"] }),
      touched: new Set(["labels"]),
      catalog: CATALOG,
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.notices).toHaveLength(2);
  });
});
