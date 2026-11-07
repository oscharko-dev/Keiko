import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_JQL_READ_DEFINITIONS, jiraJqlDeclarationForTool } from "./jiraJqlDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

it("admits the two fixed JQL metadata schemas through the unchanged compiler", () => {
  expect(Object.keys(JIRA_JQL_READ_DEFINITIONS)).toHaveLength(2);
  for (const [name, definition] of Object.entries(JIRA_JQL_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraJqlDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.jql-autocomplete", { category: "fields" }, { category: "fields", metadataScope: "visible-fields", items: [{ value: "summary", auto: false, operators: ["~"], types: ["java.lang.String"] }], startAt: 0, total: 1 }],
  ["jira.jql-autocomplete", { category: "reserved-words" }, { category: "reserved-words", metadataScope: "reserved-words", items: [{ value: "and" }], startAt: 0, total: 1 }],
  ["jira.jql-suggestions", { fieldName: "status", predicateName: "from", predicateValue: "" }, { category: "suggestions", metadataScope: "native-suggestions", fieldName: "status", fieldValue: "", predicateName: "from", predicateValue: "", items: [{ value: "Open" }], startAt: 0, total: 1 }],
] as const)("declares %s as scoped suggestions without executing a query", (name, args, result) => {
  const declaration = jiraJqlDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing JQL declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.jql-autocomplete", { category: "all" }],
  ["jira.jql-autocomplete", { category: "fields", jql: "project=SYN" }],
  ["jira.jql-suggestions", { fieldName: "status", predicateValue: "Open" }],
  ["jira.jql-suggestions", { fieldName: "status", predicateName: "after" }],
  ["jira.jql-suggestions", { fieldName: "", maxResults: 101 }],
] as const)("refuses unreviewed %s query inputs", (name, args) => {
  const declaration = jiraJqlDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing JQL declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.jql-autocomplete", { category: "fields", metadataScope: "validated-query", items: [], startAt: 0, total: 0 }],
  ["jira.jql-autocomplete", { category: "fields", metadataScope: "visible-fields", items: [{ value: "summary", auto: "true" }], startAt: 0, total: 1 }],
  ["jira.jql-suggestions", { category: "suggestions", metadataScope: "native-suggestions", fieldName: "status", fieldValue: "", items: [{ value: "Open", displayName: "<b>Open</b>" }], startAt: 0, total: 1 }],
] as const)("rejects unsupported %s result claims", (name, result) => {
  const declaration = jiraJqlDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing JQL declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
