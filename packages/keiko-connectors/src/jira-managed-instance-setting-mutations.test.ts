import { describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { INSTANCE_SETTING_FIXTURE_CASES as CASES, instanceSettingMutationFixture } from "../../../tests/support/jira-instance-setting-mutation-fixture.js";
import { executeJiraInstanceSettingMutation as execute } from "./jira-managed-instance-setting-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

describe("reviewed instance configuration writes", () => {
  it.each(CASES)("sends only the fixed $name PUT and reads independent configuration", async (test) => {
    const f = instanceSettingMutationFixture(); const result = await execute(test.name, structuredClone(test.args), f.request);
    expect(f.calls.filter(({ method }) => method !== "GET")).toEqual([{ path: test.path, method: "PUT", body: test.body, expect: "none" }]);
    expect(result.receipt).toEqual(test.receipt); expect(result.ok).toBe(test.confirmed);
    expect(f.calls.at(-1)?.method).toBe("GET");
    expect(JSON.stringify(result.receipt)).not.toContain("https:");
    expect(result.receipt).not.toHaveProperty("value");
  });
  it.each(CASES)("preflights $name without a state change", async (test) => {
    const f = instanceSettingMutationFixture(); const before = f.snapshot();
    expect(await execute(test.name, structuredClone(test.args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true); expect(f.snapshot()).toEqual(before);
  });
  it.each(CASES)("retains requested $name facts without replay after lost ACK", async (test) => {
    const f = instanceSettingMutationFixture(); f.controls.lostAck = true;
    expect(await execute(test.name, structuredClone(test.args), f.request)).toMatchObject({ ok: false, reason: "timeout", receipt: test.receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1); expect(f.calls.at(-1)?.method).toBe("PUT");
  });
  it.each(CASES)("does not confirm $name when fresh readback loses permission", async (test) => {
    const f = instanceSettingMutationFixture(); f.controls.denyReadback = true;
    expect(await execute(test.name, structuredClone(test.args), f.request)).toMatchObject({ ok: false, reason: "permission-denied", receipt: test.receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });
  it.each(CASES)("requires exact independent $name readback", async (test) => {
    const f = instanceSettingMutationFixture(); f.controls.wrongReadback = true;
    expect(await execute(test.name, structuredClone(test.args), f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: test.receipt });
  });
  it("rebinds the reviewed actor immediately before the effect", async () => {
    const f = instanceSettingMutationFixture(); let actorReads = 0;
    const request: JiraMutationRequest = async (path, method, body, expect) => {
      if (path === "myself" && ++actorReads === 2)
        return { ok: true, status: 200, body: { key: "other-actor", name: "operator" } };
      return f.request(path, method, body, expect);
    };
    expect(await execute(CASES[0].name, CASES[0].args, request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    expect(f.properties.get("jira.option.voting")).toBe("true");
  });
  it("retains only the requested target when the actor changes after an acknowledgement", async () => {
    const f = instanceSettingMutationFixture(); f.controls.actorChanges = true;
    expect(await execute(CASES[0].name, CASES[0].args, f.request)).toMatchObject({ ok: false, reason: "conflict", receipt: CASES[0].receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(f.calls.at(-1)?.path).toBe("myself");
  });
  it.each([200, 202, 204])("requires fresh configuration after readable status-only acknowledgement %s", async (status) => {
    const f = instanceSettingMutationFixture(); f.controls.acknowledgementStatus = status;
    expect(await execute(CASES[0].name, CASES[0].args, f.request)).toEqual({ ok: true, receipt: CASES[0].receipt });
    expect(f.calls.at(-1)?.path).toBe("application-properties?key=jira.option.voting");
  });
  it("accepts only one exact selected application row in either published response shape", async () => {
    const f = instanceSettingMutationFixture(); f.controls.propertyArray = true;
    expect(await execute(CASES[0].name, CASES[0].args, f.request)).toMatchObject({ ok: true });
    const bad = instanceSettingMutationFixture(); bad.controls.propertyArray = true; bad.controls.duplicateProperty = true;
    expect(await execute(CASES[0].name, CASES[0].args, bad.request)).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(bad.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it.each([null, undefined, false, "FALSE"])("does not coerce unavailable/non-native application value %j", async (value) => {
    const f = instanceSettingMutationFixture(); f.properties.set("jira.option.voting", value);
    expect(await execute(CASES[0].name, CASES[0].args, f.request)).toMatchObject({ ok: false });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("preserves a literal empty clone prefix and hashes exact native string bytes", async () => {
    const f = instanceSettingMutationFixture();
    expect(await execute(CASES[0].name, { expectedActorKey: "synthetic-actor", propertyKey: "jira.clone.prefix", expectedValue: "CLONE - ", value: "" }, f.request))
      .toEqual({ ok: true, receipt: { userKey: "synthetic-actor", propertyKey: "jira.clone.prefix", valueDigest: sha256Hex("") } });
    expect(f.calls.find(({ method }) => method === "PUT")?.body).toEqual({ id: "jira.clone.prefix", value: "" });
  });
  it("preserves ordered repetitions and copies caller column arrays before awaiting", async () => {
    const f = instanceSettingMutationFixture(); const expected = ["issuekey", "summary"]; const columns = ["summary", "issuekey", "summary"];
    const pending = execute(CASES[1].name, { expectedActorKey: "synthetic-actor", expectedColumns: expected, columns }, f.request);
    expected.reverse(); columns.splice(0, columns.length, "other");
    const result = await pending;
    expect(result).toEqual({ ok: true, receipt: CASES[1].receipt });
    expect(Object.isFrozen(result.receipt?.columnIds)).toBe(true);
    expect(f.state.columns).toEqual(["summary", "issuekey", "summary"]);
  });
  it("reserves the full 16 KiB receipt before reads or writes", async () => {
    const f = instanceSettingMutationFixture();
    const columns = Array.from({ length: 100 }, (_, index) => `${index}${"x".repeat(250)}`);
    expect(await execute(CASES[1].name, { ...CASES[1].args, columns }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("treats system columns as exact global configuration, not a user/filter layout", async () => {
    const f = instanceSettingMutationFixture();
    expect(await execute(CASES[1].name, { ...CASES[1].args, expectedColumns: ["summary", "issuekey"] }, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every(({ method, path }) => method === "GET" && !path.includes("filter/") && !path.includes("user/columns"))).toBe(true);
  });
  it.each([null, undefined, "false"])("refuses an unobserved read-only Boolean %j", async (value) => {
    const f = instanceSettingMutationFixture(); f.state.enabled = value;
    expect(await execute(CASES[3].name, CASES[3].args, f.request)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("can disable an observed flag without changing banner settings or claiming enforcement", async () => {
    const f = instanceSettingMutationFixture(); f.state.enabled = true;
    const result = await execute(CASES[3].name, { ...CASES[3].args, expectedEnabled: true, enabled: false }, f.request);
    expect(result).toEqual({ ok: true, receipt: { userKey: "synthetic-actor", readOnlyEnabled: false } });
    expect(f.state.message).toBe("Existing banner"); expect(result.receipt).not.toHaveProperty("writesBlocked");
  });
  it("keeps a matching base URL write unconfirmed and never routes to its target", async () => {
    const f = instanceSettingMutationFixture(); const result = await execute(CASES[2].name, CASES[2].args, f.request);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[2].receipt });
    expect(f.calls.map(({ path }) => path)).toEqual(["myself", "serverInfo", "myself", "settings/baseUrl", "myself", "serverInfo"]);
    expect(f.calls.every(({ path }) => !path.includes("://"))).toBe(true);
    expect(f.calls.find(({ method }) => method === "PUT")?.body).toBe(CASES[2].body);
  });
  it.each(["http://desired.invalid", "https://user:secret@desired.invalid", "https://desired.invalid?", "https://desired.invalid#", "https://desired.invalid\\context", "https://desired.invalid/\ud800"])("refuses unsafe desired URL %s before requests", async (baseUrl) => {
    const f = instanceSettingMutationFixture();
    expect(await execute(CASES[2].name, { ...CASES[2].args, baseUrl }, f.request)).toMatchObject({ ok: false, reason: "field-validation" }); expect(f.calls).toEqual([]);
  });
  it.each([
    [CASES[0].name, { ...CASES[0].args, propertyKey: "jira.home" }],
    [CASES[0].name, { ...CASES[0].args, value: "false" }],
    [CASES[1].name, { ...CASES[1].args, columns: [] }],
    [CASES[2].name, { ...CASES[2].args, confirmInstanceWide: false }],
    [CASES[3].name, { ...CASES[3].args, message: "new banner" }],
  ] as const)("refuses unsupported %s inputs", async (name, args) => {
    const f = instanceSettingMutationFixture(); expect(await execute(name, args, f.request)).toMatchObject({ ok: false, reason: "field-validation" }); expect(f.calls).toEqual([]);
  });
  it.each(CASES)("provides an explicit exact-state no-op for $name", async (test) => {
    const f = instanceSettingMutationFixture(); const args: CatalogJsonObject = { ...test.args };
    if (test.name === "jira.set-application-property") Reflect.set(args, "value", true);
    if (test.name === "jira.set-system-columns") Reflect.set(args, "columns", ["issuekey", "summary"]);
    if (test.name === "jira.set-instance-base-url") { f.state.baseUrl = CASES[2].body; Reflect.set(args, "expectedBaseUrl", CASES[2].body); }
    if (test.name === "jira.set-read-only-mode") Reflect.set(args, "enabled", false);
    expect(await execute(test.name, args, f.request)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("retains cause and target receipt for a post-ACK programming error", async () => {
    const f = instanceSettingMutationFixture(); f.controls.throwReadback = true; let thrown: unknown;
    try { await execute(CASES[1].name, CASES[1].args, f.request); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(thrown instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged error");
    expect(thrown.receipt).toEqual(CASES[1].receipt); expect(thrown.cause).toBeInstanceOf(Error);
    expect(Object.isFrozen(thrown.receipt.columnIds)).toBe(true);
  });
});
