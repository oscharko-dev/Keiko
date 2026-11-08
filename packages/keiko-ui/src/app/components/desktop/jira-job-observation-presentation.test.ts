import { expect, it } from "vitest";
import { jiraJobObservationDetails as details } from "./jira-job-observation-presentation";

it("shows observed zero progress and false success without declaring a task failed", () => {
  const [card] = details("jira_reindex_progress", {
    outcome: "succeeded", taskSelection: "selected-task", selectedTaskId: "7", currentProgress: 0, success: false,
  });
  expect(card?.facts).toContainEqual({ label: "chat.jira.jobs.nativeProgress", value: "0" });
  expect(card?.facts).toContainEqual({ label: "chat.jira.jobs.selectedTaskId", value: "7" });
  expect(card?.labels).toContain("chat.jira.jobs.successFalse");
  expect(card?.labels).not.toContain("chat.jira.jobs.progressUnknown");
});

it("labels missing progress and success instead of inventing zero or completion", () => {
  const [card] = details("jira_reindex_status", { outcome: "succeeded", taskSelection: "active-or-latest" });
  expect(card?.labels).toEqual(expect.arrayContaining([
    "chat.jira.jobs.activeOrLatest", "chat.jira.jobs.progressUnknown", "chat.jira.jobs.successUnknown",
  ]));
  expect(card?.facts).toEqual([]);
});

it("does not infer active-or-latest selection from an older result without selection metadata", () => {
  expect(details("jira_reindex_status", { outcome: "succeeded" })[0]?.labels).toContain("chat.jira.jobs.taskSelectionUnknown");
  expect(details("jira_reindex_status", { outcome: "succeeded" })[0]?.labels).not.toContain("chat.jira.jobs.activeOrLatest");
});

it("renders an explicit unselected no-prior-task observation without invented task metrics", () => {
  expect(details("jira_reindex_status", { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task" })).toEqual([
    { facts: [], labels: ["chat.jira.jobs.observation", "chat.jira.jobs.activeOrLatest", "chat.jira.jobs.noPriorTask"] },
  ]);
});

it.each(["jira_reindex_status", "jira_reindex_progress"])("does not reinterpret a selected task refusal for %s as no prior task", (tool) => {
  expect(details(tool, { outcome: "failed", reason: "not-found", taskSelection: "selected-task", selectedTaskId: "7" })).toEqual([]);
  expect(details(tool, { outcome: "succeeded", taskSelection: "selected-task", selectedTaskId: "7", taskState: "no-prior-task" })[0]?.labels)
    .not.toContain("chat.jira.jobs.noPriorTask");
});

it("keeps unreturned selected requests distinct from absent tasks and a paged row count", () => {
  const cards = details("jira_reindex_requests", {
    outcome: "succeeded", total: 2, requestedRequestIds: ["7", "8", "9"], unreturnedRequestIds: ["8"],
    items: [{ id: "9", status: "COMPLETE" }],
  });
  expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.jobs.returnedTotal", value: "2" });
  expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.jobs.unreturnedIds", value: "8" });
  expect(cards[1]?.labels).toContain("chat.jira.jobs.unreturnedMeaning");
  expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.jobs.requestId", value: "9" });
});

it("does not turn an omitted collection total into a known empty result", () => {
  expect(details("jira_reindex_requests", { outcome: "succeeded", items: [] })[0]).toEqual({
    facts: [], labels: ["chat.jira.jobs.observation", "chat.jira.jobs.totalUnknown"],
  });
});

it.each([
  ["running", "chat.jira.jobs.upgradeRunning"], ["no-prior-result", "chat.jira.jobs.noPriorUpgrade"],
] as const)("renders the native %s upgrade observation without made-up results", (upgradeState, label) => {
  expect(details("jira_upgrade_result", { outcome: "succeeded", upgradeState })).toEqual([
    { facts: [], labels: ["chat.jira.jobs.observation", label] },
  ]);
});

it("keeps the remote upgrade outcome and unknown duration unit visible", () => {
  const [card] = details("jira_upgrade_result", {
    outcome: "succeeded", upgradeState: "result", upgradeOutcome: "FAILED", duration: 0, message: "Migration failed",
  });
  expect(card?.facts).toContainEqual({ label: "chat.jira.jobs.upgradeOutcome", value: "FAILED" });
  expect(card?.facts).toContainEqual({ label: "chat.jira.jobs.nativeDuration", value: "0" });
  expect(card?.labels).toContain("chat.jira.jobs.durationUnitsUnknown");
  expect(card?.body).toBe("Migration failed");
});

it("renders remote snapshot metadata as text with unavailable time labelled", () => {
  const cards = details("jira_index_snapshots", {
    outcome: "succeeded", total: 1, items: [{ absolutePath: "/server/snapshots/archive.tar" }],
  });
  expect(cards[1]?.facts).toEqual([{ label: "chat.jira.jobs.remoteSnapshotPath", value: "/server/snapshots/archive.tar" }]);
  expect(cards[1]?.labels).toEqual(["chat.jira.jobs.remotePathOnly", "chat.jira.jobs.snapshotTimeUnknown"]);
});

it.each(["jira_app_monitoring", "jira_ipd_monitoring"])("preserves false versus unknown for %s", (tool) => {
  expect(details(tool, { outcome: "succeeded", enabled: false })[0]?.labels).toContain("chat.jira.jobs.monitoringDisabled");
  expect(details(tool, { outcome: "succeeded" })[0]?.labels).toContain("chat.jira.jobs.monitoringUnknown");
});

it("distinguishes a known empty metric description from an unavailable one", () => {
  expect(details("jira_jmx_metrics", { outcome: "succeeded", metricsText: "" })[0]?.labels).toContain("chat.jira.jobs.metricsEmpty");
  expect(details("jira_jmx_metrics", { outcome: "succeeded" })[0]?.labels).toContain("chat.jira.jobs.metricsUnknown");
  expect(details("jira_jmx_metrics", { outcome: "succeeded", metricsText: "metric.a\nmetric.b" })[0]?.body).toBe("metric.a\nmetric.b");
});

it("does not render a success card for a refusal or an unrelated tool", () => {
  expect(details("jira_jmx_metrics", { outcome: "failed", reason: "permission-denied" })).toEqual([]);
  expect(details("jira_reindex_start", { outcome: "succeeded" })).toEqual([]);
});
