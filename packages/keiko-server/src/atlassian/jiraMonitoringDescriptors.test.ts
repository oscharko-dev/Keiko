import { expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  JIRA_MANAGED_ACTION_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_MONITORING_WRITE_DEFINITIONS,
  jiraMonitoringDeclarationForTool,
} from "./jiraMonitoringDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits the four fixed monitoring-write contracts through the unchanged schema guard", () => {
  expect(Object.keys(JIRA_MONITORING_WRITE_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_MONITORING_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraMonitoringDeclarationForTool(name)?.risk).toBe("write");
  }
});
it.each([
  [
    "jira.set-app-monitoring",
    { expectedEnabled: false, enabled: true },
    { monitoringEnabled: true },
  ],
  [
    "jira.set-app-monitoring",
    { expectedEnabled: true, enabled: false },
    { monitoringEnabled: false },
  ],
  [
    "jira.set-ipd-monitoring",
    { expectedEnabled: false, enabled: true },
    { monitoringEnabled: true },
  ],
  [
    "jira.set-ipd-monitoring",
    { expectedEnabled: true, enabled: false },
    { monitoringEnabled: false },
  ],
  ["jira.start-jmx-metrics", { expectedEnabled: false }, { jmxMetricsExposed: true }],
  ["jira.stop-jmx-metrics", { expectedEnabled: true }, { jmxMetricsExposed: false }],
] as const)("preserves explicit reviewed boolean state for %s", (name, args, receipt) => {
  const declaration = jiraMonitoringDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing monitoring declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  for (const outcome of ["succeeded", "succeeded-unconfirmed", "unknown"])
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome, ...receipt }),
    ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      ...receipt,
    }),
  ).toBeUndefined();
});
it.each([
  ["jira.set-app-monitoring", { enabled: true }],
  ["jira.set-ipd-monitoring", { expectedEnabled: false }],
  ["jira.set-app-monitoring", { expectedEnabled: "false", enabled: true }],
  ["jira.set-ipd-monitoring", { expectedEnabled: false, enabled: null }],
  ["jira.start-jmx-metrics", { expectedEnabled: false, enabled: true }],
  ["jira.stop-jmx-metrics", { expectedEnabled: true, force: true }],
  ["jira.start-jmx-metrics", { expectedEnabled: false, endpoint: "/monitoring/app" }],
] as const)("refuses missing or widened %s state-change inputs", (name, args) => {
  const declaration = jiraMonitoringDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing monitoring declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.set-app-monitoring", { monitoringEnabled: "true" }],
  ["jira.set-ipd-monitoring", { jmxMetricsExposed: true }],
  ["jira.start-jmx-metrics", { monitoringEnabled: true }],
  ["jira.stop-jmx-metrics", { jmxMetricsExposed: false, screenId: "7" }],
] as const)("refuses mismatched %s receipt fields", (name, receipt) => {
  const declaration = jiraMonitoringDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing monitoring declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...receipt,
    }),
  ).toBeDefined();
});
it.each([
  ["jira.set-app-monitoring", "/monitoring/app"],
  ["jira.set-ipd-monitoring", "/monitoring/ipd"],
  ["jira.start-jmx-metrics", "/monitoring/jmx/startExposing"],
  ["jira.stop-jmx-metrics", "/monitoring/jmx/stopExposing"],
] as const)("binds %s to its reviewed high-risk native POST", (name, pathTemplate) => {
  expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[JIRA_MANAGED_ACTION_TYPES[name]]).toBe("high");
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    method: "POST",
    apiRoot: "/rest/api/2",
    pathTemplate,
    effects: ["remote-read", "remote-write"],
    permissionPolicy: "instance-admin-monitoring-state-and-readback",
  });
  const connection = vi.fn();
  const executeMutation = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name], executeMutation).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
  expect(executeMutation).not.toHaveBeenCalled();
});
