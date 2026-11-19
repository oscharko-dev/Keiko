import { describe, expect, it } from "vitest";
import {
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { resolveJiraTemplateBinding } from "./jira-issue-template-instance.js";
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
      "summaryMinLength: 4",
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
      digest: jiraTemplateBindingDigest(INSTANCE, base, {
        issueTypeId,
        ...(parentIssueTypeIds === undefined ? {} : { parentIssueTypeIds }),
      }),
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
    fields: { customfield_10014: "SYN-5", summary: "A summary that is long enough" },
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

// B1/B2: what the acting person's own view says about a template that is already bound.
describe("resolving a template's binding in the acting person's view", () => {
  const PROJECT = (
    types: readonly { id: string; name: string }[],
  ): { project: { key: string; issueTypes: readonly { id: string; name: string }[] } } => ({
    project: { key: "SYN", issueTypes: types },
  });
  it("offers a fresh binding whose digest is the producer's, from the typed names", () => {
    const plain = template("Aufgabe");
    const resolution = resolveJiraTemplateBinding(
      plain,
      PROJECT([{ id: "10002", name: "Aufgabe" }]),
      INSTANCE,
    );
    expect(resolution).toMatchObject({
      state: "bindable",
      binding: {
        digest: jiraTemplateBindingDigest(INSTANCE, plain, { issueTypeId: "10002" }),
        issueTypeId: "10002",
      },
    });
  });

  it("calls a binding whose type is gone and whose typed name finds none dead", () => {
    const dead = bound(template("Aufgabe"), "99999");
    expect(
      resolveJiraTemplateBinding(dead, PROJECT([{ id: "10002", name: "Task" }]), INSTANCE),
    ).toEqual({ state: "dead", subject: "Aufgabe" });
  });

  it("binds again from the typed name when the type was recreated under a new id", () => {
    const stale = bound(template("Aufgabe"), "99999");
    expect(
      resolveJiraTemplateBinding(stale, PROJECT([{ id: "10077", name: "Aufgabe" }]), INSTANCE),
    ).toMatchObject({ state: "bindable", binding: { issueTypeId: "10077" } });
  });

  it("keeps a binding that still finds its type as it is", () => {
    const current = bound(template("Aufgabe"), "10002");
    expect(
      resolveJiraTemplateBinding(current, PROJECT([{ id: "10002", name: "Task" }]), INSTANCE),
    ).toEqual({ state: "bound", issueType: "Task" });
  });
});

// Part 2 (#4354): fields and transition targets are resolved to ids in the same step, aligned to the
// typed lists, and an entry nothing resolves is written `none` and matched by name.
describe("resolving the field and status ids of a template", () => {
  const view = (
    fields: readonly { id: string; name: string }[],
    statusRefs: readonly { id: string; name: string }[],
  ): Parameters<typeof resolveJiraTemplateBinding>[1] => ({
    project: { key: "SYN", issueTypes: [{ id: "10002", name: "Aufgabe" }] },
    fields,
    statusRefs,
  });
  const parsedTyped = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Aufgabe",
      "activateOn: [transition:Fertig, transition:31]",
      "requiredFields: [Story Punkte, Gibt es nicht]",
      "---",
      "# Aufgabe",
    ].join("\n"),
  );
  if (!parsedTyped.ok) throw new TypeError("Expected a parseable template");
  const typed = parsedTyped.template;

  it("binds each typed field and status to its id and the rest to none, aligned to the typed lists", () => {
    const resolution = resolveJiraTemplateBinding(
      typed,
      view([{ id: "customfield_10016", name: "Story Punkte" }], [{ id: "5", name: "Fertig" }]),
      INSTANCE,
    );
    expect(resolution).toMatchObject({
      state: "bindable",
      binding: {
        issueTypeId: "10002",
        requiredFieldIds: ["customfield_10016", "none"],
        transitionStatusIds: ["5", "none"],
      },
    });
    if (resolution.state !== "bindable") throw new TypeError("Expected a bindable template");
    const { digest, ...ids } = resolution.binding;
    expect(digest).toBe(jiraTemplateBindingDigest(INSTANCE, typed, ids));
  });

  it("does not bind a field name that two fields carry", () => {
    const resolution = resolveJiraTemplateBinding(
      template("Aufgabe", "requiredFields: [Punkte]"),
      view(
        [
          { id: "customfield_1", name: "Punkte" },
          { id: "customfield_2", name: "Punkte" },
        ],
        [],
      ),
      INSTANCE,
    );
    expect(resolution).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["none"] },
    });
  });

  it("fills an unresolved status slot once the workflow is known and keeps confirmed slots (PR #4464)", () => {
    const first = resolveJiraTemplateBinding(typed, view([], []), INSTANCE);
    if (first.state !== "bindable") throw new TypeError("Expected a bindable template");
    expect(first.binding.transitionStatusIds).toEqual(["none", "none"]);
    const boundFirst: JiraIssueTemplate = { ...typed, binding: first.binding };
    const later = resolveJiraTemplateBinding(
      boundFirst,
      view([], [{ id: "5", name: "Fertig" }]),
      INSTANCE,
    );
    if (later.state !== "bindable") throw new TypeError("Expected a completed binding");
    expect(later.binding.transitionStatusIds).toEqual(["5", "none"]);
    const { digest, ...ids } = later.binding;
    expect(digest).toBe(jiraTemplateBindingDigest(INSTANCE, typed, ids));
    // A confirmed slot is never overwritten by a translated or duplicated name.
    const settled: JiraIssueTemplate = { ...typed, binding: later.binding };
    expect(
      resolveJiraTemplateBinding(
        settled,
        view(
          [],
          [
            { id: "5", name: "Terminé" },
            { id: "7", name: "Fertig" },
          ],
        ),
        INSTANCE,
      ),
    ).toMatchObject({ state: "bound" });
  });

  it("keeps a bound template bound when the author's view resolves none of its slots (PR #4464)", () => {
    // A binding that carries only the issue type: an empty catalog and workflow learn nothing, so
    // writing `none` placeholders must not offer a new binding with a new digest.
    const onlyType = bound(typed, "10002");
    expect(resolveJiraTemplateBinding(onlyType, view([], []), INSTANCE)).toMatchObject({
      state: "bound",
    });
    // A slot the view does resolve is still learned.
    expect(
      resolveJiraTemplateBinding(onlyType, view([], [{ id: "5", name: "Fertig" }]), INSTANCE),
    ).toMatchObject({ state: "bindable", binding: { transitionStatusIds: ["5", "none"] } });
  });

  it("binds again when a bound field id is gone from the author's view (stale ids)", () => {
    const stale = template("Aufgabe", "requiredFields: [Story Punkte]");
    const resolvedBefore = resolveJiraTemplateBinding(
      stale,
      view([{ id: "customfield_10016", name: "Story Punkte" }], []),
      INSTANCE,
    );
    if (resolvedBefore.state !== "bindable") throw new TypeError("Expected a bindable template");
    const boundBefore: JiraIssueTemplate = { ...stale, binding: resolvedBefore.binding };
    const again = resolveJiraTemplateBinding(
      boundBefore,
      view([{ id: "customfield_20000", name: "Story Punkte" }], []),
      INSTANCE,
    );
    expect(again).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["customfield_20000"] },
    });
    expect(
      resolveJiraTemplateBinding(
        boundBefore,
        view([{ id: "customfield_10016", name: "Story Punkte" }], []),
        INSTANCE,
      ),
    ).toMatchObject({ state: "bound" });
  });
});
