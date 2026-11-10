import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_AGILE_PLANNING_WRITE_DEFINITIONS,
  jiraAgilePlanningDeclarationForTool,
} from "./jiraAgilePlanningDescriptors.js";
import { AGILE_PLANNING_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-agile-planning-fixture.js";

it("keeps all four fixed planning declarations bounded and closed", () => {
  expect(Object.keys(JIRA_AGILE_PLANNING_WRITE_DEFINITIONS)).toHaveLength(4);
  for (const { name } of CASES) {
    const definition = JIRA_AGILE_PLANNING_WRITE_DEFINITIONS[name];
    expect(isBoundedExternalJsonSchema(definition.input), name).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), name).toBe(true);
    expect(jiraAgilePlanningDeclarationForTool(name)?.descriptor.idempotency).toBe(
      "server-key-required",
    );
  }
  expect(jiraAgilePlanningDeclarationForTool("jira.agile-proxy")).toBeUndefined();
});
it.each(CASES)(
  "admits reviewed $name input and bounded uncertainty receipts",
  ({ name, args, receipt }) => {
    const declaration = jiraAgilePlanningDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing planning declaration");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, { ...args, headers: {} }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
        ...args,
        rawJql: "arbitrary",
      }),
    ).toBeDefined();
    const result = { outcome: "succeeded-unconfirmed", ...receipt };
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, result),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        ...result,
        absolutePosition: 1,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        ...result,
        rawRank: "opaque",
      }),
    ).toBeDefined();
  },
);
it("preserves null, zero and native decimal-text distinctions", () => {
  const declaration = jiraAgilePlanningDeclarationForTool("jira.set-issue-estimation");
  if (declaration === undefined) throw new TypeError("Missing estimation declaration");
  const schema = declaration.descriptor.inputSchema;
  expect(
    describeCatalogSchemaMismatch(schema, { ...CASES[3].args, expectedValue: null, value: "0" }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(schema, { ...CASES[3].args, expectedValue: 0, value: "1" }),
  ).toBeUndefined();
  expect(describeCatalogSchemaMismatch(schema, { ...CASES[3].args, value: null })).toBeDefined();
  expect(describeCatalogSchemaMismatch(schema, { ...CASES[3].args, value: 0 })).toBeDefined();
});
