import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraAccessDeclarationForTool } from "./jiraAccessDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const GRANT = { id: "19", permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Engineering" } };
const PERMISSION = { id: "14", name: "Synthetic permissions", permissions: [GRANT] };
const LEVEL = { id: "31", name: "Synthetic level", description: "" };
const SECURITY = { id: "24", name: "Synthetic security", levels: [LEVEL], defaultSecurityLevelId: "31" };
const NOTIFICATION = { id: "44", name: "Synthetic notification", eventsAvailable: false };
it.each([
  ["jira.permission-schemes", { includePermissions: true }, { items: [PERMISSION], startAt: 0, total: 1 }],
  ["jira.permission-scheme", { schemeId: "14" }, PERMISSION],
  ["jira.permission-grants", { schemeId: "14" }, { schemeId: "14", items: [GRANT], startAt: 0, total: 1 }],
  ["jira.permission-grant", { schemeId: "14", permissionId: "19" }, { schemeId: "14", ...GRANT }],
  ["jira.issue-security-schemes", {}, { items: [SECURITY], startAt: 0, total: 1 }],
  ["jira.issue-security-scheme", { schemeId: "24" }, SECURITY],
  ["jira.security-level", { levelId: "31" }, LEVEL],
  ["jira.notification-schemes", { includeEvents: true, maxResults: 50 }, { eventsRequested: true, items: [NOTIFICATION], startAt: 0, isLast: true }],
  ["jira.notification-scheme", { schemeId: "44" }, { eventsRequested: false, items: [{ id: "44", name: "Synthetic notification" }] }],
  ["jira.project-notification-scheme", { projectIdOrKey: "SYN", includeEvents: true }, { eventsRequested: true, projectId: "7", projectKey: "SYN", items: [NOTIFICATION] }],
] as const)("declares %s through the existing provider without remote execution", (name, args, result) => {
  const declaration = jiraAccessDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing access declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
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
  const templates = Array.from({ length: 7 }, (_, index) => ({ id: String(index + 60), name: "Synthetic ancestor" }));
  const event = {
    id: "50", templateEvents: templates,
    notifications: [
      { id: "81", notificationType: "User", user: { key: "synthetic", name: "Synthetic User", active: false } },
      { id: "82", notificationType: "Group", group: { name: "Engineering" } },
      { id: "83", notificationType: "ProjectRole", projectRole: { id: "4", description: "" } },
      { id: "84", notificationType: "UserCustomField", field: { id: "customfield_101", name: "Reviewer" } },
      { id: "85", notificationType: "EmailAddress", emailAddress: "synthetic@example.invalid" },
    ],
  };
  const result = { outcome: "succeeded", eventsRequested: true, items: [{ id: "44", name: "Synthetic notification", eventsAvailable: true, events: [event] }] };
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, result)).toBeUndefined();
  const tooDeep = { ...result, items: [{ ...result.items[0], events: [{ ...event, templateEvents: [...templates, { id: "99" }] }] }] };
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, tooDeep)).toBeDefined();
});
it.each([
  ["jira.permission-grant", { ...GRANT, schemeId: "14", holder: { type: "group", emailAddress: "synthetic@example.invalid" } }],
  ["jira.issue-security-scheme", { ...SECURITY, self: "https://synthetic.invalid/security" }],
  ["jira.notification-scheme", { eventsRequested: true, items: [{ ...NOTIFICATION, eventsAvailable: true, events: [{ id: "50", notifications: [{ id: "81", notificationType: "UnreviewedPluginType" }] }] }] }],
  ["jira.notification-scheme", { eventsRequested: true, items: [{ ...NOTIFICATION, eventsAvailable: true, events: [{ id: "50", templateEvent: { id: "51" } }] }] }],
] as const)("rejects unprojected %s result fields", (name, result) => {
  const declaration = jiraAccessDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing access declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
