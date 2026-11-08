import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { INSTANCE_SETTING_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-instance-setting-mutation-fixture.js";
import { JIRA_INSTANCE_SETTING_WRITE_DEFINITIONS as DEFINITIONS, jiraInstanceSettingMutationDeclarationForTool as declaration } from "./jiraInstanceSettingMutationDescriptors.js";

describe("closed instance setting declarations", () => {
  it.each(CASES)("declares $name with bounded native values and receipt", ({ name, args, receipt }) => {
    const actual = declaration(name);
    if (actual === undefined) throw new TypeError("Missing instance setting declaration");
    expect(actual.risk).toBe("write"); expect(actual.descriptor.description).toContain("issue-tracker.admin");
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...receipt })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...args, headers: {} })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { outcome: "succeeded", ...receipt, enforced: true })).toBeDefined();
  });
  it("binds actual property types to the four fixed nonsecret keys", () => {
    const actual = declaration("jira.set-application-property");
    if (actual === undefined) throw new TypeError("Missing property declaration");
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...CASES[0].args, value: "false" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { ...CASES[0].args, propertyKey: "jira.home" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, { expectedActorKey: "actor", propertyKey: "jira.clone.prefix", expectedValue: "CLONE", value: "" })).toBeUndefined();
  });
  it("retains repeated columns and false target flags while withholding raw property and URL values", () => {
    const columns = declaration("jira.set-system-columns"); const readOnly = declaration("jira.set-read-only-mode");
    if (columns === undefined || readOnly === undefined) throw new TypeError("Missing setting declaration");
    expect(describeCatalogSchemaMismatch(columns.descriptor.resultSchema, { outcome: "succeeded", userKey: "actor", columnIds: ["summary", "summary"] })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(readOnly.descriptor.resultSchema, { outcome: "succeeded", userKey: "actor", readOnlyEnabled: false })).toBeUndefined();
    const base = declaration("jira.set-instance-base-url");
    if (base === undefined) throw new TypeError("Missing base URL declaration");
    expect(describeCatalogSchemaMismatch(base.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", baseUrl: "https://raw.invalid" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(base.descriptor.resultSchema, { outcome: "succeeded", ...CASES[2].receipt })).toBeDefined();
    expect(describeCatalogSchemaMismatch(base.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...CASES[2].receipt })).toBeUndefined();
  });
});
