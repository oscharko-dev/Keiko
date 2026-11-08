import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS,
  jiraAccountDiagnosticDeclarationForTool,
} from "./jiraAccountDiagnosticDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("declares four bounded account observations without creating a connection", () => {
  expect(Object.keys(JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS)).toHaveLength(4);
  for (const name of [
    "jira.password-policy", "jira.duplicate-user-count", "jira.duplicate-users", "jira.search-error",
  ] as const) {
    const definition = JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS[name];
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    const connection = vi.fn();
    const declaration = createJiraProviderForCatalog(connection, [name]).tools();
    expect(declaration).toHaveLength(1);
    expect(declaration[0]).toMatchObject({ name, risk: "read" });
    expect(connection).not.toHaveBeenCalled();
  }
});

it.each([
  ["jira.password-policy", {}, { items: [], startAt: 0, total: 0, policyScope: "requirements-only", hasOldPassword: false }],
  ["jira.password-policy", { hasOldPassword: true, startAt: 1, maxResults: 1 }, { items: [{ requirement: "Use at least eight characters." }], startAt: 1, total: 3, nextStartAt: 2, policyScope: "requirements-only", hasOldPassword: true }],
  ["jira.password-policy", { startAt: 999, maxResults: 1 }, { items: [{ requirement: "Use a distinct password." }], startAt: 999, total: 1000, policyScope: "requirements-only", hasOldPassword: false }],
  ["jira.duplicate-user-count", {}, { count: 0, observationScope: "cached-duplicate-accounts" }],
  ["jira.duplicate-users", { maxResults: 1 }, { items: [{ username: "sample", directories: [{ directoryId: "9223372036854775807", userActive: false }, { directoryId: "2", directoryName: "Local directory" }] }], startAt: 0, total: 1, observationScope: "cached-duplicate-accounts" }],
  ["jira.search-error", {}, { scope: "current-user-http-context", errorPresent: false }],
  ["jira.search-error", {}, { scope: "current-user-http-context", errorPresent: true, message: "The query could not be evaluated." }],
] as const)("admits truthful %s observations and preserves false and zero", (name, args, result) => {
  const declaration = jiraAccountDiagnosticDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing account diagnostic declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
});

it.each([
  ["jira.password-policy", { password: "never-accepted" }],
  ["jira.password-policy", { hasOldPassword: "false" }],
  ["jira.password-policy", { startAt: -1 }],
  ["jira.duplicate-user-count", { flush: true }],
  ["jira.duplicate-users", { flush: false }],
  ["jira.duplicate-users", { username: "sample" }],
  ["jira.search-error", { jql: "project = SAMPLE" }],
  ["jira.search-error", { sessionId: "foreign" }],
] as const)("refuses effects and unsupported context in %s", (name, args) => {
  const declaration = jiraAccountDiagnosticDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing account diagnostic declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});

it.each([
  ["jira.password-policy", { items: [{ requirement: "" }] }],
  ["jira.password-policy", { passwordAccepted: true }],
  ["jira.password-policy", { items: Array.from({ length: 101 }, () => ({ requirement: "Use a distinct password." })) }],
  ["jira.password-policy", { total: 1001 }],
  ["jira.duplicate-user-count", { count: -1 }],
  ["jira.duplicate-user-count", { count: Number.MAX_SAFE_INTEGER + 1 }],
  ["jira.duplicate-user-count", { observationScope: "all-accounts" }],
  ["jira.duplicate-users", { items: [{ username: "sample", directories: [{ directoryId: 7 }] }] }],
  ["jira.duplicate-users", { items: [{ username: "sample", directories: [{ directoryId: "7", userActive: "false" }] }] }],
  ["jira.duplicate-users", { total: 1001 }],
  ["jira.search-error", { scope: "browser-session", errorPresent: false }],
  ["jira.search-error", { message: "" }],
] as const)("refuses invented or malformed %s result facts", (name, result) => {
  const declaration = jiraAccountDiagnosticDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing account diagnostic declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});

it.each([
  ["jira.password-policy", "/password/policy"],
  ["jira.duplicate-user-count", "/user/duplicated/count"],
  ["jira.duplicate-users", "/user/duplicated/list"],
  ["jira.search-error", "/search/error/lookup"],
] as const)("binds %s to its published native read identity", (name, pathTemplate) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    kind: "native", method: "GET", apiRoot: "/rest/api/2", pathTemplate, effects: ["remote-read"],
  });
});
