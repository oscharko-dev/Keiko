import { describe, expect, it } from "vitest";
import {
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraTemplateBindingIds,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  readJiraTemplateInstanceMetadata,
  readJiraTemplateOptions,
  resolveJiraTemplateBinding,
} from "./jira-issue-template-instance.js";
import {
  jiraTransitionsFullyChecked,
  type JiraTemplateInstanceMetadata,
} from "./jira-issue-template-check.js";

// PR #4464 owner review (second round): one selected-type catalog for picker and binder, retained
// same-instance type ids, and an honest "checked" flag for a workflow list with an id-less row.
const INSTANCE = "0".repeat(32);

function parse(...lines: readonly string[]): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "summaryMinLength: 4",
      ...lines,
      "---",
      "# Template",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError(`Expected a parseable template ${JSON.stringify(parsed)}`);
  return parsed.template;
}

function withBinding(typed: JiraIssueTemplate, ids: JiraTemplateBindingIds): JiraIssueTemplate {
  return {
    ...typed,
    binding: { ...ids, digest: jiraTemplateBindingDigest(INSTANCE, typed, ids) },
  };
}

function items(list: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items: list };
}

describe("one match in the global catalog does not establish a field's identity", () => {
  const CREATE = "issue/createmeta/10000/issuetypes/10003?startAt=0&maxResults=100";
  function request(globalFields: readonly unknown[]): JiraMutationRequest {
    return (path) => {
      if (path === "project/SYN")
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { id: "10000", key: "SYN", issueTypes: [{ id: "10003", name: "Sub-task" }] },
        });
      if (path === "field") return Promise.resolve(items(globalFields));
      if (path === CREATE)
        return Promise.resolve({
          ok: true,
          status: 200,
          body: {
            values: [
              {
                fieldId: "parent",
                name: "Übergeordnet",
                required: true,
                schema: { type: "issuelink", system: "parent" },
                operations: ["set"],
              },
              {
                fieldId: "customfield_1",
                name: "Parent",
                required: false,
                schema: { type: "string", custom: "x:text", customId: 1 },
                operations: ["set"],
              },
            ],
            isLast: true,
            startAt: 0,
            maxResults: 100,
            total: 2,
          },
        });
      return Promise.resolve({ ok: false, reason: "not-found" });
    };
  }
  const typed = parse("issueType: Sub-task", "activateOn: [create]", "requiredFields: [Parent]");

  it.each([
    ["the custom field is absent", []],
    ["the custom field still has its former label", [{ id: "customfield_1", name: "Epic Name" }]],
  ])("binds what the picker offered when %s globally", async (_name, globalFields) => {
    const options = await readJiraTemplateOptions(
      request(globalFields),
      { projectKey: "SYN", issueTypeId: "10003" },
      INSTANCE,
    );
    if (!options.ok || options.options.kind !== "details") throw new TypeError("Expected details");
    expect(options.options.ambiguousFieldNames).toEqual([]);
    const read = await readJiraTemplateInstanceMetadata(request(globalFields), typed);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(resolveJiraTemplateBinding(typed, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["customfield_1"] },
    });
  });
});

describe("a binding keeps its verified type ids when a status is removed", () => {
  const withParent = parse(
    "issueType: Aufgabe",
    "activateOn: [transition:Erledigt]",
    "parentField: parent",
    "parentIssueTypes: [Epic]",
  );
  const saved = withBinding(withParent, {
    issueTypeId: "3",
    parentIssueTypeIds: ["10"],
    parentFieldId: "parent",
    transitionStatusIds: ["5"],
  });
  const fields = [{ id: "parent", name: "Parent" }];
  const epic = [{ id: "10", name: "Epic" }];
  const statusRefs = [{ id: "4", name: "Done" }];

  it("does not call a type dead because the acting user sees another name", () => {
    expect(
      resolveJiraTemplateBinding(
        saved,
        {
          project: { key: "SYN", issueTypes: [{ id: "3", name: "Task" }] },
          parentIssueTypes: epic,
          fields,
          statusRefs,
        },
        INSTANCE,
      ),
    ).toMatchObject({ state: "bindable", binding: { issueTypeId: "3" } });
  });

  it("does not rebind to another type that took the old name", () => {
    expect(
      resolveJiraTemplateBinding(
        saved,
        {
          project: {
            key: "SYN",
            issueTypes: [
              { id: "3", name: "Task" },
              { id: "12", name: "Aufgabe" },
            ],
          },
          parentIssueTypes: epic,
          fields,
          statusRefs,
        },
        INSTANCE,
      ),
    ).toMatchObject({ state: "bindable", issueType: "Task", binding: { issueTypeId: "3" } });
  });

  it("keeps a surviving parent type id when another type took its name", () => {
    expect(
      resolveJiraTemplateBinding(
        saved,
        {
          project: { key: "SYN", issueTypes: [{ id: "3", name: "Aufgabe" }] },
          parentIssueTypes: [
            { id: "10", name: "Initiative" },
            { id: "12", name: "Epic" },
          ],
          fields,
          statusRefs,
        },
        INSTANCE,
      ),
    ).toMatchObject({ state: "bindable", binding: { parentIssueTypeIds: ["10"] } });
  });

  it("binds status ids from the workflow of the type the name now finds", async () => {
    const request: JiraMutationRequest = (path) => {
      if (path === "project/SYN")
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { id: "10000", key: "SYN", issueTypes: [{ id: "12", name: "Aufgabe" }] },
        });
      if (path === "project/SYN/statuses")
        return Promise.resolve(
          items([
            { id: "3", name: "Aufgabe", statuses: [{ id: "5", name: "Old workflow" }] },
            { id: "12", name: "Aufgabe", statuses: [{ id: "7", name: "Erledigt" }] },
          ]),
        );
      if (path === "issuetype") return Promise.resolve(items([{ id: "10", name: "Epic" }]));
      return Promise.resolve(items([{ id: "parent", name: "Parent" }]));
    };
    const read = await readJiraTemplateInstanceMetadata(request, saved);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(read.instance.statusRefs).toEqual([{ id: "7", name: "Erledigt" }]);
    expect(resolveJiraTemplateBinding(saved, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { issueTypeId: "12", transitionStatusIds: ["7"] },
    });
  });
});

describe("a bound status the partial workflow list cannot verify is not a checked match", () => {
  const typed = parse("issueType: Aufgabe", "activateOn: [transition:Erledigt]");
  const instance = (complete: boolean): JiraTemplateInstanceMetadata => ({
    statuses: ["Terminé", "No id"],
    statusRefs: [{ id: "3", name: "Terminé" }],
    ...(complete ? {} : { statusRefsComplete: false }),
  });
  const bound = (id: string): JiraIssueTemplate =>
    withBinding(typed, { issueTypeId: "10002", transitionStatusIds: [id] });

  it("reports the unverified bound id as not fully checked", () => {
    expect(jiraTransitionsFullyChecked(bound("9"), instance(false))).toBe(false);
  });

  it("still confirms a bound id the partial list shows, and a complete list", () => {
    expect(jiraTransitionsFullyChecked(bound("3"), instance(false))).toBe(true);
    expect(jiraTransitionsFullyChecked(bound("9"), instance(true))).toBe(true);
  });

  it("is not checked at all when the workflow was not read", () => {
    expect(jiraTransitionsFullyChecked(bound("3"), {})).toBe(false);
  });
});
