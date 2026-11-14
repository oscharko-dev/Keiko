import { describe, expect, it } from "vitest";
import {
  bindJiraIssueTemplateText,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "./jira-issue-template.js";

// #4354: a template's binding is written by the product into its front matter, so it travels with an
// exported copy, and it governs only on the Jira whose identity it carries.
const INSTANCE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const PLAIN = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Aufgabe",
  "activateOn: [create, edit]",
  "parentField: Epic Link",
  "parentIssueTypes: [Epos]",
  "---",
  "# Aufgabe",
  "",
  "## Kontext",
].join("\n");

function template(markdown: string): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(markdown);
  if (!result.ok) throw new TypeError("Expected a parseable template");
  return result.template;
}

describe("the binding lines the product writes", () => {
  const binding = { instance: INSTANCE, issueTypeId: "10002", parentIssueTypeIds: ["10000"] };
  const written = bindJiraIssueTemplateText(PLAIN, binding);

  it("are parsed back as the template's binding and leave every other line as it was", () => {
    expect(written).toBeDefined();
    expect(template(written ?? "").binding).toEqual(binding);
    const original = PLAIN.split("\n");
    const lines = (written ?? "")
      .split("\n")
      .filter((line) => !/^(issueTypeId|parentIssueTypeIds|jiraInstance):/u.test(line));
    expect(lines).toEqual(original);
  });

  it("replace an earlier binding instead of adding a second one", () => {
    const again = bindJiraIssueTemplateText(written ?? "", {
      instance: OTHER,
      issueTypeId: "10009",
      parentIssueTypeIds: ["10001"],
    });
    expect(template(again ?? "").binding).toEqual({
      instance: OTHER,
      issueTypeId: "10009",
      parentIssueTypeIds: ["10001"],
    });
    expect((again ?? "").match(/^issueTypeId:/gmu)).toHaveLength(1);
  });

  it("are refused when the ids lack the Jira they belong to, or the other way round", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    expect(parseJiraIssueTemplate(body('issueTypeId: "10002"')).ok).toBe(false);
    expect(parseJiraIssueTemplate(body(`jiraInstance: "${INSTANCE}"`)).ok).toBe(false);
    expect(parseJiraIssueTemplate(body('issueTypeId: "Task"\njiraInstance: "x"')).ok).toBe(false);
    expect(
      parseJiraIssueTemplate(body(`issueTypeId: "10002"\njiraInstance: "${INSTANCE}"`)).ok,
    ).toBe(true);
  });

  it("are not offered without a closed front matter", () => {
    expect(bindJiraIssueTemplateText("# no front matter", binding)).toBeUndefined();
  });
});

describe("the one issue-type matcher", () => {
  const bound = template(
    bindJiraIssueTemplateText(PLAIN, { instance: INSTANCE, issueTypeId: "10002" }) ?? "",
  );

  it("governs a bound template by id, whatever the type is called", () => {
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10002", name: "Task" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10099", name: "Aufgabe" })).toBe(false);
  });

  it("matches a template without a binding by its typed name", () => {
    const legacy = template(PLAIN);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "aufgabe" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "Task" })).toBe(false);
  });

  it("drops a binding that was made for another Jira, so its ids never govern there", () => {
    expect(jiraTemplateForInstance(bound, INSTANCE).binding).toBeDefined();
    const foreign = jiraTemplateForInstance(bound, OTHER);
    expect(foreign.binding).toBeUndefined();
    expect(jiraTemplateIssueTypeMatches(foreign, { id: "10002", name: "Task" })).toBe(false);
  });
});
