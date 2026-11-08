import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ROLE_MUTATION_FIXTURE_CASES, roleMutationFixture } from "../../../tests/support/jira-role-mutation-fixture.js";
import { executeJiraRoleMutation as execute } from "./jira-managed-role-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraRoleReviewActors, jiraRoleReviewSnapshot } from "./jira-role-mutation-values.js";

describe("reviewed global role and project actor mutations", () => {
  it.each(ROLE_MUTATION_FIXTURE_CASES)("sends one exact native effect for $name", async ({ name, args, method, path, body, receipt, confirmed }) => {
    const f = roleMutationFixture();
    const result = await execute(name, structuredClone(args), f.request);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([{ path, method, body, expect: name === "jira.create-role" ? "json" : "none" }]);
    expect(result.receipt).toEqual(receipt);
    expect(result.ok).toBe(confirmed);
    expect(f.calls.at(-1)?.method).toBe("GET");
    if (!confirmed) expect(result).toMatchObject({ reason: "unavailable" });
  });
  it.each(ROLE_MUTATION_FIXTURE_CASES)("preflights $name without effects", async ({ name, args }) => {
    const f = roleMutationFixture();
    const before = f.snapshot();
    expect(await execute(name, structuredClone(args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });
  it.each(ROLE_MUTATION_FIXTURE_CASES)("preserves known context after lost $name ACK without replay/readback guessing", async ({ name, args, receipt }) => {
    const f = roleMutationFixture(); f.controls.lostAck = true;
    const result = await execute(name, structuredClone(args), f.request);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(result.receipt).toEqual(name === "jira.create-role" ? { userKey: "synthetic-actor", rolePresent: true } : receipt);
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it.each(ROLE_MUTATION_FIXTURE_CASES)("retains $name receipt when independent readback loses permission", async ({ name, args, receipt }) => {
    const f = roleMutationFixture(); f.controls.denyReadback = true;
    expect(await execute(name, structuredClone(args), f.request)).toMatchObject({ ok: false, reason: "permission-denied", receipt });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it("forwards a programming error's original cause with the acknowledged receipt", async () => {
    const f = roleMutationFixture(); f.controls.throwReadback = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[4];
    let thrown: unknown;
    try { await execute(test.name, test.args, f.request); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(thrown instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged error");
    expect(thrown.cause).toBeInstanceOf(Error);
    expect(thrown.receipt).toEqual(test.receipt);
    expect(Object.isFrozen(thrown.receipt)).toBe(true);
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it("accepts native default actors without invented role metadata", async () => {
    const f = roleMutationFixture();
    const test = ROLE_MUTATION_FIXTURE_CASES[1];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: true });
    expect(f.calls.filter((call) => call.path === "role/7/actors")).toHaveLength(2);
  });
  it.each(["omitActors", "omitActorType"] as const)("refuses unavailable %s before any write", async (flag) => {
    const f = roleMutationFixture(); f.controls[flag] = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[4];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("distinguishes missing description from reviewed null and explicit empty clear", async () => {
    const missing = roleMutationFixture(); const role = missing.roles.get("7");
    if (role === undefined) throw new TypeError("Missing fixture role");
    delete role.description;
    const test = ROLE_MUTATION_FIXTURE_CASES[2];
    expect(await execute(test.name, test.args, missing.request)).toMatchObject({ ok: false });
    expect(missing.calls.every((call) => call.method === "GET")).toBe(true);
    const nullable = roleMutationFixture(); const native = nullable.roles.get("7");
    if (native === undefined) throw new TypeError("Missing fixture role");
    native.description = null;
    expect(await execute(test.name, { ...test.args, expectedRole: { ...test.args.expectedRole, description: null } }, nullable.request))
      .toMatchObject({ ok: true });
    expect(nullable.roles.get("7")?.description).toBe("");
  });
  it("preserves omitted description on native partial POST and requires both fields on PUT", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[1];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: true });
    expect(f.roles.get("7")?.description).toBe("Reviewed description");
    const refused = roleMutationFixture();
    expect(await execute("jira.replace-role", test.args, refused.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(refused.calls).toEqual([]);
  });
  it("requires fresh metadata rather than trusting a successful update response", async () => {
    const f = roleMutationFixture(); f.controls.wrongReadback = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[1];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, receipt: test.receipt });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it.each(["malformedAck", "unsafeAck"] as const)("never locates a created ID by name after %s", async (flag) => {
    const f = roleMutationFixture(); f.controls[flag] = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[0];
    expect(await execute(test.name, test.args, f.request)).toEqual({ ok: false, reason: "malformed-payload", receipt: { userKey: "synthetic-actor", rolePresent: true } });
    expect(f.calls.at(-1)?.path).toBe("role");
    expect(f.calls.at(-1)?.method).toBe("POST");
    expect(f.roles.has("9007199254740993")).toBe(true);
  });
  it("independently reads known IDs after a bodyless successful update ACK", async () => {
    const f = roleMutationFixture(); f.controls.acknowledgementStatus = 204;
    const test = ROLE_MUTATION_FIXTURE_CASES[2];
    expect(await execute(test.name, test.args, f.request)).toEqual({ ok: true, receipt: test.receipt });
  });
  it("binds key and native username separately before sending only usernames", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[4];
    await execute(test.name, test.args, f.request);
    const effect = f.calls.findIndex((call) => call.method === "POST");
    expect(f.calls.slice(0, effect).map((call) => call.path)).toContain("user?username=next-user");
    expect(f.calls.slice(0, effect).map((call) => call.path)).toContain("user?key=next-key");
    expect(f.calls[effect]?.body).toEqual({ user: ["next-user"] });
  });
  it("refuses a user-key/username mismatch without name-based fallback", async () => {
    const f = roleMutationFixture(); f.controls.wrongUserKey = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[4];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("keeps identical user and group names in separate native namespaces", async () => {
    const f = roleMutationFixture(); f.groups.add("next-user");
    const test = ROLE_MUTATION_FIXTURE_CASES[4];
    const result = await execute(test.name, { ...test.args, principals: { users: [], groups: ["next-user"] } }, f.request);
    expect(result.receipt).toMatchObject({ actorUserKeys: [], actorGroupNames: ["next-user"] });
    expect(f.calls.find((call) => call.method === "POST")?.body).toEqual({ group: ["next-user"] });
    expect(f.calls.some((call) => call.path.startsWith("user?"))).toBe(false);
  });
  it("replaces both project namespaces with explicit empty arrays without touching defaults", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[7];
    const before = f.snapshot().defaultActors;
    const result = await execute(test.name, { ...test.args, principals: { users: [], groups: [] } }, f.request);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { actorUserKeys: [], actorGroupNames: [] } });
    expect(f.snapshot()).toMatchObject({ projectActors: [], defaultActors: before });
    expect(f.calls.find((call) => call.method === "PUT")?.body).toEqual({ id: 7, categorisedActors: { "atlassian-user-role-actor": [], "atlassian-group-role-actor": [] } });
  });
  it("does not replace a project alias with a changed project during confirmation", async () => {
    const f = roleMutationFixture(); f.controls.changeProjectAfter = true;
    const test = ROLE_MUTATION_FIXTURE_CASES[6];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: { projectId: "10000", projectKey: "SYN" } });
    expect(f.calls.filter((call) => call.path === "project/10000")).toHaveLength(1);
    expect(f.calls.some((call) => call.path.includes("OTHER"))).toBe(false);
  });
  it("preserves known deletion/swap targets without making a selected404 success", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[3];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: test.receipt });
    expect(f.roles.has("7")).toBe(false);
    expect(f.roles.has("9")).toBe(true);
  });
  it("refuses a changed replacement role and source=swap before DELETE", async () => {
    const test = ROLE_MUTATION_FIXTURE_CASES[3]; const f = roleMutationFixture();
    const role = f.roles.get("9"); if (role === undefined) throw new TypeError("Missing replacement"); role.name = "Changed";
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    const same = roleMutationFixture();
    expect(await execute(test.name, { ...test.args, expectedSwapRole: test.args.expectedRole }, same.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(same.calls).toEqual([]);
  });
  it("refuses stale assignment IDs even if the actor name is unchanged", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[4];
    const actor = f.defaults.get("7")?.[0]; if (actor === undefined) throw new TypeError("Missing default actor"); actor.id = "71";
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("returns metadata no-op without dispatch", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[1];
    expect(await execute(test.name, { ...test.args, name: "Synthetic role" }, f.request)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each<CatalogJsonObject>([
    { principals: { users: [{ key: "next-key", name: "next-user" }], groups: ["next-group"] } },
    { principals: { users: [], groups: [] } }, { principals: { users: [{ key: "next-key", name: "next-user" }, { key: "next-key", name: "other" }], groups: [] } },
    { url: "https://foreign.invalid" }, { method: "PUT" }, { principals: { users: [], groups: ["bad\ud800"] } },
  ])("refuses invalid actor inputs before reads: %j", async (patch) => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[4];
    expect(await execute(test.name, { ...test.args, ...patch }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("refuses unsafe numeric project PUT IDs before requests but permits lossless path IDs", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[7];
    expect(await execute(test.name, { ...test.args, expectedRole: { ...test.args.expectedRole, id: "9007199254740993" } }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
    expect(jiraRoleReviewSnapshot({ id: "9223372036854775807", name: "Maximum role", description: "" })?.id).toBe("9223372036854775807");
    expect(jiraRoleReviewSnapshot({ id: 9007199254740992, name: "Rounded", description: "" })).toBeUndefined();
  });
  it("rejects missing native actor identities and duplicate names within one namespace", () => {
    expect(jiraRoleReviewActors([{ name: "current-user" }])).toBeUndefined();
    expect(jiraRoleReviewActors([{ id: "1", type: "plugin-role-actor", name: "current-user" }])).toBeUndefined();
    expect(jiraRoleReviewActors([{ id: "1", type: "atlassian-user-role-actor", name: "current-user" }, { id: "2", type: "atlassian-user-role-actor", name: "current-user" }])).toBeUndefined();
  });
  it("reserves the bounded principal receipt before principal reads or native effects", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[4];
    const users = Array.from({ length: 50 }, (_, index) => ({ key: `${String(index)}${"\u754c".repeat(250)}`, name: `user-${String(index)}` }));
    expect(await execute(test.name, { ...test.args, principals: { users, groups: [] } }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(f.calls.some((call) => call.path.startsWith("user?"))).toBe(false);
  });
  it("snapshots caller-owned group arrays before asynchronous binding", async () => {
    const f = roleMutationFixture(); const test = ROLE_MUTATION_FIXTURE_CASES[4];
    const groups = ["next-group"];
    const request: typeof f.request = async (...args) => {
      if (args[0] === "myself") groups[0] = "foreign-group";
      return f.request(...args);
    };
    const result = await execute(test.name, { ...test.args, principals: { users: [], groups } }, request);
    expect(f.calls.find((call) => call.method === "POST")?.body).toEqual({ group: ["next-group"] });
    expect(result.receipt).toMatchObject({ actorGroupNames: ["next-group"] });
  });
});
