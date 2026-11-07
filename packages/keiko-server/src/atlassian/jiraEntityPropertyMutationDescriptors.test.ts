import { expect, it, vi } from "vitest";
import {
  JIRA_ENTITY_PROPERTY_MUTATIONS,
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_ENTITY_PROPERTY_WRITE_DEFINITIONS,
  jiraEntityPropertyMutationDeclarationForTool,
} from "./jiraEntityPropertyMutationDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

const NULL = [{ path: "", kind: "null" }] as const;
const FALSE = [{ path: "", kind: "boolean", booleanValue: false }] as const;
const CASES = [
  { set: "jira.set-board-property", remove: "jira.delete-board-property", entity: { boardId: "7" }, receipt: { boardId: "7" }, root: "/rest/agile/1.0" },
  { set: "jira.set-sprint-property", remove: "jira.delete-sprint-property", entity: { sprintId: "8" }, receipt: { sprintId: "8" }, root: "/rest/agile/1.0" },
  { set: "jira.set-comment-property", remove: "jira.delete-comment-property", entity: { issueIdOrKey: "SYN-1", commentId: "9" }, receipt: { issueId: "10001", issueKey: "SYN-1", commentId: "9" }, root: "/rest/api/2" },
  { set: "jira.set-dashboard-item-property", remove: "jira.delete-dashboard-item-property", entity: { dashboardId: "7", itemId: "8" }, receipt: { dashboardId: "7", selectedItemId: "8" }, root: "/rest/api/2" },
  { set: "jira.set-issue-property", remove: "jira.delete-issue-property", entity: { issueIdOrKey: "SYN-1" }, receipt: { issueId: "10001", issueKey: "SYN-1" }, root: "/rest/api/2" },
  { set: "jira.set-issue-type-property", remove: "jira.delete-issue-type-property", entity: { issueTypeId: "10000" }, receipt: { issueTypeId: "10000" }, root: "/rest/api/2" },
  { set: "jira.set-project-property", remove: "jira.delete-project-property", entity: { projectIdOrKey: "SYN" }, receipt: { projectId: "10000", projectKey: "SYN" }, root: "/rest/api/2" },
  { set: "jira.set-user-property", remove: "jira.delete-user-property", entity: { username: "synthetic user" }, receipt: { userKey: "synthetic-key", username: "synthetic user" }, root: "/rest/api/2" },
] as const;
it("keeps a single frozen complete property-mutation vocabulary and uniform governed action facts", () => {
  expect(Object.isFrozen(JIRA_ENTITY_PROPERTY_MUTATIONS)).toBe(true);
  expect(Reflect.set(JIRA_ENTITY_PROPERTY_MUTATIONS, "0", "jira.proxy")).toBe(false);
  expect(JIRA_ENTITY_PROPERTY_MUTATIONS).toEqual(CASES.flatMap(({ set, remove }) => [set, remove]));
  expect(Object.keys(JIRA_ENTITY_PROPERTY_WRITE_DEFINITIONS)).toEqual([...JIRA_ENTITY_PROPERTY_MUTATIONS]);
  for (const name of JIRA_ENTITY_PROPERTY_MUTATIONS) {
    expect(JIRA_MUTATION_OPERATIONS.filter((operation) => operation === name)).toHaveLength(1);
    const action = JIRA_MANAGED_ACTION_TYPES[name];
    expect(action).toBe(name.slice(5));
    expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[action]).toBe("high");
    expect(ATLASSIAN_CONNECTOR_ACTION_CLASS[action]).toBe("connector-write");
    expect(ATLASSIAN_CONNECTOR_ACTION_PROVIDER[action]).toBe("jira");
    expect(ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[action]).toBe("issue-tracker.write");
  }
});
it.each(CASES)("reuses the bounded typed value projection and canonical context for $set / $remove", ({ set, remove, entity, receipt, root }) => {
  for (const name of [set, remove]) {
    const definition = JIRA_ENTITY_PROPERTY_WRITE_DEFINITIONS[name];
    expect(isBoundedExternalJsonSchema(definition.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result)).toBe(true);
    const declaration = jiraEntityPropertyMutationDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing property mutation declaration");
    const args = { ...entity, propertyKey: "display ~key", expectedValueNodes: FALSE,
      ...(name === set ? { valueNodes: NULL } : {}) };
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    for (const outcome of ["succeeded", "succeeded-unconfirmed", "unknown"])
      expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome, ...receipt, propertyKey: "display ~key", propertyPresent: name === set,
      })).toBeUndefined();
    expect(jiraOperationForTool(name)?.definition).toMatchObject({
      apiRoot: root, method: name === set ? "PUT" : "DELETE", effects: ["remote-read", "remote-write"],
    });
    const connection = vi.fn();
    const execute = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name], execute).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }
});
it.each([
  { expectedValueNodes: NULL },
  { expectAbsent: true },
])("admits one explicit reviewed prior-state form, preserving null as data: %j", (review) => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-issue-property");
  if (declaration === undefined) throw new TypeError("Missing issue property declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
    issueIdOrKey: "SYN-1", propertyKey: "display", valueNodes: FALSE, ...review,
  })).toBeUndefined();
});
it.each([
  {},
  { expectAbsent: false },
  { expectAbsent: true, expectedValueNodes: NULL },
  { expectedValueNodes: [] },
  { expectedValueNodes: [{ path: "", kind: "null", textValue: "null" }] },
  { expectedValueNodes: [{ path: "", kind: "boolean", booleanValue: "false" }] },
  { expectedValueNodes: NULL, valueNodes: [{ path: "", kind: "object", childCount: 129 }] },
  { expectedValueNodes: NULL, propertyKey: "x/y" },
  { expectedValueNodes: NULL, propertyKey: "%2f" },
  { expectedValueNodes: NULL, propertyKey: ".." },
  { expectedValueNodes: NULL, method: "POST" },
])("refuses missing/widened property review forms before dispatch: %j", (extra) => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-issue-property");
  if (declaration === undefined) throw new TypeError("Missing issue property declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
    issueIdOrKey: "SYN-1", propertyKey: "display", valueNodes: FALSE, ...extra,
  })).toBeDefined();
});
it.each([
  { expectAbsent: true },
  { expectedValueNodes: NULL, valueNodes: FALSE },
])("requires a present reviewed value for property deletion: %j", (extra) => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.delete-issue-property");
  if (declaration === undefined) throw new TypeError("Missing delete property declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
    issueIdOrKey: "SYN-1", propertyKey: "display", ...extra,
  })).toBeDefined();
});
it.each([{}, { username: "synthetic", userKey: "synthetic-key" }])("keeps the exactly-one user selector separate from the reviewed property form: %j", (entity) => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-user-property");
  if (declaration === undefined) throw new TypeError("Missing user property declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
    ...entity, propertyKey: "display", expectAbsent: true, valueNodes: NULL,
  })).toBeDefined();
});
