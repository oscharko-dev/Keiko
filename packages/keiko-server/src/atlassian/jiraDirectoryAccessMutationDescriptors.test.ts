import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { DIRECTORY_ACCESS_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-directory-access-fixture.js";
import { JIRA_DIRECTORY_ACCESS_WRITE_DEFINITIONS, jiraDirectoryAccessMutationDeclarationForTool as declaration } from "./jiraDirectoryAccessMutationDescriptors.js";

it("declares exactly six closed directory-administration operations", () => {
  expect(Object.keys(JIRA_DIRECTORY_ACCESS_WRITE_DEFINITIONS)).toEqual(CASES.map(({ name }) => name));
  for (const value of Object.values(JIRA_DIRECTORY_ACCESS_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(value.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(value.result)).toBe(true);
    expect(value.description).toContain("issue-tracker.admin");
  }
  expect(declaration("jira.directory-http")).toBeUndefined();
});
it.each(CASES)("admits reviewed $name arguments and preserves its confirmation boundary", (selected) => {
  const tool = declaration(selected.name);
  if (tool === undefined) throw new TypeError("Missing directory declaration");
  expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, selected.args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...selected.receipt })).toBeUndefined();
  const mismatch = describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded", ...selected.receipt });
  expect(mismatch === undefined).toBe(selected.confirmed);
  for (const widening of [{ ifMatch: '"model-version"' }, { url: "https://foreign.example" }, { headers: {} }])
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...selected.args, ...widening })).toBeDefined();
});
it("keeps native set emptiness and ordered duplicate columns representable", () => {
  const roles = declaration(CASES[0].name); const columns = declaration(CASES[4].name);
  if (roles === undefined || columns === undefined) throw new TypeError("Missing native declarations");
  expect(describeCatalogSchemaMismatch(columns.descriptor.inputSchema, CASES[4].args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(roles.descriptor.inputSchema, { ...CASES[0].args, role: {
    expected: { key: "jira-software", groups: [], defaultGroups: [] }, value: { key: "jira-software", groups: [], defaultGroups: [] },
  } })).toBeUndefined();
});
