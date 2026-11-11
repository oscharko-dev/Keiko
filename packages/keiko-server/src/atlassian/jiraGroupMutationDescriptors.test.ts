import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { GROUP_MUTATION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-group-mutation-fixture.js";
import {
  JIRA_GROUP_WRITE_DEFINITIONS as DEFINITIONS,
  jiraGroupMutationDeclarationForTool as declaration,
} from "./jiraGroupMutationDescriptors.js";

describe("closed administration group declarations", () => {
  it.each(CASES)(
    "declares $name with exact principals and bounded native facts",
    ({ name, args, receipt, confirmed }) => {
      const actual = declaration(name);
      if (actual === undefined) throw new TypeError("Missing group declaration");
      expect(actual.risk).toBe("write");
      expect(actual.descriptor.description).toContain("issue-tracker.admin");
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
      expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
          outcome: "succeeded-unconfirmed",
          ...receipt,
        }),
      ).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, headers: {} }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
          outcome: "succeeded",
          ...receipt,
        }) === undefined,
      ).toBe(confirmed);
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
          outcome: "succeeded-unconfirmed",
          ...receipt,
          effectivePermissions: [],
        }),
      ).toBeDefined();
    },
  );
  it("keeps exact native usernames separate from persistent user keys", () => {
    const input = declaration("jira.add-group-user")?.descriptor.inputSchema;
    expect(input).toMatchObject({
      properties: { user: { required: ["key", "name"], additionalProperties: false } },
      required: expect.arrayContaining([
        "expectedObservedMembership",
        "acceptGlobalPermissionChange",
      ]) as unknown,
    });
  });
  it("exposes no arbitrary group or identity proxy", () => {
    for (const name of ["jira.group", "jira.set-group", "jira.create-user", "POST /group"])
      expect(declaration(name)).toBeUndefined();
  });
});
