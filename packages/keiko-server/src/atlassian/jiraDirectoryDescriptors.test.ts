import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraDirectoryDeclarationForTool } from "./jiraDirectoryDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const USER = { key: "user-key", name: "Synthetic User", displayName: "Synthetic", active: false };
it.each([
  ["jira.user", { username: "Synthetic User" }, USER],
  ["jira.users", { query: "syn", maxResults: 25 }, { items: [USER], startAt: 0, searchLimit: 100 }],
  ["jira.user-directory", { cursor: "-9223372036854775808" }, { items: [USER], isLast: false, nextCursor: "42" }],
  ["jira.user-picker", { query: "syn" }, { items: [USER], total: 1 }],
  ["jira.group-members", { groupName: "Engineering" }, { groupName: "Engineering", items: [USER], startAt: 0, total: 1 }],
  ["jira.groups", {}, { items: [{ name: "Engineering" }] }],
  ["jira.application-roles", {}, { items: [{ key: "jira-software", remainingSeats: -1 }], startAt: 0, total: 1 }],
  ["jira.application-role", { applicationRoleKey: "jira-software" }, { key: "jira-software", defined: false, groups: [], numberOfSeats: -1 }],
] as const)("declares %s with native paging and optional metadata without inventing facts", (name, args, result) => {
  const declaration = jiraDirectoryDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing directory declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.user", {}],
  ["jira.user", { username: "one", userKey: "two" }],
  ["jira.users", { startAt: 100 }],
  ["jira.user-directory", { cursor: 42 }],
  ["jira.user-picker", { startAt: 1 }],
  ["jira.group-members", { groupName: "Engineering", maxResults: 51 }],
  ["jira.groups", { startAt: 1 }],
  ["jira.application-role", { applicationRoleKey: "../other" }],
] as const)("refuses unsupported %s selectors", (name, args) => {
  const declaration = jiraDirectoryDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing directory declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.user", { ...USER, emailAddress: "synthetic@example.invalid" }],
  ["jira.user-picker", { items: [USER], html: "<b>Synthetic</b>" }],
  ["jira.user-directory", { items: [USER], isLast: true, total: 1 }],
  ["jira.groups", { items: [{ name: "Engineering" }], nextStartAt: 1 }],
  ["jira.application-role", { key: "jira-software", numberOfSeats: 2147483648 }],
] as const)("keeps %s results closed to documented native facts", (name, result) => {
  const declaration = jiraDirectoryDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing directory declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
