import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { VERSION_LINK_MUTATION_CASES as CASES } from "../../../../tests/support/jira-version-link-mutation-fixture.js";
import { JIRA_VERSION_LINK_WRITE_DEFINITIONS, jiraVersionLinkMutationDeclarationForTool as declaration } from "./jiraVersionLinkMutationDescriptors.js";

it("declares exactly four bounded native version-link mutation identities", () => {
  expect(Object.keys(JIRA_VERSION_LINK_WRITE_DEFINITIONS)).toEqual(CASES.map(({ tool }) => tool));
  for (const [name, definition] of Object.entries(JIRA_VERSION_LINK_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(declaration(name)?.risk).toBe("write");
  }
  expect(declaration("jira.version-url-write")).toBeUndefined();
});
it.each(CASES)("admits $tool's exact reviewed source and independent receipt", (selected) => {
  const operation = declaration(selected.tool);
  if (operation === undefined) throw new TypeError("Missing fixed version-link declaration");
  expect(describeCatalogSchemaMismatch(operation.descriptor.inputSchema, selected.args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(operation.descriptor.resultSchema, { outcome: "succeeded", ...selected.expectedReceipt })).toBeUndefined();
});
it.each([
  { tool: CASES[0].tool, args: { ...CASES[0].args, url: "https://other.invalid" } },
  { tool: CASES[1].tool, args: { ...CASES[1].args, globalId: "a/b" } },
  { tool: CASES[1].tool, args: { ...CASES[1].args, globalId: "%25" } },
  { tool: CASES[1].tool, args: { ...CASES[1].args, globalId: "." } },
  { tool: CASES[2].tool, args: { ...CASES[2].args, expectedLinks: [{ globalId: "selected" }] } },
  { tool: CASES[2].tool, args: { ...CASES[2].args, expectedVersionSnapshot: { name: "Release" } } },
  { tool: CASES[3].tool, args: { ...CASES[3].args, confirmAll: false } },
])("refuses wider or incomplete $tool arguments before native admission", ({ tool, args }) => {
  const operation = declaration(tool);
  if (operation === undefined) throw new TypeError("Missing version-link declaration");
  expect(describeCatalogSchemaMismatch(operation.descriptor.inputSchema, args)).toBeDefined();
});
it("states upsert, generated-ID exclusion and native proof boundaries explicitly", () => {
  expect(JIRA_VERSION_LINK_WRITE_DEFINITIONS[CASES[0].tool].description).toContain("generated");
  expect(JIRA_VERSION_LINK_WRITE_DEFINITIONS[CASES[1].tool].description).toContain("raw JSON");
  expect(JIRA_VERSION_LINK_WRITE_DEFINITIONS[CASES[2].tool].description).toContain("404");
  expect(JIRA_VERSION_LINK_WRITE_DEFINITIONS[CASES[3].tool].description).toContain("confirmAll:true");
});
