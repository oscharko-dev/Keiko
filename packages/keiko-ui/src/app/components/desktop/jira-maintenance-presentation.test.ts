import { describe, expect, it } from "vitest";
import { jiraMaintenanceDetails } from "./jira-maintenance-presentation";

describe("observed cluster and index status", () => {
  it("keeps node state text and signed timestamps without exposing network metadata", () => {
    const cards = jiraMaintenanceDetails("jira_cluster_nodes", { items: [{ nodeId: "node-A", state: "PASSIVE", alive: false,
      lastStateChangeTimestamp: 0, nodeBuildNumber: -1, ip: "192.0.2.10", cacheListenerPort: 40001 }] });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.maintenance.state", value: "PASSIVE" });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.maintenance.stateTimestamp", value: "0" });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.maintenance.build", value: "-1" });
    expect(cards[0]?.labels).toContain("chat.jira.maintenance.notAlive");
    expect(JSON.stringify(cards)).not.toMatch(/192\.0\.2\.10|40001/u);
  });
  it("does not fill missing node state, alive flag or timestamp", () => {
    const cards = jiraMaintenanceDetails("jira_cluster_nodes", { items: [{ nodeId: "node-A" }] });
    expect(cards[0]?.facts).toEqual([{ label: "chat.jira.maintenance.nodeId", value: "node-A" }]);
    expect(cards[0]?.labels).toEqual(["chat.jira.maintenance.observation", "chat.jira.maintenance.aliveUnknown",
      "chat.jira.maintenance.stateUnknown", "chat.jira.maintenance.stateTimestampUnknown"]);
  });
  it.each([true, false, undefined])("keeps the snapshot running observation %s distinct", (running) => {
    const labels = jiraMaintenanceDetails("jira_index_snapshot_status", { outcome: "succeeded", running })[0]?.labels;
    expect(labels).toContain(running === true ? "chat.jira.maintenance.snapshotRunning"
      : running === false ? "chat.jira.maintenance.snapshotNotRunning" : "chat.jira.maintenance.snapshotUnknown");
  });
  it("retains upgrade state as reported even when it is absent from a published enum", () => {
    expect(jiraMaintenanceDetails("jira_cluster_upgrade_state", { outcome: "succeeded", state: "READY_TO_UPGRADE", build: { version: "11.3.0", buildNumber: 0 } })[0]?.facts)
      .toContainEqual({ label: "chat.jira.maintenance.state", value: "READY_TO_UPGRADE" });
  });
  it("keeps explicit zero counts, unknown dimensions and known empty maps separate", () => {
    const cards = jiraMaintenanceDetails("jira_index_summary", { outcome: "succeeded", issueIndex: {
      indexReadable: false, countInIndex: 0, lastUpdatedInIndex: "2026-11-07T22:00:00+01:00",
    }, replicationQueues: [], externalPlatformIndexReplay: [] });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.maintenance.indexCount", value: "0" });
    expect(cards[1]?.labels).toContain("chat.jira.maintenance.countsUnknown");
    expect(cards[1]?.labels).toContain("chat.jira.maintenance.indexUnreadable");
    expect(cards[2]?.facts).toEqual([{ label: "chat.jira.maintenance.queuesReturned", value: "0" }]);
    expect(cards[3]?.facts).toEqual([{ label: "chat.jira.maintenance.replayReturned", value: "0" }]);
  });
  it("keeps absent native maps unknown instead of claiming empty queues", () => {
    const cards = jiraMaintenanceDetails("jira_index_summary", { outcome: "succeeded" });
    expect(cards.flatMap(({ facts }) => facts)).toEqual([]);
    expect(cards.flatMap(({ labels }) => labels)).toContain("chat.jira.maintenance.queuesUnknown");
    expect(cards.flatMap(({ labels }) => labels)).toContain("chat.jira.maintenance.replayUnknown");
  });
  it("preserves replication and journal times separately without calculating lag", () => {
    const cards = jiraMaintenanceDetails("jira_index_summary", { outcome: "succeeded", replicationQueues: [{
      nodeId: "node-A", queueSize: 0, lastConsumedOperation: { id: 0, replicationTime: "Replicated at 22:00" },
    }], externalPlatformIndexReplay: [{ nodeId: "node-B", lastOperationInQueue: { id: -1, journalWriteTime: "Journal at 21:00" } }] });
    const facts = cards.flatMap(({ facts }) => facts);
    expect(facts).toContainEqual({ label: "chat.jira.maintenance.consumedReplication", value: "Replicated at 22:00" });
    expect(facts).toContainEqual({ label: "chat.jira.maintenance.queuedJournal", value: "Journal at 21:00" });
    expect(facts).toContainEqual({ label: "chat.jira.maintenance.queuedId", value: "-1" });
  });
});
