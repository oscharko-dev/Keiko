import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { JIRA_NONSECRET_PREFERENCE_KINDS } from "@oscharko-dev/keiko-connectors";
import { JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS, jiraSavedConfigurationMutationDeclarationForTool } from "./jiraSavedConfigurationMutationDescriptors.js";
import { JIRA_FILTER_READ_DEFINITIONS } from "./jiraAgileDescriptors.js";

function declaration(name: string) {
  const result = jiraSavedConfigurationMutationDeclarationForTool(name);
  if (result === undefined) throw new TypeError("Missing saved configuration declaration");
  return result;
}
it("compiles exactly ten closed writes through the existing declaration owner", () => {
  expect(Object.keys(JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS)).toHaveLength(10);
  for (const [name, definition] of Object.entries(JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), name).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), name).toBe(true);
    expect(declaration(name).risk).toBe("write");
  }
  expect(jiraSavedConfigurationMutationDeclarationForTool("constructor")).toBeUndefined();
  expect(jiraSavedConfigurationMutationDeclarationForTool("jira.share-everything")).toBeUndefined();
});
it.each([
  ["jira.create-filter", { expectedActorKey: "actor", expectedDefaultShareScope: "PRIVATE", acceptDefaultSharing: true, name: "Reviewed", jql: "project=SYN" }],
  ["jira.update-filter", { filterId: "37", expectedOwnerKey: "actor", expectedName: "Reviewed", expectedJql: "project=SYN", expectedDescription: null, description: "" }],
  ["jira.delete-filter", { filterId: "37", expectedOwnerKey: "actor", expectedName: "Reviewed", expectedJql: "project=SYN", expectedDescription: "" }],
  ["jira.set-filter-share-scope", { expectedActorKey: "actor", expectedScope: "GLOBAL", scope: "PRIVATE" }],
  ["jira.set-filter-columns", { filterId: "37", expectedOwnerKey: "actor", expectedColumns: [], expectedColumnConfig: null, columns: ["summary"] }],
  ["jira.reset-filter-columns", { filterId: "37", expectedOwnerKey: "actor", expectedColumns: ["summary"], expectedColumnConfig: "FILTER" }],
  ["jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "actor", expectedPermissions: [], permission: { type: "group", groupName: "engineers", view: true, edit: false } }],
  ["jira.delete-filter-permission", { filterId: "37", expectedOwnerKey: "actor", expectedPermissions: [], permissionId: "51" }],
  ["jira.set-my-preference", { key: "user.notify.own.changes", expectedActorKey: "actor", expectedValue: true, value: false }],
  ["jira.delete-my-preference", { key: "user.issues.per.page", expectedActorKey: "actor", expectedValue: 0 }],
] as const)("admits reviewed typed %s arguments", (name, args) => {
  expect(describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args)).toBeUndefined();
});
it.each([
  ["jira.create-filter", { expectedActorKey: "actor", expectedDefaultShareScope: "PRIVATE", name: "Reviewed", jql: "project=SYN" }],
  ["jira.create-filter", { expectedActorKey: "actor", expectedDefaultShareScope: "PRIVATE", acceptDefaultSharing: true, name: "Reviewed", jql: "project=SYN", sharePermissions: [] }],
  ["jira.update-filter", { filterId: "37", expectedOwnerKey: "actor", expectedName: "Reviewed", expectedJql: "project=SYN", expectedDescription: null }],
  ["jira.set-filter-share-scope", { expectedActorKey: "actor", expectedScope: "PRIVATE", scope: "GLOBAL" }],
  ["jira.set-filter-columns", { filterId: "37", expectedOwnerKey: "actor", expectedColumns: [], expectedColumnConfig: null, columns: [] }],
  ["jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "actor", expectedPermissions: [], permission: { type: "global", view: true, edit: true }, acceptGlobalReplacement: true }],
  ["jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "actor", expectedPermissions: [], permission: { type: "group", groupName: "engineers", projectId: "10000", view: true, edit: false } }],
  ["jira.set-my-preference", { key: "user.notify.own.changes", expectedActorKey: "actor", expectedValue: true, value: "false" }],
  ["jira.set-my-preference", { key: "user.issues.per.page", expectedActorKey: "actor", expectedValue: 25, value: 1.5 }],
  ["jira.set-my-preference", { key: "jira.password", expectedActorKey: "actor", expectedValue: "", value: "private" }],
  ["jira.delete-my-preference", { key: "jira.user.locale", expectedActorKey: "actor", expectedValue: "de_DE", value: "" }],
] as const)("refuses undeclared or ambiguous %s arguments", (name, args) => {
  expect(describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args)).toBeDefined();
});
it("derives the six writable preference choices from the immutable admission map", () => {
  expect(Object.keys(JIRA_NONSECRET_PREFERENCE_KINDS)).toHaveLength(6);
  const schema = declaration("jira.set-my-preference").descriptor.inputSchema;
  for (const [key, kind] of Object.entries(JIRA_NONSECRET_PREFERENCE_KINDS)) {
    const value = kind === "string" ? "" : kind === "boolean" ? false : 0;
    expect(describeCatalogSchemaMismatch(schema, { key, expectedActorKey: "actor", expectedValue: value, value })).toBeUndefined();
  }
});
it("does not allow an atomic private guarantee in creation receipts", () => {
  const schema = declaration("jira.create-filter").descriptor.resultSchema;
  expect(describeCatalogSchemaMismatch(schema, { outcome: "succeeded", filterId: "37", userKey: "actor", defaultSharingAtomic: false, observedShareScope: "PRIVATE" })).toBeUndefined();
  expect(describeCatalogSchemaMismatch(schema, { outcome: "succeeded", filterId: "37", defaultSharingAtomic: true })).toBeDefined();
});
it("makes absent native descriptions reviewable without collapsing explicit empty text", () => {
  const properties = JIRA_FILTER_READ_DEFINITIONS["jira.filter"].item.properties;
  if (typeof properties !== "object" || properties === null) throw new TypeError("Missing filter properties");
  expect(Reflect.get(properties, "description")).toEqual({ anyOf: [{ type: "string", maxLength: 32768 }, { type: "null" }] });
});
