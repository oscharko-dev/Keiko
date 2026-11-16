import { describe, expect, it } from "vitest";
import {
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_READ_TOOL_FAMILIES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  PRIVATE_ACCOUNT_READ_CASES as READS,
  PRIVATE_ACCOUNT_WRITE_CASES as WRITES,
} from "../../../../tests/support/jira-private-account-fixture.js";
import {
  JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS,
  JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS,
  jiraPrivateAccountDeclarationForTool as declaration,
} from "./jiraPrivateAccountDescriptors.js";

describe("closed private account descriptors", () => {
  it("matches six canonical writes and three separate native POST reads", () => {
    expect(Object.keys(JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS)).toEqual([
      ...JIRA_PRIVATE_ACCOUNT_MUTATIONS,
    ]);
    expect(Object.keys(JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS)).toEqual([
      ...JIRA_READ_TOOL_FAMILIES.privateAccount,
    ]);
    expect(WRITES.map((item) => item.name)).toEqual([...JIRA_PRIVATE_ACCOUNT_MUTATIONS]);
    expect(READS.map((item) => item.name)).toEqual([...JIRA_READ_TOOL_FAMILIES.privateAccount]);
  });
  it.each([...WRITES, ...READS])(
    "admits only public reviewed arguments for $name",
    ({ name, args }) => {
      const tool = declaration(name);
      if (tool === undefined) throw new TypeError("Missing private-account declaration");
      expect(isBoundedExternalJsonSchema(tool.descriptor.inputSchema)).toBe(true);
      expect(isBoundedExternalJsonSchema(tool.descriptor.resultSchema)).toBe(true);
      expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
      for (const field of [
        "password",
        "currentPassword",
        "newPassword",
        "licenseString",
        "cookie",
        "headers",
        "inputRequestId",
        "url",
      ]) {
        expect(
          describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
            ...args,
            [field]: "untrusted",
          }),
        ).toBeDefined();
      }
    },
  );
  it.each(WRITES)("preserves the confirmation boundary for $name", (selected) => {
    const tool = declaration(selected.name);
    if (tool === undefined) throw new TypeError("Missing write declaration");
    expect(tool.risk).toBe("write");
    const mismatch = describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
      outcome: "succeeded",
      ...selected.receipt,
    });
    if (selected.confirmed) expect(mismatch).toBeUndefined();
    else expect(mismatch).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...selected.receipt,
      }),
    ).toBeUndefined();
  });
  it.each(WRITES)("admits only body-free confirmed journal replay for $name", (selected) => {
    const tool = declaration(selected.name);
    if (tool === undefined) throw new TypeError("Missing private-account replay declaration");
    const schema = tool.descriptor.resultSchema;
    const replay = { outcome: "succeeded", replayed: true };
    if (selected.confirmed) expect(describeCatalogSchemaMismatch(schema, replay)).toBeUndefined();
    else expect(describeCatalogSchemaMismatch(schema, replay)).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { outcome: "succeeded" })).toBeDefined();
    for (const replayed of [false, "true", 1])
      expect(
        describeCatalogSchemaMismatch(schema, { outcome: "succeeded", replayed }),
      ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, { ...replay, actorUserKey: "partial" }),
    ).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...replay, actorUserKey: 42 })).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, { ...replay, sessionEstablished: false }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, { ...replay, password: "reflected" }),
    ).toBeDefined();
  });
  it.each(READS)("keeps $name read-only with exact scoped result facts", (selected) => {
    const tool = declaration(selected.name);
    if (tool === undefined) throw new TypeError("Missing read declaration");
    expect(tool.risk).toBe("read");
    const identity =
      selected.name === "jira.validate-create-user-password"
        ? { username: "candidate" }
        : selected.name === "jira.validate-update-user-password"
          ? { userKey: "private-target", username: "target-user" }
          : {};
    const result = {
      outcome: "succeeded",
      actorUserKey: "private-actor",
      validationScope: selected.scope,
      accepted: false,
      violationCount: 2,
      ...identity,
    };
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, result)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        ...result,
        accepted: true,
        violationCount: 0,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        ...result,
        accepted: false,
        violationCount: 0,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { ...result, accepted: true }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded" }),
    ).toBeDefined();
    for (const field of ["password", "licenseString", "errors", "session", "cookie"]) {
      expect(
        describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
          ...result,
          [field]: "reflected",
        }),
      ).toBeDefined();
    }
  });
  it("requires actual session proof for login success", () => {
    const tool = declaration("jira.login");
    if (tool === undefined) throw new TypeError("Missing login declaration");
    const result = {
      outcome: "succeeded",
      actorUserKey: "private-actor",
      userKey: "private-actor",
      username: "private-operator",
    };
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, result)).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        ...result,
        sessionEstablished: false,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        ...result,
        sessionEstablished: true,
      }),
    ).toBeUndefined();
  });
  it("describes license validation as administrative but not activation", () => {
    const tool = declaration("jira.validate-license");
    if (tool === undefined) throw new TypeError("Missing license declaration");
    expect(tool.risk).toBe("read");
    expect(tool.descriptor.description).toContain("issue-tracker.admin");
    expect(tool.descriptor.description).toContain("without activating");
  });
  it("does not invent anonymization unlock or generic credential transfer", () => {
    expect(declaration("jira.unlock-anonymization")).toBeUndefined();
    expect(declaration("jira.send-secret")).toBeUndefined();
  });
});
