import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraInstanceDeclarationForTool } from "./jiraInstanceDescriptors.js";
import { JIRA_DIRECTORY_READ_DEFINITIONS } from "./jiraDirectoryDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

it("describes configured base URL as a comparison-only fact with explicit availability", () => {
  const declaration = jiraInstanceDeclarationForTool("jira.server-info");
  if (declaration === undefined) throw new TypeError("Missing server-info declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      version: "11.3",
      configuredBaseUrlState: "observed",
      configuredBaseUrl: "http://proxy.synthetic.invalid/context",
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      version: "11.3",
      configuredBaseUrlState: "unavailable",
    }),
  ).toBeUndefined();
  expect(declaration.descriptor.description).toContain(
    "never a trusted request or navigation destination",
  );
});

it.each([
  [
    "jira.server-info",
    {},
    {
      version: "11.4-SNAPSHOT",
      versionNumbers: [11, 4, 0],
      buildNumber: "9007199254740993",
      databaseBuildNumber: "0",
    },
  ],
  [
    "jira.instance-configuration",
    {},
    {
      watchingEnabled: false,
      timeTrackingConfiguration: {
        workingHoursPerDay: 7.5,
        workingDaysPerWeek: 0,
        defaultUnit: "hour",
        timeFormat: "pretty",
      },
    },
  ],
  [
    "jira.permission-definitions",
    { startAt: 0, maxResults: 1 },
    {
      permissionsScope: "definitions",
      items: [{ key: "EDIT_ISSUE", nativeKey: "EDIT_ISSUES", id: "12", type: "PROJECT" }],
      startAt: 0,
      total: 2,
      nextStartAt: 1,
    },
  ],
  ["jira.myself", {}, { key: "synthetic-key", name: "Synthetic", active: false }],
] as const)(
  "declares observational %s without granting compatibility or permissions",
  (name, args, result) => {
    const declaration = jiraInstanceDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing instance declaration");
    expect(declaration.risk).toBe("read");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...result,
      }),
    ).toBeUndefined();
    const connection = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
  },
);
it.each([
  ["jira.server-info", { verify: true }],
  ["jira.instance-configuration", { watchingEnabled: true }],
  ["jira.permission-definitions", { havePermission: true }],
  ["jira.myself", { username: "another-user" }],
] as const)("refuses unreviewed %s selectors", (name, args) => {
  const declaration = jiraInstanceDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing instance declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.server-info", { version: "11.3.13", buildNumber: 9007199254740992 }],
  ["jira.server-info", { version: "11.3.13", buildNumber: "01" }],
  ["jira.server-info", { version: "11.3.13", versionNumbers: [] }],
  ["jira.server-info", { version: "11.3.13", compatibility: { restApi: "v2" } }],
  ["jira.instance-configuration", { watchingEnabled: "false" }],
  ["jira.instance-configuration", { timeTrackingConfiguration: { defaultUnit: "month" } }],
  [
    "jira.permission-definitions",
    { permissionsScope: "effective", items: [], startAt: 0, total: 0 },
  ],
  [
    "jira.permission-definitions",
    {
      permissionsScope: "definitions",
      items: [{ key: "PLUGIN_PERMISSION", type: "PLUGIN" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.permission-definitions",
    {
      permissionsScope: "definitions",
      items: [{ key: "EDIT_ISSUES", havePermission: true }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.myself",
    { key: "synthetic-key", name: "Synthetic", emailAddress: "synthetic@example.invalid" },
  ],
] as const)("rejects unsupported %s result claims", (name, result) => {
  const declaration = jiraInstanceDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing instance declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it("reuses the existing directory user result contract for myself", () => {
  const myself = jiraInstanceDeclarationForTool("jira.myself");
  if (myself === undefined) throw new TypeError("Missing myself declaration");
  expect(
    describeCatalogSchemaMismatch(JIRA_DIRECTORY_READ_DEFINITIONS["jira.user"].result, {
      outcome: "succeeded",
      key: "synthetic-key",
      name: "Synthetic",
      deleted: false,
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(myself.descriptor.resultSchema, {
      outcome: "succeeded",
      key: "synthetic-key",
      name: "Synthetic",
      deleted: false,
    }),
  ).toBeUndefined();
});
