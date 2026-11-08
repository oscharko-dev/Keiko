import { describe, expect, it } from "vitest";
import { DIRECTORY_ACCESS_FIXTURE_CASES as CASES, DIRECTORY_ROLE_REVIEW, DIRECTORY_ROLE_TARGET, directoryAccessFixture } from "../../../tests/support/jira-directory-access-fixture.js";
import { executeJiraDirectoryAccessMutation as execute } from "./jira-managed-directory-access-mutations.js";
import { guardJiraDirectorySelfAccess } from "./jira-directory-self-access.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { parseDirectoryAccessInput } from "./jira-directory-access-values.js";

describe("governed directory configuration native operations", () => {
  it.each(CASES)("sends one exact $name effect and preserves its confirmation boundary", async (selected) => {
    const f = directoryAccessFixture(selected);
    const result = await execute(selected.name, selected.args, f.request, f.ports);
    expect(result).toMatchObject({
      ok: selected.confirmed, receipt: selected.receipt, ...(selected.confirmed ? {} : { reason: "unavailable" }),
    });
    expect(f.snapshot().effects).toBe(1);
    expect(JSON.stringify(result)).not.toContain("native-role-version");
    const effect = f.calls.find(({ method }) => method !== "GET");
    expect(effect).toMatchObject({ path: selected.path, method: selected.method });
    expect(f.calls.at(-1)?.method).toBe("GET");
  });
  it.each(CASES)("performs $name preflight without a native mutation", async (selected) => {
    const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, f.ports, true)).toEqual({ ok: true, receipt: {} });
    expect(f.snapshot().effects).toBe(0); expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it.each(CASES)("refuses missing native ports before $name reads or effects", async (selected) => {
    const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, undefined)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls).toEqual([]);
  });
  it.each(CASES)("retains exact known $name targets after lost ACK without retry", async (selected) => {
    const f = directoryAccessFixture(selected); f.controls.lostAck = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "timeout", receipt: selected.receipt });
    expect(f.snapshot().effects).toBe(1); expect(f.calls.at(-1)?.method).toBe(selected.method);
  });
  it.each(CASES)("retains $name acknowledgement on denied or throwing readback", async (selected) => {
    const denied = directoryAccessFixture(selected); denied.controls.denyReadback = true;
    const result = await execute(selected.name, selected.args, denied.request, denied.ports);
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", receipt: selected.receipt });
    expect(JSON.stringify(result)).not.toContain("Nothing was written");
    expect(denied.snapshot().effects).toBe(1);
    const thrown = directoryAccessFixture(selected); thrown.controls.throwReadback = true;
    await expect(execute(selected.name, selected.args, thrown.request, thrown.ports)).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    expect(thrown.snapshot().effects).toBe(1);
  });
  it.each(["missingVersion", "weakVersion", "missingGroups"] as const)("does not replace unavailable native role evidence: %s", async (control) => {
    const selected = CASES[0]; const f = directoryAccessFixture(selected); f.controls[control] = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false });
    expect(f.snapshot().effects).toBe(0);
  });
  it("rebinds selected configuration immediately before CAS and refuses concurrent drift", async () => {
    const selected = CASES[1]; const f = directoryAccessFixture(selected); f.controls.roleChangesBefore = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.snapshot().effects).toBe(0);
    expect(f.calls.filter(({ path }) => path === "applicationrole")).toHaveLength(2);
  });
  it("does not demand or replace unknown group metadata on an unselected role", async () => {
    const selected = CASES[1]; const f = directoryAccessFixture(selected); f.controls.unrelatedUnknownGroups = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: selected.receipt });
    expect(f.snapshot().effects).toBe(1);
    expect(f.snapshot().roles.find((role) => role.key === "jira-core")).toEqual({ key: "jira-core", groups: [], defaultGroups: [] });
  });
  it("does not refresh-and-retry a native 412", async () => {
    const selected = CASES[0]; const f = directoryAccessFixture(selected); f.controls.staleVersion = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict", receipt: selected.receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(f.calls.at(-1)?.method).toBe("PUT");
  });
  it("keeps group arrays as sets and native columns as ordered sequences with repetitions", async () => {
    const role = parseDirectoryAccessInput(CASES[0].name, { ...CASES[0].args, role: { expected: DIRECTORY_ROLE_REVIEW, value: { ...DIRECTORY_ROLE_TARGET, groups: ["R&D team", "jira-users"] } } });
    expect(role?.kind).toBe("roles");
    const selected = CASES[4]; const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: true });
    expect(f.snapshot().columns).toEqual(["status", "summary", "status"]);
  });
  it.each(CASES.slice(2))("binds user key and username independently before $name", async (selected) => {
    const f = directoryAccessFixture(selected); f.controls.wrongUser = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.snapshot().effects).toBe(0);
  });
  it("never invents effective membership from absent UserBean applicationRoles", async () => {
    const selected = CASES[2]; const f = directoryAccessFixture(selected);
    const result = await execute(selected.name, selected.args, f.request, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { applicationAccessRequested: true } });
    expect(f.calls.some(({ path }) => path.includes("expand="))).toBe(false);
    expect(f.snapshot().effects).toBe(1);
  });
  it("does not equate readable post-reset columns with proved default inheritance", async () => {
    const selected = CASES[5]; const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: { columnsResetRequested: true } });
    expect(f.snapshot().columns).toEqual(["summary", "status"]);
  });
  it.each([
    { role: { expected: { ...DIRECTORY_ROLE_REVIEW, groups: null }, value: DIRECTORY_ROLE_TARGET } },
    { role: { expected: DIRECTORY_ROLE_REVIEW, value: { ...DIRECTORY_ROLE_TARGET, defaultGroups: ["foreign-group"] } } },
    { role: { expected: DIRECTORY_ROLE_REVIEW, value: { ...DIRECTORY_ROLE_TARGET, key: "another-role" } } },
    { acceptGlobalPermissionChange: false }, { ifMatch: '"model-version"' }, { headers: { "If-Match": "*" } },
  ])("refuses incomplete role review and model transport widening", async (patch) => {
    const selected = CASES[0]; const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, { ...selected.args, ...patch }, f.request, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("admits explicit empty role sets without converting missing sets to empty", () => {
    expect(parseDirectoryAccessInput(CASES[0].name, { ...CASES[0].args, role: { expected: DIRECTORY_ROLE_REVIEW,
      value: { key: "jira-software", groups: [], defaultGroups: [] } } })?.kind).toBe("roles");
  });
  it("never confuses an unchanged ordered layout with a request that needs a write", async () => {
    const selected = CASES[4]; const f = directoryAccessFixture(selected);
    expect(await execute(selected.name, { ...selected.args, columns: selected.args.expectedColumns }, f.request, f.ports))
      .toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.snapshot().effects).toBe(0);
  });
  it.each(CASES)("rejects a changed actor before $name effects", async (selected) => {
    const f = directoryAccessFixture(selected); f.controls.actorChangesBefore = true;
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.snapshot().effects).toBe(0);
  });
});

it("refuses removing the connected actor's own native application access", async () => {
  const selected = CASES[3]; const f = directoryAccessFixture(selected);
  const request: typeof f.request = async (path, ...rest) => {
    if (path === "user?key=synthetic-actor" || path === "user?username=operator")
      return { ok: true, status: 200, body: { key: "synthetic-actor", name: "operator" } };
    return f.request(path, ...rest);
  };
  const outcome = await execute(selected.name, { ...selected.args, user: { key: "synthetic-actor", name: "operator" } }, request, f.ports);
  expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
  expect(JSON.stringify(outcome)).toContain("own access");
  expect(f.snapshot().effects).toBe(0);
});
it.each([false, true])("refuses single/bulk role updates that remove the actor's observed group (bulk=%s)", async (bulk) => {
  const selected = bulk ? CASES[1] : CASES[0]; const f = directoryAccessFixture(selected);
  const target = { expected: DIRECTORY_ROLE_REVIEW, value: { key: "jira-software", groups: [], defaultGroups: [] } };
  const args = { expectedActorKey: "synthetic-actor", acceptGlobalPermissionChange: true,
    ...(bulk ? { roles: [target] } : { role: target }) };
  const request: typeof f.request = async (path, ...rest) => path === "user?key=synthetic-actor&expand=groups"
    ? { ok: true, status: 200, body: { key: "synthetic-actor", name: "operator", groups: { size: 1, items: [{ name: "jira-users" }] } } }
    : f.request(path, ...rest);
  expect(await execute(selected.name, args, request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
  expect(f.snapshot().effects).toBe(0);
});

const REMOVED_ROLE_GROUP = {
  kind: "roles", actor: "synthetic-actor", bulk: false,
  roles: [{ expected: DIRECTORY_ROLE_REVIEW, value: { key: "jira-software", groups: [], defaultGroups: [] } }],
} as const;
it.each([true, false])("independently checks inherited role-group membership when user expansion omits it (member=%s)", async (member) => {
  const calls: string[] = [];
  const request: JiraMutationRequest = async (path, method = "GET") => {
    calls.push(path); expect(method).toBe("GET");
    if (path === "user?key=synthetic-actor&expand=groups") return { ok: true, status: 200,
      body: { key: "synthetic-actor", name: "operator", groups: { size: 0, items: [] } } };
    expect(path).toBe("group/member?groupname=jira-users&includeInactiveUsers=true&startAt=0&maxResults=50");
    return { ok: true, status: 200, body: { startAt: 0, maxResults: 50, total: member ? 1 : 0,
      values: member ? [{ key: "synthetic-actor", name: "operator" }] : [] } };
  };
  const result = await guardJiraDirectorySelfAccess(request, REMOVED_ROLE_GROUP, { key: "synthetic-actor", name: "operator" });
  if (member) expect(result).toMatchObject({ ok: false, reason: "conflict" });
  else expect(result).toBeUndefined();
  expect(calls).toHaveLength(2);
});
it("refuses removal when inherited-group membership cannot be completely read", async () => {
  const request: JiraMutationRequest = async (path) => path === "user?key=synthetic-actor&expand=groups"
    ? { ok: true, status: 200, body: { key: "synthetic-actor", name: "operator", groups: { size: 0, items: [] } } }
    : { ok: false, reason: "permission-denied", httpStatus: 403 };
  expect(await guardJiraDirectorySelfAccess(request, REMOVED_ROLE_GROUP, { key: "synthetic-actor", name: "operator" }))
    .toMatchObject({ ok: false, reason: "permission-denied" });
});
