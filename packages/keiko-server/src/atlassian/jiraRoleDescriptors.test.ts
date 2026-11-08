import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_ROLE_READ_DEFINITIONS, jiraRoleDeclarationForTool } from "./jiraRoleDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ACTOR = {
  name: "Synthetic user",
  id: "8",
  type: "atlassian-user-role-actor",
  displayName: "Synthetic",
};
const ROLE = { id: "7", name: "Synthetic role", description: "", actors: [ACTOR] };
const PROJECT = { projectId: "12", projectKey: "SYN" };
const PRIORITY = {
  id: "9",
  name: "Synthetic priorities",
  defaultScheme: false,
  defaultOptionId: "2",
  optionIds: [],
};
it("admits all seven closed role/priority descriptors through the existing boundary", () => {
  expect(Object.keys(JIRA_ROLE_READ_DEFINITIONS)).toHaveLength(7);
  for (const [name, definition] of Object.entries(JIRA_ROLE_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraRoleDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.roles", {}, { actorsScope: "role-configuration", items: [ROLE], startAt: 0, total: 1 }],
  ["jira.role", { roleId: "7" }, { actorsScope: "role-configuration", ...ROLE }],
  ["jira.role-default-actors", { roleId: "7" }, { roleId: "7", actorsScope: "role-defaults" }],
  [
    "jira.project-roles",
    { projectIdOrKey: "SYN" },
    { ...PROJECT, items: [{ name: "Synthetic role" }], startAt: 0, total: 1 },
  ],
  [
    "jira.project-role",
    { projectIdOrKey: "SYN", roleId: "7" },
    { ...PROJECT, ...ROLE, actorsScope: "project-membership" },
  ],
  ["jira.priority-schemes", { maxResults: 25 }, { items: [PRIORITY], startAt: 0, total: 1 }],
  ["jira.priority-scheme", { schemeId: "9" }, PRIORITY],
] as const)(
  "declares %s without widening role membership or project authority",
  (name, args, result) => {
    const declaration = jiraRoleDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing role declaration");
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
  ["jira.roles", { expand: "actors" }],
  ["jira.role", { roleId: 7 }],
  ["jira.role-default-actors", { roleId: "7", actorsScope: "project-membership" }],
  ["jira.project-roles", { projectIdOrKey: "../SYN" }],
  ["jira.project-role", { projectIdOrKey: "SYN", roleId: "0" }],
  ["jira.priority-schemes", { maxResults: 101 }],
  ["jira.priority-scheme", { schemeId: "9", projectIdOrKey: "SYN" }],
] as const)("refuses unreviewed %s selectors", (name, args) => {
  const declaration = jiraRoleDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing role declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.role", { ...ROLE, actorsScope: "effective-permissions" }],
  [
    "jira.role-default-actors",
    { roleId: "7", actorsScope: "project-membership", items: [], startAt: 0, total: 0 },
  ],
  [
    "jira.project-roles",
    { ...PROJECT, items: [{ name: "Synthetic role", roleId: "7" }], startAt: 0, total: 1 },
  ],
  [
    "jira.project-role",
    {
      ...PROJECT,
      ...ROLE,
      actorsScope: "project-membership",
      actors: [{ ...ACTOR, avatarUrl: "https://synthetic.invalid/avatar" }],
    },
  ],
  ["jira.priority-scheme", { ...PRIORITY, projectKeys: ["SYN"] }],
] as const)("rejects unprojected %s evidence", (name, result) => {
  const declaration = jiraRoleDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing role declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it.each(["jira.role", "jira.project-role"])(
  "preserves a closed optional %s review snapshot without making omitted description null",
  (name) => {
    const declaration = jiraRoleDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing role declaration");
    const result = {
      outcome: "succeeded",
      ...ROLE,
      ...(name === "jira.project-role" ? PROJECT : {}),
      actorsScope: name === "jira.project-role" ? "project-membership" : "role-configuration",
    };
    for (const description of [null, "", "Observed"])
      expect(
        describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
          ...result,
          reviewSnapshot: { id: "7", name: "Synthetic role", description },
        }),
      ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, result),
    ).toBeUndefined();
    for (const reviewSnapshot of [
      { id: "7", name: "Synthetic role" },
      { id: "7", name: "Synthetic role", description: null, inferred: true },
    ])
      expect(
        describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
          ...result,
          reviewSnapshot,
        }),
      ).toBeDefined();
  },
);
