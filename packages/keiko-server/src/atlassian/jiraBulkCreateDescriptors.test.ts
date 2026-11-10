import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  BULK_CREATE_ARGUMENTS,
  BULK_CREATE_RECEIPT,
} from "../../../../tests/support/jira-bulk-create-fixture.js";
import {
  JIRA_BULK_CREATE_DEFINITION,
  jiraBulkCreateDeclarationForTool,
} from "./jiraBulkCreateDescriptors.js";

describe("one native bulk create declaration", () => {
  it("bounds all items and forbids claiming complete success", () => {
    const tool = jiraBulkCreateDeclarationForTool("jira.create-issues");
    if (tool === undefined) throw new TypeError("Missing bulk declaration");
    expect(isBoundedExternalJsonSchema(JIRA_BULK_CREATE_DEFINITION.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(JIRA_BULK_CREATE_DEFINITION.result)).toBe(true);
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, BULK_CREATE_ARGUMENTS),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...BULK_CREATE_ARGUMENTS,
        issues: [],
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...BULK_CREATE_ARGUMENTS,
        issueUpdates: [],
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...BULK_CREATE_RECEIPT,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded",
        ...BULK_CREATE_RECEIPT,
      }),
    ).toBeDefined();
  });
});
