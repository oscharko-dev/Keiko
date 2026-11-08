import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { ISSUE_LIFECYCLE_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-issue-lifecycle-fixture.js";
import {
  JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS as DEFINITIONS,
  jiraIssueLifecycleMutationDeclarationForTool as declaration,
} from "./jiraIssueLifecycleMutationDescriptors.js";

describe("closed issue lifecycle declarations", () => {
  it.each(CASES)("declares $name without completed-effect claims", ({ name, args, receipt }) => {
    const tool = declaration(name);
    if (tool === undefined) throw new TypeError("Missing issue lifecycle declaration");
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...args, notifyUsers: false }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...args,
        confirmUnverifiedEffect: false,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...receipt,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded",
        ...receipt,
      }),
    ).toBeDefined();
  });
  it("does not expose recursive deletion or task hierarchy moves", () => {
    const tool = declaration("jira.delete-issue");
    if (tool === undefined) throw new TypeError("Missing delete declaration");
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...CASES[1].args,
        expectedSubtasks: [{ id: "10002", key: "SYN-3" }],
      }),
    ).toBeDefined();
    expect(declaration("jira.reparent-subtask")).toBeUndefined();
  });
});
