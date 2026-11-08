import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { RELEASE_LIFECYCLE_FIXTURE_CASES, RELEASE_FIXTURE_VERSION, RELEASE_FIXTURE_BASE } from "../../../../tests/support/jira-release-lifecycle-fixture.js";
import { JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS, jiraReleaseLifecycleDeclarationForTool } from "./jiraReleaseLifecycleDescriptors.js";

it("defines exactly four closed native release mutation schemas inside the existing compiler bounds", () => {
  expect(Object.keys(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraReleaseLifecycleDeclarationForTool(name)?.risk).toBe("write");
  }
  expect(jiraReleaseLifecycleDeclarationForTool("jira.delete-version")).toBeUndefined();
});
it.each(RELEASE_LIFECYCLE_FIXTURE_CASES)("admits the complete reviewed $tool source fixture", ({ tool, args }) => {
  const declaration = jiraReleaseLifecycleDeclarationForTool(tool);
  if (declaration === undefined) throw new TypeError("Missing release mutation descriptor");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
});
it.each([
  ["jira.delete-component", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[0].args, moveIssuesTo: null }],
  ["jira.merge-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[1].args, expectedTargetSnapshot: { name: "Retained release" } }],
  ["jira.move-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[2].args, position: "First" }],
  ["jira.move-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[2].args, after: "https://untrusted.invalid/version/82" }],
  ["jira.move-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[2].args, expectedVersionIds: ["81", "81"] }],
  ["jira.remove-and-swap-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[3].args, customFieldReplacementList: [{ customFieldId: "10001" }] }],
  ["jira.remove-and-swap-version", { ...RELEASE_LIFECYCLE_FIXTURE_CASES[3].args, moveFixIssuesTo: 82 }],
] as const)("refuses incomplete, ambiguous or wider %s input", (name, args) => {
  const declaration = jiraReleaseLifecycleDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing release mutation descriptor");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("admits explicit clearing, preserving null separately from false or empty text", () => {
  const declaration = jiraReleaseLifecycleDeclarationForTool("jira.remove-and-swap-version");
  if (declaration === undefined) throw new TypeError("Missing swap descriptor");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
    ...RELEASE_FIXTURE_BASE, versionId: "81", expectedVersionSnapshot: RELEASE_FIXTURE_VERSION,
    moveFixIssuesTo: null, moveAffectedIssuesTo: null, customFieldReplacementList: [], expectedReplacementVersions: [],
  })).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
    outcome: "succeeded-unconfirmed", projectId: "10000", projectKey: "SYN", userKey: "synthetic-actor", versionId: "81", replacementVersionIds: [],
  })).toBeUndefined();
});
it("keeps explicit native limitations in the model-visible operation descriptions", () => {
  expect(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS["jira.delete-component"].description).toContain("unconfirmed");
  expect(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS["jira.merge-version"].description).toContain("unconfirmed");
  expect(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS["jira.remove-and-swap-version"].description).toContain("ALL custom fields");
  expect(JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS["jira.move-version"].description).toContain("never pass a URL");
});
