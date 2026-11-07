import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_CONFIGURATION_READ_DEFINITIONS, jiraConfigurationDeclarationForTool } from "./jiraConfigurationDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits every closed configuration read through the existing schema compiler", () => {
  expect(Object.keys(JIRA_CONFIGURATION_READ_DEFINITIONS)).toHaveLength(7);
  for (const [name, definition] of Object.entries(JIRA_CONFIGURATION_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraConfigurationDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.screens", { search: "", maxResults: 10 }, { items: [{ id: "1", name: "Default", deletable: false }], startAt: 0 }],
  ["jira.workflows", { workflowName: "Workflow" }, { items: [{ name: "Workflow", steps: 0, isDefault: false, lastModifiedDate: "a few moments ago" }], startAt: 0, total: 1 }],
  ["jira.custom-fields", { startAt: 10 }, { items: [{ id: "customfield_10001", numericId: "10001", name: "Field", isLocked: false, issuesWithValue: 0, projectIds: [], description: "" }], startAt: 10, total: 11 }],
  ["jira.custom-fields", {}, { items: [{ id: "9223372036854775807", name: "Exact identity" }], startAt: 0 }],
  ["jira.custom-field-options", { customFieldId: "10001", page: 3, projectIds: ["10000"], useAllContexts: false }, { customFieldId: "10001", items: [{ id: "2", value: "", disabled: false, childrenIds: [] }], page: 3, maxResults: 25, total: 51, optionsScope: "native-context-options" }],
  ["jira.custom-field-options", { customFieldId: "10001", useAllContexts: true }, { customFieldId: "10001", items: [], page: 1, maxResults: 25, optionsScope: "all-field-contexts" }],
  ["jira.terminology", {}, { items: [{ originalName: "Epic", newName: "Feature", isDefault: false }], startAt: 0, total: 1 }],
  ["jira.terminology-entry", { originalName: "sprint" }, { originalName: "Sprint", newNamePlural: "Iterations" }],
  ["jira.read-only-mode", {}, { enabled: false, message: "", endTime: "", timeZone: "" }],
  ["jira.read-only-mode", {}, {}],
] as const)("declares %s without inventing unknown metadata or permissions", (name, args, result) => {
  const declaration = jiraConfigurationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing configuration declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.screens", { expand: "tabs" }],
  ["jira.workflows", { workflowName: "Workflow", startAt: 0 }],
  ["jira.workflows", { workflowName: "Workflow", maxResults: 1 }],
  ["jira.custom-fields", { sort: "name" }],
  ["jira.custom-field-options", { customFieldId: "10001", page: 0 }],
  ["jira.custom-field-options", { customFieldId: "10001", page: 10001 }],
  ["jira.custom-field-options", { customFieldId: "10001", useAllContexts: true, projectIds: ["10000"] }],
  ["jira.custom-field-options", { customFieldId: "10001", useAllContexts: true, issueTypeIds: ["1"] }],
  ["jira.custom-field-options", { customFieldId: "10001", projectIds: [] }],
  ["jira.custom-field-options", { customFieldId: "10001", projectIds: ["1", "1"] }],
  ["jira.custom-field-options", { customFieldId: "10001", startAt: 0 }],
  ["jira.terminology-entry", { originalName: "issue" }],
  ["jira.read-only-mode", { enabled: true }],
] as const)("refuses unreviewed %s selectors and conflicting contexts", (name, args) => {
  const declaration = jiraConfigurationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing configuration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.screens", { items: [{ id: "1", name: "Default", editable: true }], startAt: 0 }],
  ["jira.workflows", { items: [{ name: "Workflow", steps: -1 }], startAt: 0 }],
  ["jira.workflows", { items: [{ name: "Workflow", isDefault: "false" }], startAt: 0 }],
  ["jira.custom-fields", { items: [{ id: "customfield_0", name: "Field" }], startAt: 0 }],
  ["jira.custom-fields", { items: [{ id: "1", name: "Field", numericId: 1 }], startAt: 0 }],
  ["jira.custom-field-options", { customFieldId: "1", items: [], page: 1, maxResults: 25, optionsScope: "effective-permissions" }],
  ["jira.read-only-mode", { enabled: null }],
  ["jira.read-only-mode", { enforced: true }],
] as const)("refuses unsupported %s result shapes", (name, result) => {
  const declaration = jiraConfigurationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing configuration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
it.each([
  ["jira.screens", "/screens"],
  ["jira.workflows", "/workflow"],
  ["jira.custom-fields", "/customFields"],
  ["jira.custom-field-options", "/customFields/{customFieldId}/options"],
  ["jira.terminology", "/terminology/entries"],
  ["jira.terminology-entry", "/terminology/entries/{originalName}"],
  ["jira.read-only-mode", "/readonly-mode"],
] as const)("binds %s to one fixed native GET identity", (name, path) => {
  const operation = jiraOperationForTool(name);
  expect(operation?.definition).toMatchObject({ kind: "native", method: "GET", apiRoot: "/rest/api/2", pathTemplate: path, effects: ["remote-read"] });
  expect(operation?.binding.identity).toBe(`GET /rest/api/2${path}`);
});
