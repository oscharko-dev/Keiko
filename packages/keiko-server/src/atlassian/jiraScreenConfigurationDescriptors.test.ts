import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { SCREEN_CONFIGURATION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-screen-configuration-fixture.js";
import {
  JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS,
  jiraScreenConfigurationDeclarationForTool,
} from "./jiraScreenConfigurationDescriptors.js";

it("defines exactly six bounded closed screen administration operations", () => {
  expect(Object.keys(JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS)).toHaveLength(6);
  for (const [name, definition] of Object.entries(JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraScreenConfigurationDeclarationForTool(name)?.risk).toBe("write");
  }
  expect(jiraScreenConfigurationDeclarationForTool("jira.screen-http")).toBeUndefined();
});
it.each(CASES)(
  "admits the complete reviewed $tool fixture and independent receipt",
  ({ tool, args, expectedOutcome, expectedReceipt }) => {
    const declaration = jiraScreenConfigurationDeclarationForTool(tool);
    if (declaration === undefined) throw new TypeError("Missing screen configuration declaration");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: expectedOutcome,
        ...expectedReceipt,
      }),
    ).toBeUndefined();
  },
);
it.each([
  ["jira.add-default-screen-field", { ...CASES[0].args, acceptUnverifiedDefault: false }],
  ["jira.add-default-screen-field", { ...CASES[0].args, screenId: "1" }],
  [
    "jira.add-screen-tab-field",
    { ...CASES[1].args, expectedFields: [{ id: "summary", name: "Summary" }] },
  ],
  ["jira.move-screen-tab-field", { ...CASES[3].args, afterFieldId: "description" }],
  [
    "jira.move-screen-tab-field",
    { ...CASES[3].args, after: "https://untrusted.invalid/field/description" },
  ],
  ["jira.set-screen-field-show-when-empty", { ...CASES[4].args, showWhenEmpty: "false" }],
  ["jira.move-screen-tab", { ...CASES[5].args, position: -1 }],
] as const)("refuses incomplete, wider or ambiguous %s input", (name, args) => {
  const declaration = jiraScreenConfigurationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing screen configuration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("keeps native limitations and zero-based semantics in the operation descriptions", () => {
  expect(
    JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS["jira.add-default-screen-field"].description,
  ).toContain("unconfirmed");
  expect(JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS["jira.move-screen-tab"].description).toContain(
    "zero-based",
  );
  expect(
    JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS["jira.move-screen-tab-field"].description,
  ).toContain("Never pass a URL");
  expect(
    JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS["jira.set-screen-field-show-when-empty"]
      .description,
  ).toContain("never false");
});
