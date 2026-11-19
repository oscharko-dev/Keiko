import { describe, expect, it, vi } from "vitest";
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
import { validateJiraIssueTemplateAgainstInstance } from "./jira-issue-template-check.js";

// PR #4464 review findings: the guided picker and the binder read one catalog, a binding keeps the
// ids that survive, and an incomplete workflow list never turns a bound id into a name comparison.
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

describe("one catalog for the guided choice and the saved binding", () => {
  const CREATE = "issue/createmeta/10000/issuetypes/10003?startAt=0&maxResults=100";
  function request(): JiraMutationRequest {
    return vi.fn<JiraMutationRequest>((path) => {
      if (path === "project/SYN")
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { id: "10000", key: "SYN", issueTypes: [{ id: "10003", name: "Sub-task" }] },
        });
      // Data Center omits the system parent from GET field; a custom field is named like its English name.
      if (path === "field")
        return Promise.resolve(items([{ id: "customfield_1", name: "Parent" }]));
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
    });
  }

  it("binds the field the picker offered as unambiguous, not none", async () => {
    const typed = parse("issueType: Sub-task", "activateOn: [create]", "requiredFields: [Parent]");
    const options = await readJiraTemplateOptions(
      request(),
      { projectKey: "SYN", issueTypeId: "10003" },
      INSTANCE,
    );
    if (!options.ok || options.options.kind !== "details") throw new TypeError("Expected details");
    expect(options.options.ambiguousFieldNames).toEqual([]);
    const read = await readJiraTemplateInstanceMetadata(request(), typed);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(resolveJiraTemplateBinding(typed, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["customfield_1"] },
    });
  });
});

describe("a binding keeps the ids that survive a removed status", () => {
  const typed = parse(
    "issueType: Aufgabe",
    "activateOn: [transition:Fertig, transition:Erledigt]",
    "requiredFields: [Punkte]",
  );
  it("keeps a still-present id and resolves only the missing slot", () => {
    const saved = withBinding(typed, {
      issueTypeId: "10002",
      requiredFieldIds: ["customfield_7"],
      transitionStatusIds: ["4", "5"],
    });
    const resolution = resolveJiraTemplateBinding(
      saved,
      {
        project: { key: "SYN", issueTypes: [{ id: "10002", name: "Aufgabe" }] },
        fields: [{ id: "customfield_7", name: "Points" }],
        // The acting profile calls status 4 "Done"; status 5 is gone.
        statusRefs: [{ id: "4", name: "Done" }],
      },
      INSTANCE,
    );
    expect(resolution).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["customfield_7"], transitionStatusIds: ["4", "none"] },
    });
  });

  it("keeps a surviving field id when another field is gone", () => {
    const two = parse("issueType: Aufgabe", "activateOn: [create]", "requiredFields: [A, B]");
    const saved = withBinding(two, {
      issueTypeId: "10002",
      requiredFieldIds: ["customfield_1", "customfield_2"],
    });
    expect(
      resolveJiraTemplateBinding(
        saved,
        {
          project: { key: "SYN", issueTypes: [{ id: "10002", name: "Aufgabe" }] },
          fields: [
            { id: "customfield_1", name: "Other label" },
            { id: "customfield_3", name: "B" },
          ],
        },
        INSTANCE,
      ),
    ).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["customfield_1", "customfield_3"] },
    });
  });
});

describe("a bound status is judged by its id even when the workflow list is incomplete", () => {
  const typed = parse("issueType: Aufgabe", "activateOn: [transition:Erledigt]");
  const row = (id: string, name: string): Record<string, unknown> => ({ id, name });
  function request(statuses: readonly unknown[]): JiraMutationRequest {
    return (path) => {
      if (path === "project/SYN")
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { id: "10000", key: "SYN", issueTypes: [{ id: "10002", name: "Aufgabe" }] },
        });
      if (path === "project/SYN/statuses")
        return Promise.resolve(items([{ id: "10002", name: "Aufgabe", statuses }]));
      return Promise.resolve({ ok: true, status: 200, body: undefined, items: [] });
    };
  }
  async function findings(id: string, statuses: readonly unknown[]): Promise<readonly unknown[]> {
    const saved = withBinding(typed, { issueTypeId: "10002", transitionStatusIds: [id] });
    const read = await readJiraTemplateInstanceMetadata(request(statuses), saved);
    if (!read.ok) throw new TypeError("Expected metadata");
    return validateJiraIssueTemplateAgainstInstance(saved, read.instance);
  }

  it("does not compare labels for a verified id when one row has no id", async () => {
    expect(await findings("3", [row("3", "Terminé"), { name: "No id" }])).toEqual([]);
  });

  it("does not claim a bound id unknown when it may be the row without an id", async () => {
    expect(await findings("9", [row("3", "Terminé"), { name: "No id" }])).toEqual([]);
  });

  it("still reports a bound id a complete workflow does not list", async () => {
    expect(await findings("9", [row("3", "Terminé")])).toEqual([
      { code: "unknown-transition-target", subject: "Erledigt" },
    ]);
  });
});
