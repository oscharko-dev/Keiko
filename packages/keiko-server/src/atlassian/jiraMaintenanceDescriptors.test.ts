import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_MAINTENANCE_READ_DEFINITIONS, jiraMaintenanceDeclarationForTool } from "./jiraMaintenanceDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits all four bounded maintenance observations through the existing compiler", () => {
  expect(Object.keys(JIRA_MAINTENANCE_READ_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_MAINTENANCE_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraMaintenanceDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.cluster-nodes", { startAt: 0, maxResults: 10 }, { items: [{ nodeId: "node1", state: "FUTURE_NATIVE_STATE", alive: false, nodeBuildNumber: 0, lastStateChangeTimestamp: -1 }], startAt: 0, total: 1 }],
  ["jira.cluster-upgrade-state", {}, { state: "UPGRADE_IN_PROGRESS", build: { buildNumber: 0, version: "11.3.0" } }],
  ["jira.cluster-upgrade-state", {}, {}],
  ["jira.index-snapshot-status", {}, { running: false }],
  ["jira.index-snapshot-status", {}, {}],
  ["jira.index-summary", {}, { nodeId: "node1", issueIndex: { indexReadable: false, countInArchive: 0 }, replicationQueues: [], externalPlatformIndexReplay: [] }],
  ["jira.index-summary", {}, { replicationQueues: [{ nodeId: "source1", queueSize: 0, lastConsumedOperation: { id: -1, replicationTime: "2026-11-07T00:00:00Z" } }], externalPlatformIndexReplay: [{ nodeId: "source2", lastOperationInQueue: { id: 1, journalWriteTime: "2026-11-07T00:00:00Z" } }] }],
  ["jira.index-summary", {}, {}],
] as const)("preserves supplied %s observations and unknown states", (name, args, result) => {
  const declaration = jiraMaintenanceDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing maintenance declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.cluster-nodes", { nodeId: "node1" }],
  ["jira.cluster-nodes", { maxResults: 101 }],
  ["jira.cluster-upgrade-state", { state: "STABLE" }],
  ["jira.index-snapshot-status", { start: true }],
  ["jira.index-summary", { reindex: true }],
  ["jira.index-summary", { startAt: 0 }],
] as const)("refuses %s mutation or invented paging arguments", (name, args) => {
  const declaration = jiraMaintenanceDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing maintenance declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.cluster-nodes", { items: [{ nodeId: "node1", ip: "192.0.2.1" }], startAt: 0, total: 1 }],
  ["jira.cluster-nodes", { items: [{ nodeId: "node1", nodeBuildNumber: Number.MAX_SAFE_INTEGER + 1 }], startAt: 0, total: 1 }],
  ["jira.cluster-upgrade-state", { state: "STABLE", readyToUpgrade: true }],
  ["jira.index-snapshot-status", { running: false, completed: true }],
  ["jira.index-summary", { issueIndex: { countInIndex: -1 } }],
  ["jira.index-summary", { replicationQueues: [{ nodeId: "node1", lastConsumedOperation: { journalWriteTime: "2026-11-07T00:00:00Z" } }] }],
  ["jira.index-summary", { externalPlatformIndexReplay: [{ nodeId: "node1", lastOperationInQueue: { replicationTime: "2026-11-07T00:00:00Z" } }] }],
  ["jira.index-summary", { healthy: true }],
] as const)("refuses unsupported %s facts and crossed queue DTOs", (name, result) => {
  const declaration = jiraMaintenanceDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing maintenance declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
it.each([
  ["jira.cluster-nodes", "/cluster/nodes"],
  ["jira.cluster-upgrade-state", "/cluster/zdu/state"],
  ["jira.index-snapshot-status", "/index-snapshot/isRunning"],
  ["jira.index-summary", "/index/summary"],
] as const)("binds %s to a single platform GET", (name, path) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({ kind: "native", method: "GET", apiRoot: "/rest/api/2", pathTemplate: path, effects: ["remote-read"] });
});
