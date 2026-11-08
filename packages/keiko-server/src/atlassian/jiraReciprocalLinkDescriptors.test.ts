import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { RECIPROCAL_ARGUMENTS } from "../../../../tests/support/jira-reciprocal-link-fixture.js";
import { JIRA_RECIPROCAL_LINK_DEFINITION, jiraReciprocalLinkDeclarationForTool } from "./jiraReciprocalLinkDescriptors.js";

describe("closed native reciprocal delegation", () => {
  it("bounds both sides and forbids completion claims", () => {
    const tool = jiraReciprocalLinkDeclarationForTool("jira.create-reciprocal-remote-link");
    if (tool === undefined) throw new TypeError("Missing reciprocal declaration");
    expect(isBoundedExternalJsonSchema(JIRA_RECIPROCAL_LINK_DEFINITION.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(JIRA_RECIPROCAL_LINK_DEFINITION.result)).toBe(true);
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, RECIPROCAL_ARGUMENTS)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...RECIPROCAL_ARGUMENTS, headers: {} })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...RECIPROCAL_ARGUMENTS, acceptNativeDelegatedEffect: false })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", issueId: "10001", issueKey: "SYN-1", userKey: "synthetic-actor",
      applicationLinkId: RECIPROCAL_ARGUMENTS.expectedApplication.id, applicationLinkDestinationDigest: "a".repeat(64), selectedRemoteIssueId: "9223372036854775807", delegatedEffectRequested: true })).toBeUndefined();
  });
});
