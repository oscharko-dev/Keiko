import { describe, expect, it } from "vitest";
import { jiraRuntimeSettingsDetails } from "./jira-runtime-settings-presentation";

describe("observed scalar Jira runtime settings", () => {
  it.each([[true, "exposed"], [false, "notExposed"], [undefined, "exposureUnknown"]] as const)(
    "preserves JMX exposure %s without enabling monitoring", (exposed, suffix) => {
      expect(jiraRuntimeSettingsDetails("jira_jmx_metrics_exposed", { outcome: "succeeded", exposed })).toEqual([
        { facts: [], labels: ["chat.jira.runtimeSettings.exposureObservation", `chat.jira.runtimeSettings.${suffix}`] },
      ]);
    },
  );
  it.each([0, -1, 10000, Number.MIN_SAFE_INTEGER])("retains signed native limit %s literally", (limit) => {
    for (const tool of ["jira_search_max_aggregation_buckets", "jira_search_max_result_window"]) {
      const cards = jiraRuntimeSettingsDetails(tool, { outcome: "succeeded", limit });
      expect(cards[0]?.facts[0]?.value).toBe(String(limit));
      expect(cards[0]?.labels).toEqual(["chat.jira.runtimeSettings.limitObservation"]);
    }
  });
  it.each([undefined, null, "0", 0.5])("does not infer a limit from %s", (limit) => {
    const cards = jiraRuntimeSettingsDetails("jira_search_max_result_window", { outcome: "succeeded", limit });
    expect(cards[0]?.facts).toEqual([]);
    expect(cards[0]?.labels).toContain("chat.jira.runtimeSettings.limitUnknown");
  });
  it("does not turn a failed read into a setting observation", () => {
    expect(jiraRuntimeSettingsDetails("jira_jmx_metrics_exposed", { outcome: "failed", reason: "permission-denied" })).toEqual([]);
  });
});
