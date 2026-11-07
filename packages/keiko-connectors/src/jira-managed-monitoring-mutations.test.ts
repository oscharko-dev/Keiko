import { expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { executeJiraMonitoringMutation as mutate, isJiraMonitoringMutation } from "./jira-managed-monitoring-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";

interface Scenario {
  readonly operation: Parameters<typeof mutate>[0];
  readonly read: string;
  readonly write: string;
  readonly before: boolean;
  readonly after: boolean;
  readonly scalar?: boolean;
  readonly input: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
}
const CASES: readonly Scenario[] = [
  { operation: "jira.set-app-monitoring", read: "monitoring/app", write: "monitoring/app", before: false, after: true,
    input: { expectedEnabled: false, enabled: true }, receipt: { monitoringEnabled: true } },
  { operation: "jira.set-ipd-monitoring", read: "monitoring/ipd", write: "monitoring/ipd", before: true, after: false,
    input: { expectedEnabled: true, enabled: false }, receipt: { monitoringEnabled: false } },
  { operation: "jira.start-jmx-metrics", read: "monitoring/jmx/areMetricsExposed", write: "monitoring/jmx/startExposing", before: false, after: true, scalar: true,
    input: { expectedEnabled: false }, receipt: { jmxMetricsExposed: true } },
  { operation: "jira.stop-jmx-metrics", read: "monitoring/jmx/areMetricsExposed", write: "monitoring/jmx/stopExposing", before: true, after: false, scalar: true,
    input: { expectedEnabled: true }, receipt: { jmxMetricsExposed: false } },
];
function state(scenario: Scenario, enabled: boolean): AtlassianWriteHttpOutcome {
  return scenario.scalar ? { ok: true, status: 200, body: undefined, scalar: enabled }
    : { ok: true, status: 200, body: { enabled } };
}
it.each(CASES)("performs $operation once and independently reads the requested native flag", async (scenario) => {
  const request = port([state(scenario, scenario.before), { ok: true, status: scenario.scalar ? 200 : 204, body: undefined }, state(scenario, scenario.after)]);
  expect(await mutate(scenario.operation, scenario.input, request)).toEqual({ ok: true, receipt: scenario.receipt });
  const expectShape = scenario.scalar ? "json-scalar" : "json";
  expect(request.mock.calls).toEqual([
    [scenario.read, "GET", undefined, expectShape],
    [scenario.write, "POST", scenario.scalar ? undefined : { enabled: scenario.after }, "none"],
    [scenario.read, "GET", undefined, expectShape],
  ]);
});

it.each(CASES)("preflights $operation without dispatching a POST", async (scenario) => {
  const request = port([state(scenario, scenario.before)]);
  expect(await mutate(scenario.operation, scenario.input, request, true)).toEqual({ ok: true, receipt: {} });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(CASES)("refuses stale reviewed state for $operation before writing", async (scenario) => {
  const request = port([state(scenario, scenario.after)]);
  expect(await mutate(scenario.operation, scenario.input, request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not assume an omitted app flag is false", async () => {
  const request = port([{ ok: true, status: 200, body: {} }]);
  expect(await mutate("jira.set-app-monitoring", { expectedEnabled: false, enabled: true }, request)).toEqual({ ok: false, reason: "malformed-payload" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("marks a known unchanged flag as a no-op with its observed false value", async () => {
  const request = port([{ ok: true, status: 200, body: { enabled: false } }]);
  expect(await mutate("jira.set-app-monitoring", { expectedEnabled: false, enabled: false }, request)).toMatchObject({
    ok: false, reason: "conflict", receipt: { monitoringEnabled: false }, detail: { unchanged: true },
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([200, 201, 202, 204])("uses independent state after a readable HTTP %i acknowledgement", async (status) => {
  const request = port([
    { ok: true, status: 200, body: { enabled: false } }, { ok: true, status, body: undefined },
    { ok: true, status: 200, body: { enabled: true } },
  ]);
  expect(await mutate("jira.set-app-monitoring", { expectedEnabled: false, enabled: true }, request)).toEqual({ ok: true, receipt: { monitoringEnabled: true } });
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});

it.each(CASES)("retains uncertainty after a lost $operation response without replaying it", async (scenario) => {
  const request = port([state(scenario, scenario.before), { ok: false, reason: "timeout" }]);
  expect(await mutate(scenario.operation, scenario.input, request)).toEqual({ ok: false, reason: "timeout", receipt: scenario.receipt });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});

it.each(CASES)("keeps denied $operation readback unconfirmed with no second POST", async (scenario) => {
  const request = port([state(scenario, scenario.before), { ok: true, status: 204, body: undefined },
    { ok: false, reason: "permission-denied", httpStatus: 403 }]);
  expect(await mutate(scenario.operation, scenario.input, request)).toEqual({ ok: false, reason: "permission-denied", receipt: scenario.receipt });
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});

it.each(CASES)("refuses to confirm $operation when the observed state did not change", async (scenario) => {
  const request = port([state(scenario, scenario.before), { ok: true, status: 204, body: undefined }, state(scenario, scenario.before)]);
  expect(await mutate(scenario.operation, scenario.input, request)).toEqual({ ok: false, reason: "conflict", receipt: scenario.receipt });
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});

it("preserves acknowledged state context when readback throws", async () => {
  const cause = new TypeError("Synthetic monitoring readback failure");
  const request = port([
    { ok: true, status: 200, body: undefined, scalar: false }, { ok: true, status: 200, body: undefined }, cause,
  ]);
  const failure = await mutate("jira.start-jmx-metrics", { expectedEnabled: false }, request).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(failure).toMatchObject({ cause, receipt: { jmxMetricsExposed: true } });
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});

it.each(CASES)("preserves native permission refusal before $operation", async (scenario) => {
  const request = port([{ ok: false, reason: "permission-denied", httpStatus: 403 }]);
  expect(await mutate(scenario.operation, scenario.input, request)).toEqual({ ok: false, reason: "permission-denied" });
  expect(request).toHaveBeenCalledTimes(1);
});

const INVALID: readonly [Parameters<typeof mutate>[0], CatalogJsonObject][] = [
  ["jira.set-app-monitoring", { enabled: true }], ["jira.set-ipd-monitoring", { expectedEnabled: false }],
  ["jira.set-app-monitoring", { expectedEnabled: "false", enabled: true }],
  ["jira.set-ipd-monitoring", { expectedEnabled: false, enabled: 1 }],
  ["jira.start-jmx-metrics", { expectedEnabled: false, enabled: true }],
  ["jira.stop-jmx-metrics", { expectedEnabled: true, url: "https://untrusted.invalid" }],
];
it.each(INVALID)("refuses unsupported %s inputs before transport", async (operation, args) => {
  const request = port([]);
  expect((await mutate(operation, args, request)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

it("recognizes only the four fixed monitoring mutation identities", () => {
  expect(isJiraMonitoringMutation("jira.set-ipd-monitoring")).toBe(true);
  expect(isJiraMonitoringMutation("constructor")).toBe(false);
  expect(isJiraMonitoringMutation("jira.reindex-start")).toBe(false);
});
