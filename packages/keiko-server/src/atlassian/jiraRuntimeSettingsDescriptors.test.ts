import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS, jiraRuntimeSettingsDeclarationForTool } from "./jiraRuntimeSettingsDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits the three primitive observations through the existing schema compiler", () => {
  expect(Object.keys(JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS)).toHaveLength(3);
  for (const [name, definition] of Object.entries(JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraRuntimeSettingsDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.jmx-metrics-exposed", { exposed: false }],
  ["jira.jmx-metrics-exposed", { exposed: true }],
  ["jira.search-max-aggregation-buckets", { limit: 0 }],
  ["jira.search-max-aggregation-buckets", { limit: -1 }],
  ["jira.search-max-result-window", { limit: Number.MAX_SAFE_INTEGER }],
  ["jira.search-max-result-window", { limit: Number.MIN_SAFE_INTEGER }],
] as const)("preserves the %s observation without changing authority", (name, result) => {
  const declaration = jiraRuntimeSettingsDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing runtime settings declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {})).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.jmx-metrics-exposed", { exposed: "false" }],
  ["jira.jmx-metrics-exposed", { exposed: false, monitoringHealthy: true }],
  ["jira.search-max-aggregation-buckets", { limit: 0.5 }],
  ["jira.search-max-aggregation-buckets", { limit: Number.MAX_SAFE_INTEGER + 1 }],
  ["jira.search-max-result-window", { limit: "10000" }],
  ["jira.search-max-result-window", { limit: -1, unlimited: true }],
] as const)("refuses invented or inexact %s result claims", (name, result) => {
  const declaration = jiraRuntimeSettingsDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing runtime settings declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
it.each(Object.keys(JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS))("refuses all %s setting and target overrides", (name) => {
  const declaration = jiraRuntimeSettingsDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing runtime settings declaration");
  for (const args of [{ value: 1 }, { exposed: true }, { startAt: 0 }, { url: "https://untrusted.invalid" }])
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.jmx-metrics-exposed", "/monitoring/jmx/areMetricsExposed"],
  ["jira.search-max-aggregation-buckets", "/searchLimits/maxAggregationBuckets"],
  ["jira.search-max-result-window", "/searchLimits/maxResultWindow"],
] as const)("binds %s to its fixed native GET identity", (name, path) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({ kind: "native", method: "GET", apiRoot: "/rest/api/2", pathTemplate: path, effects: ["remote-read"] });
});
