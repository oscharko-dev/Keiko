import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraAdministrationDeclarationForTool } from "./jiraAdministrationDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ID = "9007199254740993";
it.each([
  [
    "jira.issue-type-schemes",
    { includeIssueTypes: true },
    {
      items: [{ id: ID, name: "Scheme", issueTypes: [{ id: "1", name: "Task", subtask: false }] }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.issue-type-scheme",
    { schemeId: ID },
    { schemeId: ID, items: [{ id: ID, name: "Scheme" }] },
  ],
  [
    "jira.issue-type-scheme-projects",
    { schemeId: ID },
    { schemeId: ID, items: [{ id: "10", key: "APP", name: "App", archived: false }] },
  ],
  [
    "jira.workflow-scheme",
    { schemeId: ID, returnDraftIfExists: true },
    { schemeId: ID, id: "12", draft: true },
  ],
  [
    "jira.workflow-scheme-draft",
    { schemeId: ID },
    {
      schemeId: ID,
      id: "12",
      items: [{ issueTypeId: "1", originalWorkflow: "Old workflow" }],
      startAt: 0,
      total: 1,
    },
  ],
  ["jira.workflow-scheme-default", { schemeId: ID }, { schemeId: ID, workflow: "Delivery" }],
  [
    "jira.workflow-scheme-draft-default",
    { schemeId: ID },
    { schemeId: ID, workflow: "Delivery draft" },
  ],
  [
    "jira.workflow-scheme-issue-type",
    { schemeId: ID, issueTypeId: "1" },
    { schemeId: ID, issueTypeId: "1", workflow: "Delivery" },
  ],
  [
    "jira.workflow-scheme-draft-issue-type",
    { schemeId: ID, issueTypeId: "1" },
    { schemeId: ID, issueTypeId: "1", workflow: "Delivery draft" },
  ],
  [
    "jira.workflow-scheme-workflows",
    { schemeId: ID, workflowName: "Delivery" },
    {
      schemeId: ID,
      items: [{ workflow: "Delivery", issueTypeIds: ["1"], defaultMapping: false }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.workflow-scheme-draft-workflows",
    { schemeId: ID, maxResults: 1 },
    { schemeId: ID, items: [{ workflow: "Draft", issueTypeIds: [] }], startAt: 0, total: 1 },
  ],
  [
    "jira.screen-tabs",
    { screenId: ID, projectKey: "APP" },
    { screenId: ID, projectKey: "APP", items: [{ id: "1", name: "Fields" }] },
  ],
  [
    "jira.screen-tab-fields",
    { screenId: ID, tabId: "1" },
    {
      screenId: ID,
      tabId: "1",
      items: [{ id: "summary", name: "Summary", type: "system", showWhenEmpty: false }],
    },
  ],
  [
    "jira.screen-available-fields",
    { screenId: ID },
    { screenId: ID, items: [{ id: "customfield_10000", name: "Scope" }] },
  ],
] as const)(
  "declares %s through the existing provider with its typed projection",
  (name, args, data) => {
    const declaration = jiraAdministrationDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing administration declaration");
    expect(declaration.risk).toBe("read");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...data,
      }),
    ).toBeUndefined();
    const connection = vi.fn();
    const provider = createJiraProviderForCatalog(connection, [name]);
    expect(provider.tools()).toHaveLength(1);
    expect(provider.tools()[0]?.descriptor.inputSchema).toEqual(declaration.descriptor.inputSchema);
    expect(connection).not.toHaveBeenCalled();
  },
);
it.each([
  ["jira.issue-type-schemes", { expand: "all" }],
  ["jira.issue-type-scheme", { schemeId: "../scheme" }],
  ["jira.issue-type-scheme-projects", { schemeId: ID, maxResults: 101 }],
  ["jira.workflow-scheme", { schemeId: ID, returnDraftIfExists: "true" }],
  ["jira.workflow-scheme-draft", { schemeId: ID, returnDraftIfExists: true }],
  ["jira.workflow-scheme-default", { schemeId: ID, startAt: 0 }],
  ["jira.workflow-scheme-issue-type", { schemeId: ID }],
  ["jira.workflow-scheme-workflows", { schemeId: ID, workflowName: "" }],
  ["jira.screen-tabs", { screenId: ID, projectKey: "../escape" }],
  ["jira.screen-tab-fields", { screenId: ID }],
  ["jira.screen-available-fields", { screenId: ID, projectKey: "APP" }],
] as const)("refuses unsupported %s inputs before dispatch", (name, args) => {
  const declaration = jiraAdministrationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing administration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("does not invent workflow mutations or return remote navigation URLs", () => {
  expect(jiraAdministrationDeclarationForTool("jira.create-workflow-scheme")).toBeUndefined();
  const declaration = jiraAdministrationDeclarationForTool("jira.workflow-scheme");
  if (declaration === undefined) throw new TypeError("Missing administration declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      schemeId: ID,
      self: "https://untrusted.invalid/scheme",
    }),
  ).toBeDefined();
});
