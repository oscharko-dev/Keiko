import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS,
  jiraApplicationSettingsDeclarationForTool,
} from "./jiraApplicationSettingsDescriptors.js";

function declaration(
  name: string,
): import("@oscharko-dev/keiko-contracts/runtime/managed-mcp").ManagedMcpToolDeclaration {
  const value = jiraApplicationSettingsDeclarationForTool(name);
  if (value === undefined) throw new TypeError("Missing application settings declaration");
  return value;
}
it("compiles only the three closed native settings reads", () => {
  expect(Object.keys(JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS)).toHaveLength(3);
  for (const [name, definition] of Object.entries(JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(declaration(name).risk).toBe("read");
  }
  expect(jiraApplicationSettingsDeclarationForTool("jira.set-preference")).toBeUndefined();
  expect(jiraApplicationSettingsDeclarationForTool("constructor")).toBeUndefined();
});
it.each([
  ["jira.application-properties", { key: "jira.clone.prefix" }],
  ["jira.application-properties", { permissionLevel: "ADMIN", startAt: 0, maxResults: 100 }],
  ["jira.application-properties", { permissionLevel: "SYSADMIN" }],
  ["jira.advanced-settings", {}],
  ["jira.my-preference", { key: "user.notify.own.changes" }],
] as const)("admits the typed %s selection", (name, args) => {
  expect(
    describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args),
  ).toBeUndefined();
});
it.each([
  ["jira.application-properties", {}],
  ["jira.application-properties", { key: "jira.home", permissionLevel: "ADMIN" }],
  ["jira.application-properties", { key: "jira.home", startAt: 0 }],
  ["jira.application-properties", { permissionLevel: "SYSADMIN_ONLY" }],
  ["jira.application-properties", { permissionLevel: "ADMIN", keyFilter: "jira.*" }],
  ["jira.advanced-settings", { maxResults: 101 }],
  ["jira.advanced-settings", { startAt: -1 }],
  ["jira.my-preference", { key: "" }],
  ["jira.my-preference", { key: "jira.user.locale", username: "another-user" }],
  ["jira.my-preference", { key: "jira.user.locale", value: "de_DE" }],
] as const)("refuses ambiguous or writable %s selectors", (name, args) => {
  expect(
    describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args),
  ).toBeDefined();
});
it.each([
  { key: "jira.clone.prefix", valueState: "observed", valueType: "string", stringValue: "" },
  { key: "jira.option.voting", valueState: "observed", valueType: "boolean", booleanValue: false },
  { key: "jira.clone.prefix", valueState: "unknown", valueType: "string" },
  { key: "jira.home", valueState: "withheld" },
] as const)("retains only typed readable list metadata: %j", (item) => {
  expect(
    describeCatalogSchemaMismatch(declaration("jira.advanced-settings").descriptor.resultSchema, {
      outcome: "succeeded",
      settingsScope: "advanced-settings",
      items: [item],
      startAt: 0,
      total: 1,
    }),
  ).toBeUndefined();
});
it.each([
  { key: "jira.home", valueState: "withheld", stringValue: "private native value" },
  { key: "jira.home", valueState: "withheld", defaultValue: "private default" },
  { key: "jira.home", valueState: "withheld", example: "private example" },
  { key: "jira.home", valueState: "withheld", allowedValues: ["private option"] },
  {
    key: "jira.clone.prefix",
    valueState: "unknown",
    valueType: "string",
    stringValue: "invented default",
  },
  {
    key: "jira.option.voting",
    valueState: "observed",
    valueType: "boolean",
    booleanValue: "false",
  },
] as const)("refuses value leakage or fabricated defaults in list rows: %j", (item) => {
  expect(
    describeCatalogSchemaMismatch(declaration("jira.advanced-settings").descriptor.resultSchema, {
      outcome: "succeeded",
      settingsScope: "advanced-settings",
      items: [item],
      startAt: 0,
      total: 1,
    }),
  ).toBeDefined();
});
it("preserves zero as an integer preference observation, without a quota claim", () => {
  const schema = declaration("jira.my-preference").descriptor.resultSchema;
  const result = {
    outcome: "succeeded",
    settingsScope: "current-user-preference",
    key: "user.issues.per.page",
    valueState: "observed",
    valueType: "integer",
    integerValue: 0,
  };
  expect(describeCatalogSchemaMismatch(schema, result)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(schema, { ...result, integerValue: 0.5 })).toBeDefined();
  expect(describeCatalogSchemaMismatch(schema, { ...result, unlimited: true })).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(schema, { ...result, effectivePermission: "SYSADMIN" }),
  ).toBeDefined();
});
it.each([
  { valueState: "withheld", stringValue: "private" },
  { valueState: "withheld", booleanValue: false },
  { valueState: "withheld", integerValue: 0 },
  { valueState: "unknown", valueType: "string", stringValue: "invented default" },
  { valueState: "unknown", valueType: "boolean", booleanValue: false },
  { valueState: "unknown", valueType: "integer", integerValue: 0 },
  { valueState: "observed", valueType: "boolean", stringValue: "false" },
  { valueState: "observed", valueType: "integer", integerValue: 0, stringValue: "leak" },
] as const)("refuses incoherent singleton settings values %j", (fields) => {
  for (const [name, scope] of [
    ["jira.my-preference", "current-user-preference"],
    ["jira.application-properties", "application-properties"],
  ] as const) {
    expect(
      describeCatalogSchemaMismatch(declaration(name).descriptor.resultSchema, {
        outcome: "succeeded",
        settingsScope: scope,
        key: "jira.user.locale",
        ...fields,
      }),
    ).toBeDefined();
  }
});
it("does not allow the list-only advanced endpoint or singleton preference to switch shapes", () => {
  expect(
    describeCatalogSchemaMismatch(declaration("jira.advanced-settings").descriptor.resultSchema, {
      outcome: "succeeded",
      settingsScope: "advanced-settings",
      key: "jira.clone.prefix",
      valueState: "withheld",
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(declaration("jira.my-preference").descriptor.resultSchema, {
      outcome: "succeeded",
      settingsScope: "current-user-preference",
      items: [],
      startAt: 0,
      total: 0,
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(declaration("jira.my-preference").descriptor.resultSchema, {
      outcome: "failed",
      reason: "permission-denied",
    }),
  ).toBeUndefined();
});
