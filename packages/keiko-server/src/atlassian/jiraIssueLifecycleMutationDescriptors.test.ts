import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { ISSUE_LIFECYCLE_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-issue-lifecycle-fixture.js";
import {
  JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS as DEFINITIONS,
  jiraIssueLifecycleMutationDeclarationForTool as declaration,
} from "./jiraIssueLifecycleMutationDescriptors.js";

describe("closed issue lifecycle declarations", () => {
  // An issue deletion is the one lifecycle effect that may be declared succeeded (#4354, ADR-0128);
  // the others keep refusing any completed-effect claim, exactly as before.
  const COMPLETED_CLAIM_REFUSED = CASES.filter(({ name }) => name !== "jira.delete-issue");
  it.each(COMPLETED_CLAIM_REFUSED)(
    "declares $name without completed-effect claims",
    ({ name, args, receipt }) => {
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
    },
  );
  it("declares an accepted issue deletion that read back as gone as succeeded, and nothing else as completed", () => {
    const tool = declaration("jira.delete-issue");
    if (tool === undefined) throw new TypeError("Missing delete declaration");
    const { receipt } = CASES[1];
    for (const outcome of ["succeeded", "succeeded-unconfirmed"])
      expect(
        describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome, ...receipt }),
      ).toBeUndefined();
    // The receipt still states the issue is gone; a receipt that says otherwise is no deletion.
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded",
        ...receipt,
        issuePresent: true,
      }),
    ).toBeDefined();
    expect(tool.descriptor.description).toContain("reads as gone");
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
