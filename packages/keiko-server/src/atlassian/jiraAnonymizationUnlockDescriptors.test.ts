import { describe, expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ANONYMIZATION_UNLOCK_CASE as CASE } from "../../../../tests/support/jira-anonymization-unlock-fixture.js";
import { jiraAnonymizationUnlockDeclarationForTool as declaration } from "./jiraAnonymizationUnlockDescriptors.js";
const tool = declaration(CASE.name);
if (tool === undefined) throw new TypeError("Missing unlock declaration");
describe("fixed human-attested anonymization unlock contract", () => {
  it("keeps the public task review typed, bounded and separate from human attestation", () => {
    expect(tool.risk).toBe("write");
    expect(isBoundedExternalJsonSchema(tool.descriptor.inputSchema)).toBe(true);
    expect(isBoundedExternalJsonSchema(tool.descriptor.resultSchema)).toBe(true);
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, CASE.args)).toBeUndefined();
    for (const key of [
      "shutdownConfirmed",
      "ownerShutdownConfirmation",
      "taskId",
      "password",
      "url",
      "method",
    ])
      expect(
        describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...CASE.args, [key]: true }),
      ).toBeDefined();
  });
  it("does not manufacture process proof, no-op or confirmed unlock from ACK", () => {
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...CASE.receipt,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded",
        ...CASE.receipt,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...CASE.receipt,
        ownerShutdownVerified: true,
      }),
    ).toBeDefined();
    expect(tool.descriptor.description).toContain("human statement");
    expect(tool.descriptor.description).toContain("no compare-and-swap");
  });
});
