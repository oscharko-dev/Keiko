import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { ROLE_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-role-mutation-fixture.js";
import { JIRA_ROLE_WRITE_DEFINITIONS, jiraRoleMutationDeclarationForTool as declaration } from "./jiraRoleMutationDescriptors.js";

describe("closed native role administration descriptors", () => {
  it.each(ROLE_MUTATION_FIXTURE_CASES)("declares $name with closed inputs and native write routing", ({ name, args, receipt }) => {
    const actual = declaration(name);
    expect(actual?.name).toBe(name);
    expect(actual?.risk).toBe("write");
    expect(actual?.descriptor.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(actual?.descriptor.description).toContain("issue-tracker.admin");
    expect(isBoundedExternalJsonSchema(JIRA_ROLE_WRITE_DEFINITIONS[name].input)).toBe(true);
    expect(isBoundedExternalJsonSchema(JIRA_ROLE_WRITE_DEFINITIONS[name].result)).toBe(true);
    if (actual === undefined) throw new TypeError("Missing role declaration");
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...receipt })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, headers: {} })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded", ...receipt, effectivePermissions: [] })).toBeDefined();
  });
  it("distinguishes partial POST from full PUT", () => {
    expect(declaration("jira.update-role")?.descriptor.inputSchema).toMatchObject({ anyOf: [{ required: ["name"] }, { required: ["description"] }] });
    expect(declaration("jira.replace-role")?.descriptor.inputSchema).toMatchObject({ required: expect.arrayContaining(["name", "description"]) });
  });
  it("keeps default and project membership scopes explicit", () => {
    expect(declaration("jira.add-role-default-actors")?.descriptor.description).toContain("role defaults");
    expect(declaration("jira.set-project-role-actors")?.descriptor.inputSchema).toMatchObject({ required: expect.arrayContaining(["projectIdOrKey", "principals"]) });
    expect(declaration("jira.delete-role")?.descriptor.description).toContain("always remains unconfirmed");
  });
  it("exposes no arbitrary role/permission proxy", () => {
    for (const name of ["jira.role", "jira.role-write", "jira.grant-permission", "POST /role/7"])
      expect(declaration(name)).toBeUndefined();
  });
});
