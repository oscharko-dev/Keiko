import { describe, expect, it } from "vitest";
import { JIRA_SCHEMA_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { SCHEMA_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-schema-mutation-fixture.js";
import { JIRA_SCHEMA_WRITE_DEFINITIONS, jiraSchemaMutationDeclarationForTool as declaration } from "./jiraSchemaMutationDescriptors.js";

describe("closed schema mutation declarations", () => {
  it("is exhaustive against the canonical operation family", () => {
    expect(Object.keys(JIRA_SCHEMA_WRITE_DEFINITIONS)).toEqual([...JIRA_SCHEMA_MUTATIONS]);
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("admits reviewed $name snapshots and bounded receipts", ({ name, args, receipt }) => {
    const actual = declaration(name); if (actual === undefined) throw new TypeError("Missing schema declaration");
    expect(actual.risk).toBe("write"); expect(actual.descriptor.description).toContain("issue-tracker.admin");
    expect(isBoundedExternalJsonSchema(actual.descriptor.inputSchema)).toBe(true);
    expect(isBoundedExternalJsonSchema(actual.descriptor.resultSchema)).toBe(true);
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...receipt })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, method: "POST", url: "https://synthetic.invalid/" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded", ...receipt, allIssuesMigrated: true })).toBeDefined();
  });
  it("does not widen empty field contexts into global configuration", () => {
    const actual = declaration("jira.create-custom-field"); if (actual === undefined) throw new TypeError("Missing declaration");
    const args = SCHEMA_MUTATION_FIXTURE_CASES[0].args;
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, projectIds: [] })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, issueTypeIds: [] })).toBeDefined();
  });
  it("retains reviewed null, rejects missing/null desired descriptions and does not accept avatars", () => {
    const actual = declaration("jira.update-issue-type"); if (actual === undefined) throw new TypeError("Missing declaration");
    const args = SCHEMA_MUTATION_FIXTURE_CASES[3].args;
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, expectedIssueType: { ...args.expectedIssueType, description: null } })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, description: null })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, avatarId: "7" })).toBeDefined();
  });
  it("keeps one-based link positions and array-root terminology native shapes", () => {
    const actual = declaration("jira.move-link-type"); if (actual === undefined) throw new TypeError("Missing declaration");
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...SCHEMA_MUTATION_FIXTURE_CASES[9].args, newPosition: 0 })).toBeDefined();
    expect(declaration("jira.set-terminology")?.descriptor.description).toContain("JSON collection");
    expect(declaration("jira.delete-custom-fields")?.descriptor.description).toContain("partial success");
  });
  it("offers no arbitrary schema mutation route", () => {
    for (const name of ["jira.schema-write", "jira.issue-type", "jira.delete-field", "POST /field"]) expect(declaration(name)).toBeUndefined();
  });
});
