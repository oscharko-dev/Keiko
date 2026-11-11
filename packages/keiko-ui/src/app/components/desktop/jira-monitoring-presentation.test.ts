import { expect, it } from "vitest";
import {
  jiraMonitoringArgumentLabel,
  jiraMonitoringDetails as details,
  jiraMonitoringFixedTarget,
} from "./jira-monitoring-presentation";

it.each([
  ["jira_set_app_monitoring", "monitoringEnabled", true],
  ["jira_set_app_monitoring", "monitoringEnabled", false],
  ["jira_set_ipd_monitoring", "monitoringEnabled", true],
  ["jira_set_ipd_monitoring", "monitoringEnabled", false],
  ["jira_start_jmx_metrics", "jmxMetricsExposed", true],
  ["jira_stop_jmx_metrics", "jmxMetricsExposed", false],
] as const)("keeps %s's requested target separate from confirmed state", (tool, field, value) => {
  const confirmed = details(tool, { outcome: "succeeded", [field]: value })[0];
  if (confirmed === undefined) throw new TypeError("Missing confirmed monitoring result");
  expect(confirmed.labels).toContain("chat.jira.monitoring.confirmed");
  expect(confirmed.labels).toContain(
    value ? "chat.jira.monitoring.observedEnabled" : "chat.jira.monitoring.observedDisabled",
  );
  for (const outcome of ["unknown", "succeeded-unconfirmed", "rejected"]) {
    const pending = details(tool, { outcome, [field]: value })[0];
    if (pending === undefined) throw new TypeError("Missing uncertain monitoring result");
    expect(pending.labels).toContain("chat.jira.monitoring.targetUnconfirmed");
    expect(pending.labels).toContain(
      value ? "chat.jira.monitoring.targetEnabled" : "chat.jira.monitoring.targetDisabled",
    );
    expect(pending.labels).not.toContain("chat.jira.monitoring.confirmed");
    expect(pending.labels).not.toContain("chat.jira.monitoring.observedEnabled");
    expect(pending.labels).not.toContain("chat.jira.monitoring.observedDisabled");
  }
});
it("requires the exact rejected conflict marker to display an observed unchanged state", () => {
  const unchanged = details("jira_stop_jmx_metrics", {
    outcome: "rejected",
    reason: "conflict",
    unchanged: true,
    jmxMetricsExposed: false,
  })[0];
  expect(unchanged?.labels).toContain("chat.jira.monitoring.observedNoop");
  expect(unchanged?.labels).toContain("chat.jira.monitoring.observedDisabled");
  expect(unchanged?.labels).not.toContain("chat.jira.monitoring.confirmed");
  expect(
    details("jira_stop_jmx_metrics", {
      outcome: "unknown",
      unchanged: true,
      jmxMetricsExposed: false,
    })[0]?.labels,
  ).toContain("chat.jira.monitoring.targetUnconfirmed");
});
it("keeps omitted or unrelated receipt fields unknown and never renders metric contents or endpoints", () => {
  const result = details("jira_set_app_monitoring", {
    outcome: "succeeded",
    jmxMetricsExposed: true,
    metricsText: "Unrelated private metrics",
    url: "https://untrusted.invalid/metrics",
  });
  expect(result[0]?.labels).toContain("chat.jira.monitoring.stateUnknown");
  expect(result[0]?.labels).not.toContain("chat.jira.monitoring.confirmed");
  expect(result[0]?.facts).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("Unrelated private metrics");
  expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  expect(
    details("jira_start_jmx_metrics", { outcome: "succeeded", jmxMetricsExposed: false })[0]
      ?.labels,
  ).toContain("chat.jira.monitoring.stateUnknown");
  expect(
    details("jira_stop_jmx_metrics", { outcome: "succeeded", jmxMetricsExposed: true })[0]?.labels,
  ).toContain("chat.jira.monitoring.stateUnknown");
});
it("names the exact reviewed boolean and the fixed JMX target in approval facts", () => {
  expect(jiraMonitoringArgumentLabel("jira.set-app-monitoring", "expectedEnabled")).toBe(
    "chat.jira.monitoring.reviewedState",
  );
  expect(jiraMonitoringArgumentLabel("jira.set-ipd-monitoring", "enabled")).toBe(
    "chat.jira.monitoring.requestedState",
  );
  expect(jiraMonitoringArgumentLabel("jira.issue", "enabled")).toBeUndefined();
  expect(jiraMonitoringFixedTarget("jira.start-jmx-metrics")).toBe(true);
  expect(jiraMonitoringFixedTarget("jira.stop-jmx-metrics")).toBe(false);
  expect(jiraMonitoringFixedTarget("jira.set-app-monitoring")).toBeUndefined();
});
