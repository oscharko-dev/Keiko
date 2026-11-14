import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  checkJiraIssueTemplate,
  matchingJiraIssueTemplates,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";

// #4354 (first customer's Jira runs in German): a template names its issue type by one typed string,
// and a name is localized per user. The product resolves the typed name to the issue type's id when a
// person binds the template in their own view of the project, and the id governs from then on.
function template(issueType: string, ...lines: readonly string[]): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      `issueType: ${issueType}`,
      "activateOn: [create, edit]",
      ...lines,
      "---",
      `# ${issueType}`,
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return parsed.template;
}
const INSTANCE = "0123456789abcdef0123456789abcdef";
function bound(
  base: JiraIssueTemplate,
  issueTypeId: string,
  parentIssueTypeIds?: readonly string[],
): JiraIssueTemplate {
  return {
    ...base,
    binding: {
      instance: INSTANCE,
      issueTypeId,
      ...(parentIssueTypeIds === undefined ? {} : { parentIssueTypeIds }),
    },
  };
}
const subject = (name: string, id = "10002"): JiraTemplateSubject => ({
  operation: "edit",
  projectKey: "SYN",
  issueType: { id, name },
  fields: {},
});

describe("a bound template governs by the issue type's id, in every language", () => {
  it.each([
    ["the author saw Aufgabe, the acting user sees Task", "Aufgabe", "Task"],
    ["the author saw Task, the acting user sees Aufgabe", "Task", "Aufgabe"],
    ["the author saw Sub-Task, the acting user sees Sub-task", "Sub-Task", "Sub-task"],
  ])("%s", (_name, typed, acting) => {
    const governing = bound(template(typed), "10002");
    expect(matchingJiraIssueTemplates([governing], subject(acting))).toEqual([governing]);
  });

  it("does not govern another type that happens to carry the typed name", () => {
    const governing = bound(template("Aufgabe"), "10002");
    expect(matchingJiraIssueTemplates([governing], subject("Aufgabe", "99999"))).toEqual([]);
  });

  it("keeps a legacy template as it was: by name in the language it was written in", () => {
    const legacy = template("Task");
    expect(matchingJiraIssueTemplates([legacy], subject("Task"))).toEqual([legacy]);
    expect(matchingJiraIssueTemplates([legacy], subject("Aufgabe"))).toEqual([]);
  });
});

describe("a bound parent rule compares parent types by id", () => {
  const catalog: readonly JiraFieldCatalogEntry[] = [
    { id: "customfield_10014", name: "Epic Link" },
  ];
  const withParent = template("Story", "parentField: Epic Link", "parentIssueTypes: [Epic]");
  const create = (parentName: string, parentId: string): JiraTemplateSubject => ({
    operation: "create",
    projectKey: "SYN",
    issueType: { id: "10001", name: "Story" },
    fields: { customfield_10014: "SYN-5" },
    parentIssueTypes: { customfield_10014: { id: parentId, name: parentName } },
  });

  it("accepts the parent the author named, under the acting user's own spelling", () => {
    const governing = bound(withParent, "10001", ["10000"]);
    expect(checkJiraIssueTemplate(governing, create("Epos", "10000"), catalog)).toEqual([]);
  });

  it("refuses another parent type, whatever its name is", () => {
    const governing = bound(withParent, "10001", ["10000"]);
    expect(
      checkJiraIssueTemplate(governing, create("Epic", "10009"), catalog).map((v) => v.ruleId),
    ).toEqual(["parent-type-mismatch"]);
  });
});
