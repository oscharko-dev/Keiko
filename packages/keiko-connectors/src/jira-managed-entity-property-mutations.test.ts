import { expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraEntityPropertyMutation as mutate,
  isJiraEntityPropertyMutation,
} from "./jira-managed-entity-property-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { BASE, ISSUE, PROPERTY_CASES as CASES, type PropertyScenario } from "./jira-property-test/_support.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";

const KEY = "review ~key";
const OLD = { old: "Before" };
const OLD_NODES: readonly CatalogJsonObject[] = [{ path: "", kind: "object", childCount: 1 }, { path: "/old", kind: "string", textValue: "Before" }];
const FALSE_NODES: readonly CatalogJsonObject[] = [{ path: "", kind: "boolean", booleanValue: false }];
const ACK: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
const ABSENT: AtlassianWriteHttpOutcome = { ok: false, reason: "not-found", httpStatus: 404 };
const ISSUE_SCENARIO = CASES.find((scenario) => scenario.prefix === "issue");
if (ISSUE_SCENARIO === undefined) throw new TypeError("Missing issue scenario");
const CANONICAL_PATHS: Readonly<Record<string, readonly string[]>> = {
  comment: ["issue/10002?fields=summary", "issue/10002/comment/9"],
  issue: ["issue/10002?fields=summary"], project: ["project/10000"], user: ["user?key=user-key"],
};
function reply(body: Record<string, unknown>): AtlassianWriteHttpOutcome { return { ok: true, status: 200, body }; }
function keys(...values: readonly string[]): AtlassianWriteHttpOutcome {
  return reply({ keys: values.map((key) => ({ key })) });
}
function value(value: unknown): AtlassianWriteHttpOutcome { return reply({ key: KEY, value }); }
function operation(prefix: string, remove = false): Parameters<typeof mutate>[0] {
  const name = `jira.${remove ? "delete" : "set"}-${prefix}-property`;
  if (!isJiraEntityPropertyMutation(name)) throw new TypeError("Unknown property mutation fixture");
  return name;
}
function propertyPath(scenario: PropertyScenario): string {
  const split = scenario.path.indexOf("?");
  const path = split < 0 ? scenario.path : scenario.path.slice(0, split);
  return `${path}/${encodeURIComponent(KEY)}${split < 0 ? "" : scenario.path.slice(split)}`;
}
function fixture(scenario: PropertyScenario, script: readonly (AtlassianWriteHttpOutcome | Error)[]) {
  const selected = port(script);
  const unused = port([]);
  return { selected, unused, ports: { platform: scenario.agile ? unused : selected,
    agile: scenario.agile ? selected : unused, baseUrl: BASE } };
}
function script(scenario: PropertyScenario, remove: boolean): readonly AtlassianWriteHttpOutcome[] {
  return [...scenario.admission.map(reply), keys(KEY), value(OLD), ACK,
    ...scenario.admission.map(reply), remove ? keys() : keys(KEY), remove ? ABSENT : value(false)];
}
function effects(selected: ReturnType<typeof port>) {
  return selected.mock.calls.filter(([, method]) => method !== undefined && method !== "GET");
}

it.each(CASES)("sets $prefix property once, preserving a literal false body and rebinding canonical identity", async (scenario) => {
  const f = fixture(scenario, script(scenario, false));
  expect(await mutate(operation(scenario.prefix), {
    ...scenario.args, propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES,
  }, f.ports)).toEqual({ ok: true, receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: true } });
  const path = propertyPath(scenario);
  expect(f.selected.mock.calls.map(([path]) => path)).toEqual([
    ...scenario.admissionPaths, scenario.path, path, path,
    ...(CANONICAL_PATHS[scenario.prefix] ?? scenario.admissionPaths), scenario.path, path,
  ]);
  expect(effects(f.selected)).toEqual([[path, "PUT", false, "none"]]);
  expect(f.unused).not.toHaveBeenCalled();
});

it.each(CASES)("deletes $prefix property only after complete reviewed value and two-source native absence proof", async (scenario) => {
  const f = fixture(scenario, script(scenario, true));
  expect(await mutate(operation(scenario.prefix, true), {
    ...scenario.args, propertyKey: KEY, expectedValueNodes: OLD_NODES,
  }, f.ports)).toEqual({ ok: true, receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: false } });
  expect(effects(f.selected)).toEqual([[propertyPath(scenario), "DELETE", undefined, "none"]]);
  expect(f.unused).not.toHaveBeenCalled();
});

it("requires complete keys plus native404 to admit explicitly reviewed absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(), ABSENT, ACK, reply(ISSUE), keys(KEY), value(null)]);
  expect(await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true, valueNodes: [{ path: "", kind: "null" }],
  }, f.ports)).toEqual({ ok: true, receipt: { issueId: "10002", issueKey: "SYN-2", propertyKey: KEY, propertyPresent: true } });
  expect(effects(f.selected)).toEqual([[propertyPath(ISSUE_SCENARIO), "PUT", null, "none"]]);
});

it("does not treat a present native null as absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(null)]);
  expect(await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true, valueNodes: FALSE_NODES,
  }, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
  expect(effects(f.selected)).toEqual([]);
});

it("preflights complete data without issuing PUT or DELETE", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD)]);
  expect(await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES,
  }, f.ports, true)).toEqual({ ok: true, receipt: {} });
  expect(effects(f.selected)).toEqual([]);
});

it("compares object data independently of key order and reports a real no-op", async () => {
  const observed = { count: 0, old: "Before" };
  const nodes: readonly CatalogJsonObject[] = [{ path: "", kind: "object", childCount: 2 },
    { path: "/old", kind: "string", textValue: "Before" }, { path: "/count", kind: "number", numberValue: 0 }];
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(observed)]);
  expect(await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: nodes, valueNodes: nodes,
  }, f.ports)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true },
    receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: true } });
  expect(effects(f.selected)).toEqual([]);
});

it.each([
  [keys(), value(OLD)], [keys(KEY), ABSENT], [keys(KEY), value({ old: "Changed" })],
] as const)("refuses inconsistent or stale native snapshots before an effect: %#", async (keyResponse, valueResponse) => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keyResponse, valueResponse]);
  expect((await mutate("jira.delete-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES,
  }, f.ports)).ok).toBe(false);
  expect(effects(f.selected)).toEqual([]);
});

it.each([
  reply({}), reply({ keys: null }),
  reply({ keys: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ key: String(index) })) }),
])("does not accept absent, malformed or truncated keys as a complete list: %#", async (keyResponse) => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keyResponse]);
  expect((await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true, valueNodes: FALSE_NODES,
  }, f.ports)).ok).toBe(false);
  expect(effects(f.selected)).toEqual([]);
});

it("refuses an unavailable value instead of inferring absence from a permission gap", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(), { ok: false, reason: "permission-denied", httpStatus: 403 }]);
  expect(await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true, valueNodes: FALSE_NODES,
  }, f.ports)).toEqual({ ok: false, reason: "permission-denied" });
  expect(effects(f.selected)).toEqual([]);
});

it("never invokes a supplied value accessor while admitting native property data", async () => {
  const getter = vi.fn(() => OLD);
  const body = Object.defineProperty({ key: KEY }, "value", { get: getter, enumerable: true });
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), reply(body)]);
  expect((await mutate("jira.delete-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES,
  }, f.ports)).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(effects(f.selected)).toEqual([]);
});

it("does not turn a missing parent after acknowledged deletion into confirmed property absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD), ACK, ABSENT]);
  expect(await mutate("jira.delete-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES,
  }, f.ports)).toMatchObject({ ok: false, reason: "not-found",
    receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: false } });
  expect(effects(f.selected)).toHaveLength(1);
});

it.each(CASES)("retains target-only receipt after a lost $prefix property acknowledgement without another effect", async (scenario) => {
  const f = fixture(scenario, [...scenario.admission.map(reply), keys(KEY), value(OLD), { ok: false, reason: "timeout" }]);
  expect(await mutate(operation(scenario.prefix), {
    ...scenario.args, propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES,
  }, f.ports)).toEqual({ ok: false, reason: "timeout",
    receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: true } });
  expect(effects(f.selected)).toHaveLength(1);
});

it("retains acknowledged context when canonical parent readback throws", async () => {
  const cause = new TypeError("Synthetic canonical parent readback failure");
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD), ACK, cause]);
  const failure = await mutate("jira.set-issue-property", {
    issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES,
  }, f.ports).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(failure).toMatchObject({ cause, receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: true } });
  expect(effects(f.selected)).toHaveLength(1);
});

it.each(["expectedValueNodes", "valueNodes"] as const)("preserves native UTF-8 bounds guidance for %s before any I/O", async (field) => {
  const f = fixture(ISSUE_SCENARIO, []);
  const args = { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES,
    valueNodes: FALSE_NODES, [field]: [{ path: "", kind: "string", textValue: "界".repeat(12000) }] };
  expect(await mutate("jira.set-issue-property", args, f.ports)).toMatchObject({ ok: false, reason: "field-validation",
    detail: { fieldId: field, validation: "bounds-exceeded", messages: [expect.stringContaining("32768 UTF-8")] } });
  expect(f.selected).not.toHaveBeenCalled();
});

it("refuses a native user key that URL encoding would silently replace", async () => {
  const user = CASES.find((scenario) => scenario.prefix === "user");
  if (user === undefined) throw new TypeError("Missing user scenario");
  const f = fixture(user, [reply({ key: "\ud800", name: "synthetic user" })]);
  expect((await mutate("jira.set-user-property", {
    ...user.args, propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES,
  }, f.ports)).ok).toBe(false);
  expect(f.selected).toHaveBeenCalledTimes(1);
  expect(effects(f.selected)).toEqual([]);
});

const INVALID: readonly CatalogJsonObject[] = [
  { issueIdOrKey: "syn-2", propertyKey: "a/b", expectAbsent: true, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: false, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: [] },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES, url: "https://untrusted.invalid" },
];
it.each(INVALID)("refuses unsupported or ambiguous property review inputs before any lookup: %#", async (args) => {
  const f = fixture(ISSUE_SCENARIO, []);
  expect((await mutate("jira.set-issue-property", args, f.ports)).ok).toBe(false);
  expect(f.selected).not.toHaveBeenCalled();
});

it("does not let delete claim an absent review or smuggle a replacement value", async () => {
  const selections: readonly CatalogJsonObject[] = [{ expectAbsent: true }, { expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES }];
  for (const args of selections) {
    const f = fixture(ISSUE_SCENARIO, []);
    expect((await mutate("jira.delete-issue-property", { issueIdOrKey: "syn-2", propertyKey: KEY, ...args }, f.ports)).ok).toBe(false);
    expect(f.selected).not.toHaveBeenCalled();
  }
});
