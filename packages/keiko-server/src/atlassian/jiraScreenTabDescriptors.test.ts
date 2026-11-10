import { expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  JIRA_MANAGED_ACTION_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_SCREEN_TAB_WRITE_DEFINITIONS,
  jiraScreenTabDeclarationForTool,
} from "./jiraScreenTabDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

const SCREEN = { screenId: "7", expectedScreenName: "Synthetic screen" };
const TAB = { ...SCREEN, tabId: "9", expectedName: "Original" };
it("admits all three screen-tab schemas through the unchanged bounded schema compiler", () => {
  expect(Object.keys(JIRA_SCREEN_TAB_WRITE_DEFINITIONS)).toHaveLength(3);
  for (const [name, definition] of Object.entries(JIRA_SCREEN_TAB_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraScreenTabDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.create-screen-tab", { ...SCREEN, name: "Additional" }, "POST", "/screens/{screenId}/tabs"],
  [
    "jira.rename-screen-tab",
    { ...TAB, name: "Renamed" },
    "PUT",
    "/screens/{screenId}/tabs/{tabId}",
  ],
  [
    "jira.delete-screen-tab",
    { ...TAB, expectedFieldIds: ["summary", "customfield_10001"] },
    "DELETE",
    "/screens/{screenId}/tabs/{tabId}",
  ],
  [
    "jira.delete-screen-tab",
    { ...TAB, expectedFieldIds: [] },
    "DELETE",
    "/screens/{screenId}/tabs/{tabId}",
  ],
] as const)(
  "binds %s to one governed high-risk native effect and reviewed snapshot",
  (name, args, method, pathTemplate) => {
    const declaration = jiraScreenTabDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing screen-tab declaration");
    expect(declaration.risk).toBe("write");
    expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[JIRA_MANAGED_ACTION_TYPES[name]]).toBe("high");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        screenId: "7",
        tabId: "9",
      }),
    ).toBeUndefined();
    expect(jiraOperationForTool(name)?.definition).toMatchObject({
      kind: "native",
      method,
      apiRoot: "/rest/api/2",
      pathTemplate,
      effects: ["remote-read", "remote-write"],
    });
    const connection = vi.fn();
    const executeMutation = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name], executeMutation).tools()).toHaveLength(
      1,
    );
    expect(connection).not.toHaveBeenCalled();
    expect(executeMutation).not.toHaveBeenCalled();
  },
);
it.each([
  ["jira.create-screen-tab", { screenId: "7", name: "Additional" }],
  ["jira.create-screen-tab", { ...SCREEN, name: "" }],
  ["jira.create-screen-tab", { ...SCREEN, name: "Additional", tabId: "9" }],
  ["jira.rename-screen-tab", { ...SCREEN, tabId: "9", name: "Renamed" }],
  ["jira.rename-screen-tab", { ...TAB, name: "Renamed", method: "POST" }],
  ["jira.delete-screen-tab", TAB],
  ["jira.delete-screen-tab", { ...TAB, expectedFieldIds: ["summary", "summary"] }],
  ["jira.delete-screen-tab", { ...TAB, expectedFieldIds: ["../summary"] }],
  ["jira.delete-screen-tab", { ...TAB, expectedFieldIds: null }],
  ["jira.delete-screen-tab", { ...TAB, expectedFieldIds: [], force: true }],
] as const)("refuses incomplete or widened %s snapshots before dispatch", (name, args) => {
  const declaration = jiraScreenTabDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing screen-tab declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("allows the incomplete create receipt only as schema data, leaving success enforcement to the existing journal owner", () => {
  const declaration = jiraScreenTabDeclarationForTool("jira.create-screen-tab");
  if (declaration === undefined) throw new TypeError("Missing screen-tab declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded-unconfirmed",
      screenId: "7",
      guidance: "Inspect the screen without replaying creation.",
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      screenId: 7,
      tabId: "9",
    }),
  ).toBeDefined();
});
