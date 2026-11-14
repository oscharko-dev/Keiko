import { describe, expect, it } from "vitest";
import {
  bindJiraIssueTemplateText,
  jiraTemplateBindingDigest,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  jiraTemplateParentEntryMatches,
  jiraTemplateParentTypeMatches,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraTemplateBinding,
} from "./jira-issue-template.js";

// #4354: a template's binding is written by the product into its front matter, so it travels with an
// exported copy. It is in force only for the Jira and the typed names it was resolved from.
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

/** The binding the product would write for this document in this Jira: the digest comes from its producer. */
function bindingFor(
  markdown: string,
  instance: string,
  ids: Pick<JiraTemplateBinding, "issueTypeId" | "parentIssueTypeIds">,
): JiraTemplateBinding {
  return { digest: jiraTemplateBindingDigest(instance, template(markdown)), ...ids };
}

const IDS = { issueTypeId: "10002", parentIssueTypeIds: ["10000"] };
const BINDING = bindingFor(PLAIN, INSTANCE, IDS);
const BOUND = bindJiraIssueTemplateText(PLAIN, BINDING) ?? "";

describe("the binding lines the product writes", () => {
  it("are parsed back as the template's binding and leave every other line as it was", () => {
    expect(BOUND).not.toBe("");
    expect(template(BOUND).binding).toEqual(BINDING);
    const lines = BOUND.split("\n").filter(
      (line) => !/^(issueTypeId|parentIssueTypeIds|jiraBinding):/u.test(line),
    );
    expect(lines).toEqual(PLAIN.split("\n"));
  });

  it("replace an earlier binding instead of adding a second one", () => {
    const again = bindJiraIssueTemplateText(
      BOUND,
      bindingFor(PLAIN, OTHER, { issueTypeId: "10009", parentIssueTypeIds: ["10001"] }),
    );
    expect(template(again ?? "").binding?.issueTypeId).toBe("10009");
    expect((again ?? "").match(/^issueTypeId:/gmu)).toHaveLength(1);
    expect((again ?? "").match(/^jiraBinding:/gmu)).toHaveLength(1);
  });

  it("are not offered without a closed front matter or without an issueType line", () => {
    expect(bindJiraIssueTemplateText("# no front matter", BINDING)).toBeUndefined();
    expect(
      bindJiraIssueTemplateText(PLAIN.replace("issueType: Aufgabe\n", ""), BINDING),
    ).toBeUndefined();
  });
});

// B1: a binding that is not confirmed by the typed values it was resolved from never governs.
describe("a binding is in force only for the Jira and the typed names it was resolved from", () => {
  const edited = (from: string, to: string): JiraIssueTemplate => template(BOUND.replace(from, to));

  it("survives an edit that changes neither the names nor the Jira (case and blanks do not matter)", () => {
    expect(jiraTemplateForInstance(template(BOUND), INSTANCE).binding).toEqual(BINDING);
    expect(
      jiraTemplateForInstance(edited("issueType: Aufgabe", "issueType:   aufgabe "), INSTANCE)
        .binding,
    ).toEqual(BINDING);
  });

  it("is dropped when the typed issue type is edited, so the old id no longer governs the new type", () => {
    const bug = jiraTemplateForInstance(edited("issueType: Aufgabe", "issueType: Bug"), INSTANCE);
    expect(bug.binding).toBeUndefined();
    // Name matching: the template now governs Bug, not the type whose id it still carries.
    expect(jiraTemplateIssueTypeMatches(bug, { id: "10002", name: "Aufgabe" })).toBe(false);
    expect(jiraTemplateIssueTypeMatches(bug, { id: "10005", name: "Bug" })).toBe(true);
  });

  it("is dropped when the typed parent types are edited, so the old parent ids no longer govern", () => {
    const other = jiraTemplateForInstance(
      edited("parentIssueTypes: [Epos]", "parentIssueTypes: [Story]"),
      INSTANCE,
    );
    expect(other.binding).toBeUndefined();
    expect(jiraTemplateParentTypeMatches(other, { id: "10000", name: "Epos" })).toBe(false);
    expect(jiraTemplateParentTypeMatches(other, { id: "10001", name: "Story" })).toBe(true);
  });

  it("is dropped on another Jira", () => {
    const foreign = jiraTemplateForInstance(template(BOUND), OTHER);
    expect(foreign.binding).toBeUndefined();
    expect(jiraTemplateIssueTypeMatches(foreign, { id: "10002", name: "Task" })).toBe(false);
    expect(jiraTemplateForInstance(template(BOUND), undefined).binding).toBeUndefined();
  });

  it("is never made by a hand-written id: ids without the digest are no binding, a wrong digest is dropped", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    const handWritten = template(body('issueTypeId: "10002"'));
    expect(handWritten.binding).toBeUndefined();
    expect(jiraTemplateIssueTypeMatches(handWritten, { id: "10002", name: "Task" })).toBe(false);
    const forged = template(body(`issueTypeId: "10002"\njiraBinding: "${"0".repeat(32)}"`));
    expect(forged.binding).toBeDefined();
    expect(jiraTemplateForInstance(forged, INSTANCE).binding).toBeUndefined();
  });

  it("refuses ids and digests that are no ids or digests", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    expect(parseJiraIssueTemplate(body('issueTypeId: "Task"')).ok).toBe(false);
    expect(parseJiraIssueTemplate(body('jiraBinding: "x"')).ok).toBe(false);
    expect(
      parseJiraIssueTemplate(body(`issueTypeId: "10002"\njiraBinding: "${INSTANCE}"`)).ok,
    ).toBe(true);
  });
});

describe("what the writer does to the document (S4)", () => {
  it("keeps every other byte and the CRLF line endings of the document", () => {
    const crlf = PLAIN.replaceAll("\n", "\r\n") + "\r\n";
    const written = bindJiraIssueTemplateText(crlf, BINDING) ?? "";
    expect(written).not.toBe("");
    expect(written).not.toMatch(/(?<!\r)\n/u);
    const others = written
      .split("\r\n")
      .filter((line) => !/^(issueTypeId|parentIssueTypeIds|jiraBinding):/u.test(line));
    expect(others).toEqual(crlf.split("\r\n"));
    expect(template(written).binding).toEqual(BINDING);
  });

  it("touches only binding lines that start in the first column", () => {
    const withLookAlike = BOUND.replace("version: 1", "version: 1\n# note\n");
    const written = bindJiraIssueTemplateText(withLookAlike, BINDING) ?? "";
    expect(written).toContain("# note");
    // An indented look-alike is the parser's key too: the result would carry two, so nothing is written.
    const indented = PLAIN.replace("activateOn:", '  issueTypeId: "5"\nactivateOn:');
    expect(bindJiraIssueTemplateText(indented, BINDING)).toBeUndefined();
  });

  it("returns only text that parses back to a template carrying exactly this binding", () => {
    const wrongIds = { ...BINDING, issueTypeId: "not-an-id" };
    expect(bindJiraIssueTemplateText(PLAIN, wrongIds)).toBeUndefined();
    const broken = PLAIN.replace("activateOn: [create, edit]", "activateOn: [nonsense");
    expect(bindJiraIssueTemplateText(broken, BINDING)).toBeUndefined();
  });
});

describe("the one issue-type and parent-type matcher", () => {
  const bound = jiraTemplateForInstance(template(BOUND), INSTANCE);

  it("governs a bound template by id, whatever the type is called", () => {
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10002", name: "Task" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10099", name: "Aufgabe" })).toBe(false);
    expect(jiraTemplateParentTypeMatches(bound, { id: "10000", name: "Epic" })).toBe(true);
    expect(jiraTemplateParentTypeMatches(bound, { id: "10099", name: "Epos" })).toBe(false);
    expect(jiraTemplateParentEntryMatches(bound, 0, { id: "10000", name: "Epic" })).toBe(true);
    expect(jiraTemplateParentEntryMatches(bound, 1, { id: "10000", name: "Epic" })).toBe(false);
  });

  it("matches a template without a binding by its typed name", () => {
    const legacy = template(PLAIN);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "aufgabe" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "Task" })).toBe(false);
    expect(jiraTemplateParentEntryMatches(legacy, 0, { id: "10000", name: "EPOS" })).toBe(true);
  });
});
