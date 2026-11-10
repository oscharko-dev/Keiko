import { expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraBoardConfigurationMutationDeclarationForTool as declaration } from "./jiraBoardConfigurationMutationDescriptors.js";

it.each(["jira.delete-board", "jira.set-board-refined-velocity"])(
  "declares the one fixed %s effect with reviewed native context",
  (name) => {
    const tool = declaration(name);
    if (tool === undefined) throw new TypeError("Expected board configuration declaration");
    expect(tool.risk).toBe("write");
    const args = {
      boardId: "7",
      expectedActorKey: "actor-key",
      expectedBoardName: "Board",
      expectedBoardType: "scrum",
      expectedFilterId: "37",
      ...(name === "jira.delete-board" ? {} : { expectedValue: true, value: false }),
    };
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...args,
        url: "https://untrusted.invalid",
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...args, expectedFilterId: 37 }),
    ).toBeDefined();
    const mismatch = describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
      outcome: "succeeded-unconfirmed",
      boardId: "7",
      filterId: "37",
      userKey: "actor-key",
      boardPresent: false,
    });
    if (name === "jira.delete-board") expect(mismatch).toBeUndefined();
    else expect(mismatch).toBeDefined();
  },
);
it("does not register an arbitrary board setting or remote URL operation", () => {
  expect(declaration("jira.set-board-setting")).toBeUndefined();
  expect(declaration("jira.raw-agile")).toBeUndefined();
});
