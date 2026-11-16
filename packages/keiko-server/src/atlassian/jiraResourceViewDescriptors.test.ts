import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_RESOURCE_VIEW_READ_DEFINITIONS,
  jiraResourceViewDeclarationForTool,
} from "./jiraResourceViewDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits all seven resource and column schemas without changing the schema guard", () => {
  expect(Object.keys(JIRA_RESOURCE_VIEW_READ_DEFINITIONS)).toHaveLength(7);
  for (const [name, definition] of Object.entries(JIRA_RESOURCE_VIEW_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraResourceViewDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  [
    "jira.global-version-page",
    { projectIds: ["10000"], query: "" },
    {
      items: [{ versionId: "1", name: "Release", projectId: "10000", released: false }],
      startAt: 0,
    },
  ],
  [
    "jira.global-version-page",
    {},
    { items: [{ versionId: "1", name: "Release" }], startAt: 0, total: 1 },
  ],
  [
    "jira.component-page",
    { startAt: 0 },
    {
      items: [{ id: "1", name: "Component", project: "SYN", projectId: "10000", archived: false }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.link-type",
    { linkTypeId: "1" },
    { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  ],
  [
    "jira.accessibility-settings",
    {},
    {
      settingsScope: "connected-user",
      items: [{ key: "keyboard", enabled: false }, { key: "unknown" }],
      startAt: 0,
      total: 2,
    },
  ],
  [
    "jira.system-columns",
    {},
    {
      layoutScope: "system",
      columnsAvailable: true,
      items: [{ value: "summary", label: "" }, { value: "summary" }],
      startAt: 0,
      total: 2,
    },
  ],
  [
    "jira.user-columns",
    { username: "synthetic user" },
    {
      layoutScope: "named-user",
      selectedUsername: "synthetic user",
      columnsAvailable: true,
      items: [],
      startAt: 0,
      total: 0,
    },
  ],
  [
    "jira.filter-columns",
    { filterId: "42" },
    {
      layoutScope: "filter",
      selectedFilterId: "42",
      columnsAvailable: false,
      columnConfig: "NONE",
    },
  ],
  [
    "jira.filter-columns",
    { filterId: "42" },
    {
      layoutScope: "filter",
      selectedFilterId: "42",
      columnsAvailable: true,
      items: [{ id: "summary", position: -1, columnHeadingKey: "" }],
      startAt: 0,
      total: 1,
      columnConfig: "FILTER",
    },
  ],
] as const)(
  "declares %s with truthful native context and optional metadata",
  (name, args, result) => {
    const declaration = jiraResourceViewDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing resource-view declaration");
    expect(declaration.risk).toBe("read");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...result,
      }),
    ).toBeUndefined();
    const connection = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
  },
);
it.each([
  ["jira.global-version-page", { projectIds: [] }],
  ["jira.component-page", { projectIds: ["1", "1"] }],
  ["jira.component-page", { projectIds: [1] }],
  ["jira.link-type", { linkTypeId: "01" }],
  ["jira.accessibility-settings", { username: "other" }],
  ["jira.system-columns", { columns: ["summary"] }],
  ["jira.user-columns", { username: "" }],
  ["jira.filter-columns", { filterId: "42", expand: "all" }],
] as const)("refuses unsupported %s inputs", (name, args) => {
  const declaration = jiraResourceViewDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing resource-view declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.component-page", { items: [{ id: "1", name: "Missing project" }], startAt: 0 }],
  [
    "jira.global-version-page",
    { items: [{ versionId: "1", name: "Release", projectId: 10000 }], startAt: 0 },
  ],
  [
    "jira.accessibility-settings",
    { settingsScope: "effective-permissions", items: [], startAt: 0, total: 0 },
  ],
  [
    "jira.filter-columns",
    {
      layoutScope: "filter",
      selectedFilterId: "42",
      columnsAvailable: true,
      items: [{ value: "summary", id: "summary" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.filter-columns",
    { layoutScope: "filter", selectedFilterId: "42", columnConfig: "INHERITED" },
  ],
] as const)("refuses unsupported %s output facts", (name, result) => {
  const declaration = jiraResourceViewDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing resource-view declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it.each([
  ["jira.global-version-page", "/version"],
  ["jira.component-page", "/component/page"],
  ["jira.link-type", "/issueLinkType/{issueLinkTypeId}"],
  ["jira.accessibility-settings", "/user/a11y/personal-settings"],
  ["jira.system-columns", "/settings/columns"],
  ["jira.user-columns", "/user/columns"],
  ["jira.filter-columns", "/filter/{id}/columns"],
] as const)("binds %s to its fixed GET path", (name, path) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    kind: "native",
    method: "GET",
    apiRoot: "/rest/api/2",
    pathTemplate: path,
    effects: ["remote-read"],
  });
});
