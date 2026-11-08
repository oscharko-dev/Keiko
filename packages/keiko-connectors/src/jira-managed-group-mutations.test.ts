import { describe, expect, it } from "vitest";
import { GROUP_MUTATION_FIXTURE_CASES, GROUP_MUTATION_USER, groupMutationFixture } from "../../../tests/support/jira-group-mutation-fixture.js";
import { executeJiraGroupMutation as execute } from "./jira-managed-group-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readGroupMutationMembership } from "./jira-group-mutation-observations.js";

const add = GROUP_MUTATION_FIXTURE_CASES[2];
const remove = GROUP_MUTATION_FIXTURE_CASES[3];
describe("native administration group lifecycle and direct membership", () => {
  it.each(GROUP_MUTATION_FIXTURE_CASES)("sends one exact native effect for $name", async ({ name, args, method, path, body, receipt, confirmed }) => {
    const f = groupMutationFixture(name === "jira.remove-group-user");
    const result = await execute(name, structuredClone(args), f.request);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([{ path, method, body, expect: name === "jira.create-group" ? "json" : "none" }]);
    expect(result.receipt).toEqual(receipt);
    expect(result.ok).toBe(confirmed);
    expect(f.calls.at(-1)?.method).toBe("GET");
  });
  it.each(GROUP_MUTATION_FIXTURE_CASES)("preflights $name without effects", async ({ name, args }) => {
    const f = groupMutationFixture(name === "jira.remove-group-user"); const before = f.snapshot();
    expect(await execute(name, structuredClone(args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });
  it.each(GROUP_MUTATION_FIXTURE_CASES)("retains known requested target after lost $name ACK without replay", async ({ name, args, receipt }) => {
    const f = groupMutationFixture(name === "jira.remove-group-user"); f.controls.lostAck = true;
    expect(await execute(name, structuredClone(args), f.request)).toMatchObject({ ok: false, reason: "timeout", receipt });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it.each(GROUP_MUTATION_FIXTURE_CASES)("retains $name context after native readback permission loss", async ({ name, args, receipt }) => {
    const f = groupMutationFixture(name === "jira.remove-group-user"); f.controls.denyReadback = true;
    expect(await execute(name, structuredClone(args), f.request)).toMatchObject({ ok: false, reason: "permission-denied", receipt });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it("preserves the acknowledged cause and frozen target receipt", async () => {
    const f = groupMutationFixture(); f.controls.throwReadback = true;
    let observed: unknown;
    try { await execute(add.name, structuredClone(add.args), f.request); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(observed instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged error");
    expect(observed.cause).toBeInstanceOf(TypeError);
    expect(observed.receipt).toEqual(add.receipt);
    expect(Object.isFrozen(observed.receipt)).toBe(true);
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it("binds user key and username separately and sends only the native username", async () => {
    const f = groupMutationFixture(); await execute(add.name, structuredClone(add.args), f.request);
    const firstEffect = f.calls.findIndex((call) => call.method !== "GET");
    expect(f.calls.slice(0, firstEffect).map((call) => call.path)).toContain("user?username=Target+User");
    expect(f.calls.slice(0, firstEffect).map((call) => call.path)).toContain("user?key=target-key");
    expect(f.calls[firstEffect]?.body).toEqual({ name: "Target User" });
    const alias = groupMutationFixture(); alias.controls.aliasUser = true;
    expect(await execute(add.name, structuredClone(add.args), alias.request)).toMatchObject({ ok: false });
    expect(alias.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("refuses a changed actor before any native effect", async () => {
    const f = groupMutationFixture(); f.controls.actorKey = "different-actor";
    expect(await execute(add.name, structuredClone(add.args), f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each([add, remove])("refuses stale reviewed membership for $name", async ({ name, args }) => {
    const f = groupMutationFixture(name === "jira.add-group-user");
    expect(await execute(name, structuredClone(args), f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("never treats inherited/native observed membership as proof of a direct add no-op", async () => {
    const f = groupMutationFixture(true);
    expect(await execute(add.name, { ...add.args, expectedObservedMembership: true }, f.request)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("reports observed complete absence as a no-effect removal", async () => {
    const f = groupMutationFixture();
    expect(await execute(remove.name, { ...remove.args, expectedObservedMembership: false }, f.request)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("binds the optional restriction-transfer group and rejects the same target", async () => {
    const test = GROUP_MUTATION_FIXTURE_CASES[1]; const missing = groupMutationFixture(); missing.groups.delete("Replacement");
    expect(await execute(test.name, structuredClone(test.args), missing.request)).toMatchObject({ ok: false });
    expect(missing.calls.every((call) => call.method === "GET")).toBe(true);
    const same = groupMutationFixture();
    expect(await execute(test.name, { ...test.args, swapGroupName: test.args.groupName }, same.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(same.calls).toEqual([]);
  });
  it("does not turn a missing creation identity into name search or a replay", async () => {
    const test = GROUP_MUTATION_FIXTURE_CASES[0]; const f = groupMutationFixture(); f.controls.missingAckName = true;
    expect(await execute(test.name, structuredClone(test.args), f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: test.receipt });
    expect(f.calls.at(-1)?.path).toBe("group");
    expect(f.calls.at(-1)?.method).toBe("POST");
  });
  it("does not promote matching direct membership into effective-permission success", async () => {
    const f = groupMutationFixture();
    expect(await execute(add.name, structuredClone(add.args), f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: add.receipt });
    expect(f.members).toContainEqual(GROUP_MUTATION_USER);
  });
  it("keeps wrong acknowledged membership readback unconfirmed", async () => {
    const f = groupMutationFixture(); f.controls.wrongReadback = true;
    expect(await execute(add.name, structuredClone(add.args), f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: add.receipt });
  });
  it("reads a target on the second page and preserves exact inactive identity", async () => {
    const f = groupMutationFixture();
    f.members.push(...Array.from({ length: 55 }, (_, index) => ({ key: `other-key-${String(index)}`, name: `other-user-${String(index)}` })), { ...GROUP_MUTATION_USER, active: false });
    const value = await readGroupMutationMembership(f.request, { kind: "membership", actor: "synthetic-actor", name: "R&D team", user: GROUP_MUTATION_USER, expected: true, present: false });
    expect(value).toEqual({ ok: true, value: true });
    expect(f.calls.map((call) => call.path)).toEqual([
      "group/member?groupname=R%26D+team&includeInactiveUsers=true&startAt=0&maxResults=50",
      "group/member?groupname=R%26D+team&includeInactiveUsers=true&startAt=50&maxResults=50",
    ]);
  });
  it.each(["missing-page", "changed-total", "duplicate-key", "username-alias"] as const)("never infers absence from %s", async (problem) => {
    const f = groupMutationFixture();
    f.members.push(...Array.from({ length: 60 }, (_, index) => ({ key: `other-key-${String(index)}`, name: `other-user-${String(index)}` })));
    f.controls.memberPageChange = (body, start) => {
      if (problem === "missing-page" && start > 0) delete body.values;
      if (problem === "changed-total" && start > 0) body.total = 61;
      if (problem === "duplicate-key" && start > 0) body.values = [{ key: "other-key-0", name: "duplicate" }];
      if (problem === "username-alias" && start === 0) body.values = [{ key: "wrong-target-key", name: GROUP_MUTATION_USER.name }];
    };
    expect(await execute(add.name, structuredClone(add.args), f.request)).toMatchObject({ ok: false });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("refuses oversized complete membership instead of using the visible prefix", async () => {
    const f = groupMutationFixture();
    f.members.push(...Array.from({ length: 1001 }, (_, index) => ({ key: `other-${String(index)}`, name: `name-${String(index)}` })));
    expect(await execute(add.name, structuredClone(add.args), f.request)).toMatchObject({ ok: false });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each([
    { expectedActorKey: "synthetic-actor", groupName: "R&D team", user: GROUP_MUTATION_USER, expectedObservedMembership: false },
    { ...add.args, expectedObservedMembership: "false" },
    { ...add.args, user: { ...GROUP_MUTATION_USER, emailAddress: "ignored@example.invalid" } },
    { ...add.args, method: "DELETE" },
    { ...add.args, url: "https://other.invalid" },
  ])("refuses unsupported or incomplete input before any request", async (args) => {
    const f = groupMutationFixture();
    expect(await execute(add.name, args, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
});
