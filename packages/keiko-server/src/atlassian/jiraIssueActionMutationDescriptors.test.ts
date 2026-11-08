import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { ISSUE_ACTION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-issue-action-fixture.js";
import {
  JIRA_ISSUE_ACTION_WRITE_DEFINITIONS as DEFINITIONS,
  jiraIssueActionMutationDeclarationForTool as declaration,
} from "./jiraIssueActionMutationDescriptors.js";

describe("closed pin and explicit notification declarations", () => {
  it.each(CASES)(
    "declares bounded $name without a generic notification/HTTP proxy",
    ({ name, args }) => {
      const actual = declaration(name);
      if (actual === undefined) throw new TypeError("Missing issue action declaration");
      expect(actual.risk).toBe("write");
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
      expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, headers: {} }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
          ...args,
          url: "https://other.invalid",
        }),
      ).toBeDefined();
    },
  );
  it("allows confirmed exact pinning and refuses invented email delivery", () => {
    const pin = declaration("jira.pin-comment");
    const mail = declaration("jira.notify-issue");
    if (pin === undefined || mail === undefined)
      throw new TypeError("Missing issue action declaration");
    expect(
      describeCatalogSchemaMismatch(pin.descriptor.resultSchema, {
        outcome: "succeeded",
        ...CASES[0].receipt,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(mail.descriptor.resultSchema, {
        outcome: "succeeded",
        userKey: "actor",
        issueId: "10001",
        issueKey: "SYN-1",
        notificationDigest: "a".repeat(64),
        recipientUserKeys: ["target"],
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(mail.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        userKey: "actor",
        issueId: "10001",
        issueKey: "SYN-1",
        notificationDigest: "a".repeat(64),
        recipientUserKeys: ["target"],
      }),
    ).toBeUndefined();
  });
  it("exposes neither raw recipients nor HTML/dynamic group selection", () => {
    const actual = declaration("jira.notify-issue");
    if (actual === undefined) throw new TypeError("Missing notification declaration");
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
        ...CASES[1].args,
        htmlBody: "<p>unsupported</p>",
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
        ...CASES[1].args,
        users: [{ key: "target", name: "user", emailAddress: "raw@example.invalid" }],
      }),
    ).toBeDefined();
  });
});
