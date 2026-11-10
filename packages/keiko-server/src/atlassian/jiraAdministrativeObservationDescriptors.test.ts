import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS,
  jiraAdministrativeObservationDeclarationForTool as declaration,
} from "./jiraAdministrativeObservationDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits both bounded administrative observation schemas without opening a connection", () => {
  for (const name of ["jira.permission-scheme-attribute", "jira.email-template-types"] as const) {
    const definition = JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS[name];
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    const connection = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
  }
});
it.each([
  [
    "jira.permission-scheme-attribute",
    { schemeId: "37", attributeKey: "review" },
    {
      schemeId: "37",
      attributeKey: "review",
      valueState: "observed",
      textValue: "",
      attributeScope: "permission-scheme-configuration",
    },
  ],
  [
    "jira.permission-scheme-attribute",
    { schemeId: "37", attributeKey: "review" },
    {
      schemeId: "37",
      attributeKey: "review",
      valueState: "unknown",
      attributeScope: "permission-scheme-configuration",
    },
  ],
  [
    "jira.email-template-types",
    { maxResults: 1 },
    {
      items: [{ id: "1", eventName: "Issue created", active: false, html: true, text: false }],
      startAt: 0,
      total: 1,
      templateScope: "notification-type-metadata",
    },
  ],
  [
    "jira.email-template-types",
    {},
    { items: [], startAt: 0, total: 0, templateScope: "notification-type-metadata" },
  ],
] as const)("admits truthful %s metadata without permission inference", (name, args, result) => {
  const tool = declaration(name);
  if (tool === undefined) throw new TypeError("Missing administrative observation");
  expect(tool.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeUndefined();
});
it.each([
  ["jira.permission-scheme-attribute", { attributeKey: "review" }],
  ["jira.permission-scheme-attribute", { schemeId: "37", attributeKey: "review", value: "true" }],
  ["jira.email-template-types", { sendEmail: true }],
  ["jira.email-template-types", { export: true }],
  ["jira.email-template-types", { maxResults: 101 }],
] as const)("refuses unsupported %s parameters and effects", (name, args) => {
  const tool = declaration(name);
  if (tool === undefined) throw new TypeError("Missing administrative observation");
  expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.permission-scheme-attribute", { valueState: "defaulted" }],
  ["jira.permission-scheme-attribute", { textValue: false }],
  ["jira.email-template-types", { userEmailAddress: "not-returned@example.invalid" }],
  ["jira.email-template-types", { items: [{ id: 1 }] }],
  ["jira.email-template-types", { items: [{ id: "1", active: "false" }] }],
] as const)("refuses leaked or invented %s result fields", (name, result) => {
  const tool = declaration(name);
  if (tool === undefined) throw new TypeError("Missing administrative observation");
  expect(
    describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it.each([
  [
    "jira.permission-scheme-attribute",
    "/permissionscheme/{permissionSchemeId}/attribute/{attributeKey}",
  ],
  ["jira.email-template-types", "/email-templates/types"],
] as const)("binds %s to the exact native read path", (name, pathTemplate) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    kind: "native",
    method: "GET",
    apiRoot: "/rest/api/2",
    pathTemplate,
    effects: ["remote-read"],
  });
});
