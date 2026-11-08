import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraMaintenanceRead as read,
  isJiraMaintenanceRead,
  JIRA_MAINTENANCE_READS,
} from "./jira-managed-maintenance-reads.js";

function object(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function array(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
describe("one-demand native maintenance observations", () => {
  it("locally pages nodes, preserves signed native metadata and omits addresses and ports", async () => {
    const request = array([
      { nodeId: "node-a" },
      {
        nodeId: "node-b",
        state: "PASSIVE",
        alive: false,
        nodeBuildNumber: -1,
        nodeVersion: "11.3",
        lastStateChangeTimestamp: 0,
        ip: "192.0.2.1",
        cacheListenerPort: 40001,
      },
    ]);
    expect((await read("jira.cluster-nodes", { startAt: 1, maxResults: 1 }, request)).data).toEqual(
      {
        outcome: "succeeded",
        startAt: 1,
        total: 2,
        items: [
          {
            nodeId: "node-b",
            state: "PASSIVE",
            alive: false,
            nodeBuildNumber: -1,
            nodeVersion: "11.3",
            lastStateChangeTimestamp: 0,
          },
        ],
      },
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "cluster/nodes",
      "GET",
      undefined,
      "json-array",
    );
  });
  it("distinguishes an empty native node list from missing node metadata", async () => {
    expect((await read("jira.cluster-nodes", {}, array([]))).data).toEqual({
      outcome: "succeeded",
      items: [],
      startAt: 0,
      total: 0,
    });
    expect(
      (
        await read(
          "jira.cluster-nodes",
          {},
          array([{ nodeId: "node-a", alive: null, nodeVersion: null }]),
        )
      ).data.items,
    ).toEqual([{ nodeId: "node-a" }]);
  });
  it("retains the published upgrade-state example despite its disagreement with the enum", async () => {
    const request = object({
      state: "UPGRADE_IN_PROGRESS",
      build: { buildNumber: 0, version: "11.3" },
      available: true,
    });
    expect((await read("jira.cluster-upgrade-state", {}, request)).data).toEqual({
      outcome: "succeeded",
      state: "UPGRADE_IN_PROGRESS",
      build: { buildNumber: 0, version: "11.3" },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("cluster/zdu/state", "GET", undefined, "json");
  });
  it.each([true, false])(
    "observes native snapshot running=%s without starting a snapshot",
    async (running) => {
      const request = object({ running });
      expect((await read("jira.index-snapshot-status", {}, request)).data).toEqual({
        outcome: "succeeded",
        running,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "index-snapshot/isRunning",
        "GET",
        undefined,
        "json",
      );
    },
  );
  it("does not turn missing snapshot state or build metadata into false/zero", async () => {
    expect((await read("jira.index-snapshot-status", {}, object({ running: null }))).data).toEqual({
      outcome: "succeeded",
    });
    expect(
      (
        await read(
          "jira.cluster-upgrade-state",
          {},
          object({ state: null, build: { buildNumber: null, version: null } }),
        )
      ).data,
    ).toEqual({ outcome: "succeeded", build: {} });
  });
  it("keeps independent index counts and timestamp text without deriving health or differences", async () => {
    const request = object({
      nodeId: "node-a",
      reportTime: "2026-11-07T01:00:00Z",
      issueIndex: {
        indexReadable: false,
        countInArchive: 0,
        countInDatabase: 12,
        countInIndex: 11,
        lastUpdatedInDatabase: "2026-11-07T01:00:00Z",
        lastUpdatedInIndex: "2026-11-07T00:59:00Z",
      },
      self: "https://untrusted.invalid/index",
    });
    expect((await read("jira.index-summary", {}, request)).data).toEqual({
      outcome: "succeeded",
      nodeId: "node-a",
      reportTime: "2026-11-07T01:00:00Z",
      issueIndex: {
        indexReadable: false,
        countInArchive: 0,
        countInDatabase: 12,
        countInIndex: 11,
        lastUpdatedInDatabase: "2026-11-07T01:00:00Z",
        lastUpdatedInIndex: "2026-11-07T00:59:00Z",
      },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("index/summary", "GET", undefined, "json");
  });
  it("projects native node-keyed queues with their own timestamp names and signed operation IDs", async () => {
    const request = object({
      replicationQueues: {
        "node-b": {
          queueSize: 0,
          lastConsumedOperation: { id: -1, replicationTime: "native-time" },
          lastOperationInQueue: { id: 0 },
        },
      },
      externalPlatformIndexReplay: {
        "node-c": {
          queueSize: 4,
          lastConsumedOperation: { id: 2, journalWriteTime: "journal-time" },
          lastOperationInQueue: { id: 6, replicationTime: "not-this-DTO" },
        },
      },
    });
    expect((await read("jira.index-summary", {}, request)).data).toEqual({
      outcome: "succeeded",
      replicationQueues: [
        {
          nodeId: "node-b",
          queueSize: 0,
          lastConsumedOperation: { id: -1, replicationTime: "native-time" },
          lastOperationInQueue: { id: 0 },
        },
      ],
      externalPlatformIndexReplay: [
        {
          nodeId: "node-c",
          queueSize: 4,
          lastConsumedOperation: { id: 2, journalWriteTime: "journal-time" },
          lastOperationInQueue: { id: 6 },
        },
      ],
    });
  });
  it("distinguishes empty queue maps from unknown queues, counts and operations", async () => {
    expect(
      (
        await read(
          "jira.index-summary",
          {},
          object({
            replicationQueues: {},
            externalPlatformIndexReplay: null,
            issueIndex: { countInIndex: null },
          }),
        )
      ).data,
    ).toEqual({ outcome: "succeeded", replicationQueues: [], issueIndex: {} });
    expect(
      (
        await read(
          "jira.index-summary",
          {},
          object({
            replicationQueues: { "node-a": { queueSize: null, lastConsumedOperation: null } },
          }),
        )
      ).data.replicationQueues,
    ).toEqual([{ nodeId: "node-a" }]);
  });
  it.each(
    [
      [{ nodeId: "node-a" }, { nodeId: "node-a" }],
      [{ nodeId: "" }],
      [{ alive: true }],
      [{ nodeId: "node-a", alive: "true" }],
      [{ nodeId: "node-a", nodeBuildNumber: "1" }],
      [{ nodeId: "node-a", state: "" }],
      [{ nodeId: "node-a", lastStateChangeTimestamp: 0.5 }],
    ].map((items) => ({ items })),
  )("refuses malformed or duplicate node rows %j", async ({ items }) => {
    expect((await read("jira.cluster-nodes", {}, array(items))).data.reason).toBe(
      "malformed-payload",
    );
  });
  it.each([{ running: "false" }, { running: 0 }, { running: [] }])(
    "refuses malformed native snapshot objects %j",
    async (body) => {
      expect((await read("jira.index-snapshot-status", {}, object(body))).data.reason).toBe(
        "malformed-payload",
      );
    },
  );
  it.each([
    { issueIndex: { countInIndex: -1 } },
    { issueIndex: { countInDatabase: "0" } },
    { issueIndex: { indexReadable: 1 } },
    { replicationQueues: [] },
    { replicationQueues: { "": {} } },
    { replicationQueues: { "node-a": null } },
    { replicationQueues: { "node-a": { queueSize: -1 } } },
    {
      externalPlatformIndexReplay: { "node-a": { lastOperationInQueue: { journalWriteTime: "" } } },
    },
  ])("refuses malformed index observations %j", async (body) => {
    expect((await read("jira.index-summary", {}, object(body))).data.reason).toBe(
      "malformed-payload",
    );
  });
  it.each([
    { issueIndex: { countInIndex: Number.MAX_SAFE_INTEGER + 1 } },
    {
      replicationQueues: {
        "node-a": { lastOperationInQueue: { id: Number.MAX_SAFE_INTEGER + 1 } },
      },
    },
    { externalPlatformIndexReplay: { "node-a": { queueSize: Number.MAX_SAFE_INTEGER + 1 } } },
    { reportTime: "x".repeat(129) },
  ])("refuses out-of-bound index facts without rounding or truncating them %j", async (body) => {
    expect((await read("jira.index-summary", {}, object(body))).data.reason).toBe(
      "bounds-exceeded",
    );
  });
  it("refuses excessive native node and queue collections before projecting a partial status", async () => {
    const entries = Array.from(
      { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
      (_, i) => [`node-${i}`, {}] as const,
    );
    expect(
      (await read("jira.cluster-nodes", {}, array(entries.map(([nodeId]) => ({ nodeId }))))).data
        .reason,
    ).toBe("bounds-exceeded");
    expect(
      (
        await read(
          "jira.index-summary",
          {},
          object({ replicationQueues: Object.fromEntries(entries) }),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.cluster-nodes", { maxResults: 101 }],
    ["jira.cluster-nodes", { startAt: null }],
    ["jira.cluster-upgrade-state", { state: "STABLE" }],
    ["jira.index-snapshot-status", { start: true }],
    ["jira.index-summary", { nodeId: "remote-node" }],
  ] satisfies readonly [(typeof JIRA_MAINTENANCE_READS)[number], CatalogJsonObject][])(
    "rejects undeclared selectors or effects for %s",
    async (name, args) => {
      const request = object({});
      expect((await read(name, args, request)).data.reason).toBe("invalid-input");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(JIRA_MAINTENANCE_READS)(
    "retains the native permission refusal for %s without alternate endpoints",
    async (name) => {
      const request = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
      expect((await read(name, {}, request)).data.reason).toBe("permission-denied");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not register start, shutdown, upgrade or snapshot effects", () => {
    expect(isJiraMaintenanceRead("jira.index-snapshot-status")).toBe(true);
    expect(isJiraMaintenanceRead("jira.start-index-snapshot")).toBe(false);
    expect(isJiraMaintenanceRead("jira.cluster-shutdown")).toBe(false);
  });
});
