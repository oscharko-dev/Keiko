import { describe, expect, it, vi } from "vitest";
import {
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  readJiraTemplateInstanceMetadata,
  resolveJiraTemplateBinding,
} from "./jira-issue-template-instance.js";
import { validateJiraIssueTemplateAgainstInstance } from "./jira-issue-template-check.js";

const INSTANCE = "0".repeat(32);
function template(): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Sub-task",
      "activateOn: [create]",
      "requiredFields: [Übergeordnet]",
      "---",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a valid Sub-task template");
  return parsed.template;
}
function fixture(createAvailable = true): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path) => {
    let response: AtlassianWriteHttpOutcome;
    if (path === "project/SYN") {
      response = {
        ok: true,
        status: 200,
        body: {
          id: "10000",
          key: "SYN",
          issueTypes: [{ id: "10003", name: "Sub-task" }],
        },
      };
    } else if (path === "field") {
      // Data Center omits parent from GET field, even in a German profile.
      response = {
        ok: true,
        status: 200,
        body: undefined,
        items: [{ id: "summary", name: "Zusammenfassung" }],
      };
    } else if (path.startsWith("issue/createmeta/")) {
      response = createAvailable
        ? {
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
              ],
              isLast: true,
              startAt: 0,
              maxResults: 100,
              total: 1,
            },
          }
        : { ok: false, reason: "permission-denied" };
    } else {
      response = { ok: false, reason: "permission-denied" };
    }
    return Promise.resolve(response);
  });
}

describe("localized Sub-task field validation", () => {
  it("resolves the proposed parent name from the same create metadata as the write gate", async () => {
    const request = fixture();
    const typed = template();
    const read = await readJiraTemplateInstanceMetadata(request, typed);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(validateJiraIssueTemplateAgainstInstance(typed, read.instance)).toEqual([]);
    expect(resolveJiraTemplateBinding(typed, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { issueTypeId: "10003", requiredFieldIds: ["parent"] },
    });
    expect(request).toHaveBeenCalledWith(
      "issue/createmeta/10000/issuetypes/10003?startAt=0&maxResults=100",
    );
    expect(request.mock.calls.every(([, method]) => method === undefined || method === "GET")).toBe(
      true,
    );
  });

  it("keeps an unreadable create catalog unchecked instead of claiming the field does not exist", async () => {
    const read = await readJiraTemplateInstanceMetadata(fixture(false), template());
    if (!read.ok) throw new TypeError("Expected partial metadata");
    expect(read.instance.fields).toBeUndefined();
    expect(validateJiraIssueTemplateAgainstInstance(template(), read.instance)).toEqual([]);
  });

  it("repairs a saved unresolved field binding without changing its existing type identity", async () => {
    const typed = template();
    const ids = { issueTypeId: "10003", requiredFieldIds: ["none"] };
    const saved = {
      ...typed,
      binding: { ...ids, digest: jiraTemplateBindingDigest(INSTANCE, typed, ids) },
    };
    const read = await readJiraTemplateInstanceMetadata(fixture(), saved);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(resolveJiraTemplateBinding(saved, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { issueTypeId: "10003", requiredFieldIds: ["parent"] },
    });
  });

  it("still reports an unknown field after reading the complete type catalog", async () => {
    const typed = { ...template(), requiredFields: ["No such parent"] };
    const read = await readJiraTemplateInstanceMetadata(fixture(), typed);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(validateJiraIssueTemplateAgainstInstance(typed, read.instance)).toEqual([
      { code: "unknown-field", subject: "No such parent" },
    ]);
    expect(resolveJiraTemplateBinding(typed, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { requiredFieldIds: ["none"] },
    });
  });

  it("keeps existing ids across languages and does not require an unnecessary create read", async () => {
    const typed = { ...template(), issueType: "Unteraufgabe" };
    const ids = { issueTypeId: "10003", requiredFieldIds: ["parent"] };
    const saved = {
      ...typed,
      binding: { ...ids, digest: jiraTemplateBindingDigest(INSTANCE, typed, ids) },
    };
    const request = fixture(false);
    const read = await readJiraTemplateInstanceMetadata(request, saved);
    if (!read.ok) throw new TypeError("Expected metadata");
    expect(validateJiraIssueTemplateAgainstInstance(saved, read.instance)).toEqual([]);
    expect(resolveJiraTemplateBinding(saved, read.instance, INSTANCE)).toEqual({
      state: "bound",
      issueType: "Sub-task",
    });
    expect(request.mock.calls.some(([path]) => path.startsWith("issue/createmeta"))).toBe(false);
  });

  it("fills a parentField slot while preserving known field, type and status ids", () => {
    const typed: JiraIssueTemplate = {
      ...template(),
      issueType: "Unteraufgabe",
      requiredFields: ["Summary"],
      parent: { field: "Übergeordnet" },
      activations: [{ kind: "transition", target: "Fertig" }],
    };
    const ids = {
      issueTypeId: "10003",
      requiredFieldIds: ["summary"],
      parentFieldId: "none",
      transitionStatusIds: ["7"],
    };
    const saved = {
      ...typed,
      binding: { ...ids, digest: jiraTemplateBindingDigest(INSTANCE, typed, ids) },
    };
    const resolution = resolveJiraTemplateBinding(
      saved,
      {
        project: { key: "SYN", issueTypes: [{ id: "10003", name: "Sub-task" }] },
        fields: [
          { id: "summary", name: "Zusammenfassung" },
          { id: "parent", name: "Übergeordnet" },
        ],
        statusRefs: [{ id: "7", name: "Done" }],
      },
      INSTANCE,
    );
    const repaired = { ...ids, parentFieldId: "parent" };
    expect(resolution).toMatchObject({
      state: "bindable",
      binding: {
        ...repaired,
        digest: jiraTemplateBindingDigest(INSTANCE, typed, repaired),
      },
    });
  });
});
