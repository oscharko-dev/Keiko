import { expect, it, vi } from "vitest";
import { JIRA_FIELD_ID_PATTERN } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS,
  jiraScopedDirectoryDeclarationForTool,
} from "./jiraScopedDirectoryDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const USER = { key: "synthetic-key", name: "Synthetic", active: false };
it("admits all seven scoped directory/field declarations through unchanged schema guards", () => {
  expect(Object.keys(JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS)).toHaveLength(7);
  for (const [name, definition] of Object.entries(JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraScopedDirectoryDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  [
    "jira.multi-project-assignable-users",
    { projectKeys: ["SYN"] },
    { items: [USER], searchLimit: 100 },
  ],
  [
    "jira.permission-users",
    { permissions: ["EDIT_ISSUES"], issueKey: "SYN-1", startAt: 1, maxResults: 1 },
    { items: [USER], searchLimit: 100, startAt: 1, nextStartAt: 2 },
  ],
  [
    "jira.browse-permission-users",
    { projectKey: "SYN", query: "Synthetic" },
    { items: [USER], searchLimit: 100 },
  ],
  [
    "jira.group-user-picker",
    { fieldId: "customfield_123", projectId: "12" },
    { users: [USER], usersTotal: 2, groups: [], groupsTotal: 0 },
  ],
  [
    "jira.project-picker",
    { allowEmptyQuery: true },
    { items: [{ id: "12", key: "SYN", name: "Synthetic" }] },
  ],
  [
    "jira.fields",
    { maxResults: 1 },
    {
      items: [
        {
          id: "customfield_123",
          name: "Synthetic",
          custom: true,
          searchable: false,
          schema: { type: "string", customId: "123" },
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.custom-field-option",
    { optionId: "42" },
    { id: "42", value: "", disabled: false, childrenIds: [] },
  ],
] as const)(
  "declares %s without inventing authority or native continuation",
  (name, args, result) => {
    const declaration = jiraScopedDirectoryDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing scoped-directory declaration");
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
  ["jira.multi-project-assignable-users", { projectKeys: [] }],
  ["jira.multi-project-assignable-users", { projectKeys: ["SYN", "SYN"] }],
  ["jira.multi-project-assignable-users", { projectKeys: ["SYN"], startAt: 1 }],
  ["jira.permission-users", { permissions: ["EDIT_ISSUES"] }],
  ["jira.permission-users", { permissions: ["EDIT_ISSUES"], projectKey: "SYN", issueKey: "SYN-1" }],
  ["jira.browse-permission-users", { projectKey: "SYN", query: "" }],
  ["jira.group-user-picker", { projectId: ["12"] }],
  ["jira.group-user-picker", { showAvatar: true }],
  ["jira.project-picker", { startAt: 1 }],
  ["jira.fields", { required: true }],
  ["jira.custom-field-option", { optionId: 42 }],
] as const)("refuses unreviewed %s selectors", (name, args) => {
  const declaration = jiraScopedDirectoryDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing scoped-directory declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.multi-project-assignable-users", { items: [USER], searchLimit: 100, nextStartAt: 1 }],
  ["jira.browse-permission-users", { items: [USER], searchLimit: 100, total: 1 }],
  ["jira.group-user-picker", { users: [USER], groups: [], total: 1 }],
  ["jira.group-user-picker", { groups: [{ name: "Synthetic", html: "Synthetic" }] }],
  [
    "jira.project-picker",
    {
      items: [
        { id: "12", key: "SYN", name: "Synthetic", avatar: "https://synthetic.invalid/avatar" },
      ],
    },
  ],
  [
    "jira.fields",
    { items: [{ id: "summary", name: "Summary", required: true }], startAt: 0, total: 1 },
  ],
  ["jira.custom-field-option", { id: "42", value: "Synthetic", childrenIds: [12] }],
] as const)("refuses unprojected %s evidence", (name, result) => {
  const declaration = jiraScopedDirectoryDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing scoped-directory declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it.each([
  "summary",
  "customfield_1",
  "customfield_1234567890123456",
  "customfield123",
  "a1",
  "",
  "_summary",
  "customfield_",
  "customfield_12345678901234567",
  "customfield_1x",
  "field/name",
])("keeps the catalog field-ID grammar aligned with existing field admission: %s", (fieldId) => {
  const declaration = jiraScopedDirectoryDeclarationForTool("jira.group-user-picker");
  if (declaration === undefined) throw new TypeError("Missing picker declaration");
  const admitted =
    describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, { fieldId }) === undefined;
  expect(admitted).toBe(fieldId.length <= 64 && new RegExp(JIRA_FIELD_ID_PATTERN).test(fieldId));
});
