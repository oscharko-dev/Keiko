import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { PERMISSION_SCHEME_MUTATION_CASES as CASES } from "../../../../tests/support/jira-permission-scheme-mutation-fixture.js";
import { JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS, jiraPermissionSchemeMutationDeclarationForTool as declaration } from "./jiraPermissionSchemeMutationDescriptors.js";

it("declares exactly six bounded permission-scheme mutations without a generic admin proxy", () => {
  expect(Object.keys(JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS)).toEqual(CASES.map(({ tool }) => tool));
  for (const definition of Object.values(JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result)).toBe(true);
    expect(definition.description).toContain("issue-tracker.admin");
  }
  expect(declaration("jira.permission-scheme-request")).toBeUndefined();
});
it.each(CASES)("admits $tool's explicit review and independent receipt facts", ({ tool, args, receipt }) => {
  const selected = declaration(tool);
  if (selected === undefined) throw new TypeError("Missing permission-scheme declaration");
  expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(selected.descriptor.resultSchema, { outcome: "succeeded", ...receipt })).toBeUndefined();
});
it.each([
  { tool: CASES[0].tool, args: { expectedActorKey: "actor", name: "Plan", description: "" } },
  { tool: CASES[1].tool, args: { expectedActorKey: "actor", expectedScheme: CASES[1].args.expectedScheme } },
  { tool: CASES[1].tool, args: { ...CASES[1].args, permissions: null } },
  { tool: CASES[2].tool, args: { ...CASES[2].args, confirmUnverifiedDeletion: false } },
  { tool: CASES[3].tool, args: { ...CASES[3].args, grant: { permission: "ADD_COMMENTS", holder: { type: "group" } } } },
  { tool: CASES[3].tool, args: { ...CASES[3].args, grant: { permission: "ADD_COMMENTS", holder: { type: "anyone", parameter: "ignored" } } } },
  { tool: CASES[4].tool, args: { ...CASES[4].args, permissionId: 21 } },
  { tool: CASES[5].tool, args: { ...CASES[5].args, expectedValue: null } },
  { tool: CASES[5].tool, args: { ...CASES[5].args, enabled: "false" } },
  { tool: CASES[5].tool, args: { ...CASES[5].args, headers: { "content-type": "text/plain" } } },
])("refuses wider or incomplete $tool input", ({ tool, args }) => {
  const selected = declaration(tool);
  if (selected === undefined) throw new TypeError("Missing permission-scheme declaration");
  expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeDefined();
});
it("distinguishes omitted permissions from explicit empty replacement and native false text", () => {
  const update = declaration(CASES[1].tool);
  const attribute = declaration(CASES[5].tool);
  if (update === undefined || attribute === undefined) throw new TypeError("Missing scheme declarations");
  expect(describeCatalogSchemaMismatch(update.descriptor.inputSchema, { ...CASES[1].args, permissions: [] })).toBeUndefined();
  expect(JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS[CASES[1].tool].description).toContain("ALL grants");
  expect(JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS[CASES[5].tool].description).toContain("text/plain");
  expect(describeCatalogSchemaMismatch(attribute.descriptor.resultSchema, { outcome: "unknown", ...CASES[5].receipt })).toBeUndefined();
});
