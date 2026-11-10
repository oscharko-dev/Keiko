import { expect, it, vi } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_ACCESS_READ_DEFINITIONS,
  jiraAccessDeclarationForTool,
} from "./jiraAccessDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const GRANT = {
  id: "19",
  permission: "BROWSE_PROJECTS",
  holder: { type: "group", parameter: "Engineering" },
};
const PERMISSION = { id: "14", name: "Synthetic permissions", permissions: [GRANT] };
const LEVEL = { id: "31", name: "Synthetic level", description: "" };
const SECURITY = {
  id: "24",
  name: "Synthetic security",
  levels: [LEVEL],
  defaultSecurityLevelId: "31",
};
const NOTIFICATION = { id: "44", name: "Synthetic notification", eventsAvailable: false };
const PROJECT = { projectId: "7", projectKey: "SYN" };
it("admits all fifteen closed access declarations through the unchanged schema boundary", () => {
  const definitions = Object.entries(JIRA_ACCESS_READ_DEFINITIONS);
  expect(definitions).toHaveLength(15);
  for (const [name, definition] of definitions) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraAccessDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  [
    "jira.project-permission-scheme",
    { projectIdOrKey: "SYN" },
    { ...PROJECT, ...PERMISSION, id: "0" },
  ],
  ["jira.permission-schemes", {}, { items: [{ ...PERMISSION, id: "0" }], startAt: 0, total: 1 }],
  ["jira.permission-scheme", { schemeId: "0" }, { ...PERMISSION, id: "0" }],
  [
    "jira.permission-grants",
    { schemeId: "0" },
    { schemeId: "0", items: [GRANT], startAt: 0, total: 1 },
  ],
  ["jira.permission-grant", { schemeId: "0", permissionId: "19" }, { schemeId: "0", ...GRANT }],
  ["jira.project-permission-scheme", { projectIdOrKey: "SYN" }, { ...PROJECT, ...PERMISSION }],
  ["jira.project-issue-security-scheme", { projectIdOrKey: "7" }, { ...PROJECT, ...SECURITY }],
  [
    "jira.project-security-levels",
    { projectIdOrKey: "SYN", maxResults: 10 },
    { ...PROJECT, levelsScope: "accessible", items: [], startAt: 0, total: 0 },
  ],
  [
    "jira.project-workflow-scheme",
    { projectIdOrKey: "SYN" },
    {
      ...PROJECT,
      schemeId: "51",
      id: "51",
      draft: false,
      items: [{ issueTypeId: "4", originalWorkflow: "Prior workflow" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.project-priority-scheme",
    { projectIdOrKey: "SYN" },
    {
      ...PROJECT,
      id: "52",
      name: "Synthetic priorities",
      defaultScheme: false,
      defaultOptionId: "2",
      optionIds: [],
    },
  ],
  [
    "jira.permission-schemes",
    { includePermissions: true },
    { items: [PERMISSION], startAt: 0, total: 1 },
  ],
  ["jira.permission-scheme", { schemeId: "14" }, PERMISSION],
  [
    "jira.permission-grants",
    { schemeId: "14" },
    { schemeId: "14", items: [GRANT], startAt: 0, total: 1 },
  ],
  ["jira.permission-grant", { schemeId: "14", permissionId: "19" }, { schemeId: "14", ...GRANT }],
  ["jira.issue-security-schemes", {}, { items: [SECURITY], startAt: 0, total: 1 }],
  ["jira.issue-security-scheme", { schemeId: "24" }, SECURITY],
  ["jira.security-level", { levelId: "31" }, LEVEL],
  [
    "jira.notification-schemes",
    { includeEvents: true, maxResults: 50 },
    { eventsRequested: true, items: [NOTIFICATION], startAt: 0, isLast: true },
  ],
  [
    "jira.notification-scheme",
    { schemeId: "44" },
    { eventsRequested: false, items: [{ id: "44", name: "Synthetic notification" }] },
  ],
  [
    "jira.project-notification-scheme",
    { projectIdOrKey: "SYN", includeEvents: true },
    { eventsRequested: true, projectId: "7", projectKey: "SYN", items: [NOTIFICATION] },
  ],
] as const)(
  "declares %s through the existing provider without remote execution",
  (name, args, result) => {
    const declaration = jiraAccessDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing access declaration");
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
  ["jira.project-permission-scheme", { projectIdOrKey: "SYN", expand: "all" }],
  ["jira.project-issue-security-scheme", { projectIdOrKey: "SYN", maxResults: 10 }],
  ["jira.project-security-levels", { projectIdOrKey: "../SYN" }],
  ["jira.project-workflow-scheme", { projectIdOrKey: "SYN", returnDraftIfExists: true }],
  ["jira.project-priority-scheme", { projectIdOrKey: "SYN", projectId: "7" }],
  ["jira.permission-schemes", { expand: "all" }],
  ["jira.permission-scheme", { schemeId: "14", includePermissions: "true" }],
  ["jira.permission-grants", { schemeId: "14", maxResults: 101 }],
  ["jira.permission-grant", { schemeId: "14", permissionId: "../19" }],
  ["jira.issue-security-schemes", { startAt: -1 }],
  ["jira.issue-security-scheme", { schemeId: 24 }],
  ["jira.security-level", { levelId: "0" }],
  ["jira.notification-schemes", { maxResults: 51 }],
  ["jira.notification-scheme", { schemeId: "44", includeEvents: null }],
  ["jira.project-notification-scheme", { projectIdOrKey: "../SYN" }],
] as const)("refuses unreviewed %s selectors", (name, args) => {
  const declaration = jiraAccessDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing access declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("keeps deep native event provenance within the existing closed schema budget", () => {
  const declaration = jiraAccessDeclarationForTool("jira.notification-scheme");
  if (declaration === undefined) throw new TypeError("Missing notification declaration");
  const templates = Array.from({ length: 7 }, (_, index) => ({
    id: String(index + 60),
    name: "Synthetic ancestor",
  }));
  const event = {
    id: "50",
    templateEvents: templates,
    notifications: [
      {
        id: "81",
        notificationType: "User",
        recipientKind: "user",
        recipientKey: "synthetic",
        recipientName: "Synthetic User",
        recipientActive: false,
      },
      { id: "82", notificationType: "Group", recipientKind: "group", recipientName: "Engineering" },
      {
        id: "83",
        notificationType: "ProjectRole",
        recipientKind: "projectRole",
        recipientId: "4",
        recipientDescription: "",
      },
      {
        id: "84",
        notificationType: "UserCustomField",
        recipientKind: "field",
        recipientId: "customfield_101",
        recipientName: "Reviewer",
      },
      { id: "85", notificationType: "EmailAddress", emailAddress: "synthetic@example.invalid" },
    ],
  };
  const result = {
    outcome: "succeeded",
    eventsRequested: true,
    items: [{ id: "44", name: "Synthetic notification", eventsAvailable: true, events: [event] }],
  };
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, result),
  ).toBeUndefined();
  const tooDeep = {
    ...result,
    items: [
      { ...result.items[0], events: [{ ...event, templateEvents: [...templates, { id: "99" }] }] },
    ],
  };
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, tooDeep)).toBeDefined();
});
it.each([
  [
    "jira.project-security-levels",
    { ...PROJECT, levelsScope: "configured", items: [], startAt: 0, total: 0 },
  ],
  ["jira.project-workflow-scheme", { ...PROJECT, schemeId: "51", id: "51", draft: true }],
  [
    "jira.project-priority-scheme",
    { ...PROJECT, id: "52", name: "Synthetic priorities", defaultOptionId: 2 },
  ],
  [
    "jira.permission-grant",
    {
      ...GRANT,
      schemeId: "14",
      holder: { type: "group", emailAddress: "synthetic@example.invalid" },
    },
  ],
  ["jira.issue-security-scheme", { ...SECURITY, self: "https://synthetic.invalid/security" }],
  [
    "jira.notification-scheme",
    {
      eventsRequested: true,
      items: [
        {
          ...NOTIFICATION,
          eventsAvailable: true,
          events: [
            { id: "50", notifications: [{ id: "81", notificationType: "UnreviewedPluginType" }] },
          ],
        },
      ],
    },
  ],
  [
    "jira.notification-scheme",
    {
      eventsRequested: true,
      items: [
        {
          ...NOTIFICATION,
          eventsAvailable: true,
          events: [{ id: "50", templateEvent: { id: "51" } }],
        },
      ],
    },
  ],
  [
    "jira.notification-scheme",
    {
      eventsRequested: true,
      items: [
        {
          ...NOTIFICATION,
          eventsAvailable: true,
          events: [
            {
              id: "50",
              notifications: [{ id: "81", notificationType: "User", user: { key: "synthetic" } }],
            },
          ],
        },
      ],
    },
  ],
  [
    "jira.notification-scheme",
    {
      eventsRequested: true,
      items: [
        {
          ...NOTIFICATION,
          eventsAvailable: true,
          events: [
            {
              id: "50",
              notifications: [
                {
                  id: "81",
                  notificationType: "UserCustomField",
                  recipientKind: "field",
                  recipientId: "../other",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
] as const)("rejects unprojected %s result fields", (name, result) => {
  const declaration = jiraAccessDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing access declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
