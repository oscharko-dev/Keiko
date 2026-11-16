import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_JOB_OBSERVATION_READ_DEFINITIONS,
  jiraJobObservationDeclarationForTool,
} from "./jiraJobObservationDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

it("admits all nine bounded job-observation schemas through the unchanged compiler", () => {
  expect(Object.keys(JIRA_JOB_OBSERVATION_READ_DEFINITIONS)).toHaveLength(9);
  for (const [name, definition] of Object.entries(JIRA_JOB_OBSERVATION_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraJobObservationDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  [
    "jira.reindex-status",
    {},
    { taskSelection: "active-or-latest", currentProgress: 0, currentSubTask: "", success: false },
  ],
  [
    "jira.reindex-progress",
    { taskId: "7" },
    {
      taskSelection: "selected-task",
      selectedTaskId: "7",
      currentProgress: -1,
      type: "FUTURE_NATIVE_TYPE",
    },
  ],
  ["jira.reindex-request", { requestId: "7" }, { id: "7", status: "FUTURE_NATIVE_STATE" }],
  [
    "jira.reindex-requests",
    { requestIds: ["7", "8"], maxResults: 1 },
    {
      requestScope: "selected-requests",
      requestedRequestIds: ["7", "8"],
      unreturnedRequestIds: ["8"],
      items: [{ id: "7", status: "COMPLETE" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira.upgrade-result",
    {},
    { upgradeState: "result", upgradeOutcome: "FAILED", duration: 0, message: "" },
  ],
  ["jira.upgrade-result", {}, { upgradeState: "running" }],
  ["jira.upgrade-result", {}, { upgradeState: "no-prior-result" }],
  [
    "jira.index-snapshots",
    {},
    { items: [{ absolutePath: "/remote/snapshot.zip", timestamp: 0 }], startAt: 0, total: 1 },
  ],
  [
    "jira.index-snapshots",
    { startAt: 999, maxResults: 1 },
    { items: [{ absolutePath: "/remote/snapshot.zip", timestamp: 0 }], startAt: 999, total: 1000 },
  ],
  ["jira.app-monitoring", {}, { enabled: false }],
  ["jira.ipd-monitoring", {}, {}],
  ["jira.jmx-metrics", {}, { metricsText: "metric.a\nmetric.b" }],
  ["jira.jmx-metrics", {}, { metricsText: "" }],
] as const)("declares %s as a truthful observation without starting work", (name, args, result) => {
  const declaration = jiraJobObservationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing job-observation declaration");
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
});
it.each([
  ["jira.reindex-status", { taskId: "0" }],
  ["jira.reindex-progress", { taskId: "7", start: true }],
  ["jira.reindex-request", {}],
  ["jira.reindex-requests", { requestIds: [] }],
  ["jira.reindex-requests", { requestIds: ["7", "7"] }],
  ["jira.reindex-requests", { requestIds: [7] }],
  ["jira.upgrade-result", { run: true }],
  ["jira.index-snapshots", { absolutePath: "/remote/snapshot.zip" }],
  ["jira.app-monitoring", { enabled: true }],
  ["jira.ipd-monitoring", { enabled: false }],
  ["jira.jmx-metrics", { metricName: "metric.a" }],
] as const)("refuses unreviewed %s selectors and effects", (name, args) => {
  const declaration = jiraJobObservationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing job-observation declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.reindex-status", { taskSelection: "active-or-latest", currentProgress: 0.5 }],
  ["jira.reindex-progress", { taskSelection: "selected-task", selectedTaskId: 7 }],
  [
    "jira.reindex-requests",
    { requestScope: "selected-requests", items: [{ status: "ACTIVE" }], startAt: 0, total: 1 },
  ],
  ["jira.reindex-requests", { nonexistentRequestIds: ["8"] }],
  ["jira.reindex-requests", { total: 1001 }],
  ["jira.upgrade-result", { upgradeState: "completed-successfully" }],
  ["jira.upgrade-result", { upgradeState: "result", duration: -1 }],
  ["jira.index-snapshots", { items: [{ absolutePath: "" }], startAt: 0, total: 1 }],
  [
    "jira.index-snapshots",
    { items: Array.from({ length: 101 }, () => ({ absolutePath: "/remote/snapshot.zip" })) },
  ],
  ["jira.index-snapshots", { total: 1001 }],
  ["jira.app-monitoring", { enabled: "false" }],
  ["jira.ipd-monitoring", { healthy: true }],
  ["jira.jmx-metrics", { metricsText: { "metric.a": 1 } }],
] as const)("refuses invented or malformed %s result facts", (name, result) => {
  const declaration = jiraJobObservationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing job-observation declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
it.each([
  ["jira.reindex-status", "/reindex"],
  ["jira.reindex-progress", "/reindex/progress"],
  ["jira.reindex-request", "/reindex/request/{requestId}"],
  ["jira.reindex-requests", "/reindex/request/bulk"],
  ["jira.upgrade-result", "/upgrade"],
  ["jira.index-snapshots", "/index-snapshot"],
  ["jira.app-monitoring", "/monitoring/app"],
  ["jira.ipd-monitoring", "/monitoring/ipd"],
  ["jira.jmx-metrics", "/monitoring/jmx/getAvailableMetrics"],
] as const)("binds %s to the exact read-only native identity", (name, path) => {
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    kind: "native",
    method: "GET",
    apiRoot: "/rest/api/2",
    pathTemplate: path,
    effects: ["remote-read"],
  });
});

it("keeps documented no-prior-task separate from selected identities and unavailable metrics", () => {
  const actual = jiraJobObservationDeclarationForTool("jira.reindex-status");
  if (actual === undefined) throw new TypeError("Missing reindex observation declaration");
  const value = {
    outcome: "succeeded",
    taskSelection: "active-or-latest",
    taskState: "no-prior-task",
  };
  expect(describeCatalogSchemaMismatch(actual.descriptor.resultSchema, value)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { ...value, currentProgress: 0 }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { ...value, success: false }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
      ...value,
      selectedTaskId: "7",
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
      ...value,
      taskSelection: "selected-task",
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(actual.descriptor.resultSchema, { ...value, outcome: "failed" }),
  ).toBeDefined();
});
