import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { IDENTITY_MUTATION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-identity-mutation-fixture.js";
import {
  jiraIdentityMutationDeclarationForTool as declaration,
  JIRA_IDENTITY_WRITE_DEFINITIONS as DEFINITIONS,
} from "./jiraIdentityMutationDescriptors.js";

describe("closed secret-free identity declarations", () => {
  it.each(CASES)(
    "declares $name without a model secret or guessed completion",
    ({ name, args, receipt, confirmed }) => {
      const selected = declaration(name);
      if (selected === undefined) throw new TypeError("Missing identity declaration");
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
      expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
          outcome: "succeeded-unconfirmed",
          ...receipt,
        }),
      ).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
          outcome: "succeeded",
          ...receipt,
        }) === undefined,
      ).toBe(confirmed);
      for (const key of [
        "password",
        "currentPassword",
        "licenseString",
        "cookie",
        "headers",
        "url",
      ])
        expect(
          describeCatalogSchemaMismatch(selected.descriptor.inputSchema, {
            ...args,
            [key]: "not-a-model-field",
          }),
        ).toBeDefined();
    },
  );
  it("requires explicit active-change consent and refuses effective-access confirmation", () => {
    const selected = declaration("jira.update-user");
    if (selected === undefined) throw new TypeError("Missing update declaration");
    const args = { ...CASES[1].args, active: false };
    expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(selected.descriptor.inputSchema, {
        ...args,
        acceptUnverifiedAccess: true,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
        ...CASES[1].receipt,
        userActive: false,
        outcome: "succeeded",
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
        ...CASES[1].receipt,
        userActive: false,
        outcome: "succeeded-unconfirmed",
      }),
    ).toBeUndefined();
  });
  it("keeps the seven secret-dependent and three ownership-dependent identities unadvertised until their real owners exist", () => {
    for (const name of [
      "jira.update-myself",
      "jira.update-my-password",
      "jira.update-user-password",
      "jira.validate-create-user-password",
      "jira.validate-update-user-password",
      "jira.validate-license",
      "jira.login",
      "jira.logout",
      "jira.release-websudo",
      "jira.unlock-anonymization",
    ])
      expect(declaration(name)).toBeUndefined();
  });
});
