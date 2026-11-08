import { expect, it } from "vitest";
import { PERMISSION_SCHEME_MUTATION_CASES as CASES, PERMISSION_SCHEME_SNAPSHOT as SNAPSHOT,
  permissionSchemeMutationFixture as fixture } from "../../../tests/support/jira-permission-scheme-mutation-fixture.js";
import { executeJiraPermissionSchemeMutation as execute } from "./jira-managed-permission-scheme-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

it.each(CASES)("executes exactly one $tool effect and preserves independently reviewed native identity", async (selected) => {
  const f = fixture();
  const result = await execute(selected.tool, selected.args, f.ports);
  expect(result).toMatchObject(selected.tool === "jira.delete-permission-scheme"
    ? { ok: false, reason: "unavailable", receipt: selected.receipt } : { ok: true, receipt: selected.receipt });
  const writes = f.calls.filter(({ method }) => method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: selected.path, method: selected.method });
  expect(writes[0]?.body).toEqual(selected.body);
  if (selected.tool === "jira.set-permission-scheme-attribute") expect(writes[0]?.bodyText).toBe("false");
  expect(f.calls.at(-1)?.method).toBe("GET");
});
it.each(CASES)("$tool check performs the same reviewed admission without any write", async (selected) => {
  const f = fixture();
  const before = f.snapshot();
  expect(await execute(selected.tool, selected.args, f.ports, true)).toEqual({ ok: true, receipt: {} });
  expect(f.calls.some(({ method }) => method !== "GET")).toBe(false);
  expect(f.snapshot()).toEqual(before);
});
it.each(CASES)("does not repeat $tool after losing the acknowledgement to the applied change", async (selected) => {
  const f = fixture();
  f.controls.loseAck = true;
  expect(await execute(selected.tool, selected.args, f.ports)).toMatchObject({ ok: false, reason: "timeout" });
  expect(f.writes()).toBe(1);
  expect(f.calls.at(-1)?.method).not.toBe("GET");
});
it.each(CASES)("retains known $tool context when independent readback is denied", async (selected) => {
  const f = fixture();
  f.controls.denyReadback = true;
  expect(await execute(selected.tool, selected.args, f.ports)).toMatchObject({ ok: false, reason: "permission-denied", receipt: selected.receipt });
  expect(f.writes()).toBe(1);
});
it.each(CASES)("preserves $tool acknowledged state when the readback implementation throws", async (selected) => {
  const f = fixture();
  f.controls.throwReadback = true;
  await expect(execute(selected.tool, selected.args, f.ports)).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(f.writes()).toBe(1);
});
it.each(["actor", "name", "description", "permission", "holder", "grant-id", "additional-grant"])(
  "refuses a stale reviewed %s before a grant deletion", async (changed) => {
    const f = fixture();
    const scheme = f.schemes.get("7");
    const grants = f.grants.get("7");
    if (scheme === undefined || grants === undefined || grants[0] === undefined) throw new TypeError("Missing native fixture");
    if (changed === "actor") f.actor.key = "other-actor";
    if (changed === "name" || changed === "description") scheme[changed] = "Concurrent value";
    if (changed === "permission") grants[0].permission = "DELETE_ISSUES";
    if (changed === "holder") grants[0].holder = { type: "anyone" };
    if (changed === "grant-id") grants[0].id = "91";
    if (changed === "additional-grant") grants.push({ id: "93", permission: "WORK_ON_ISSUES", holder: { type: "assignee" } });
    expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.writes()).toBe(0);
  },
);
it.each(["missingGrants", "missingDescription", "wrongScheme"] as const)("refuses %s evidence before any effect", async (condition) => {
  const f = fixture();
  f.controls[condition] = true;
  expect(await execute(CASES[1].tool, CASES[1].args, f.ports)).toMatchObject({ ok: false });
  expect(f.writes()).toBe(0);
});
it("updates only metadata when permissions is absent, preserving exact grant IDs", async () => {
  const f = fixture();
  expect(await execute(CASES[1].tool, CASES[1].args, f.ports)).toMatchObject({ ok: true });
  expect(f.grants.get("7")).toEqual(SNAPSHOT.permissions);
  expect(f.calls.find(({ method }) => method === "PUT")?.body).toEqual({ description: "" });
});
it("treats an explicit empty replacement set as removal of every grant", async () => {
  const f = fixture();
  const args = { expectedActorKey: "synthetic-actor", expectedScheme: SNAPSHOT, permissions: [] };
  expect(await execute("jira.update-permission-scheme", args, f.ports)).toMatchObject({ ok: true });
  expect(f.grants.get("7")).toEqual([]);
  expect(f.calls.find(({ method }) => method === "PUT")?.body).toEqual({ permissions: [] });
});
it("confirms replacement values even when Jira assigns new grant identities", async () => {
  const f = fixture();
  const permissions = [{ permission: "BROWSE_PROJECTS", holder: { type: "anyone" } }];
  expect(await execute("jira.update-permission-scheme", { expectedActorKey: "synthetic-actor", expectedScheme: SNAPSHOT, permissions }, f.ports)).toMatchObject({ ok: true });
  expect(f.grants.get("7")).toEqual([{ id: "41", ...permissions[0] }]);
});
it.each(["jira.create-permission-scheme", "jira.add-permission-grant"] as const)("does not infer a missing %s ACK identity from names or matching grants", async (tool) => {
  const selected = CASES.find((item) => item.tool === tool);
  if (selected === undefined) throw new TypeError("Missing creation fixture");
  const f = fixture();
  f.controls.omitAckId = true;
  const result = await execute(tool, selected.args, f.ports);
  expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  expect(result.receipt).not.toHaveProperty(tool === "jira.create-permission-scheme" ? "schemeId" : "permissionId");
  expect(f.writes()).toBe(1);
});
it("does not treat selected404 as complete grant absence", async () => {
  const f = fixture();
  f.controls.absentReadback = true;
  expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: false, reason: "not-found", receipt: CASES[4].receipt });
  expect(f.writes()).toBe(1);
});
it("detects a concurrent retained grant change after deleting the selected ID", async () => {
  const f = fixture();
  f.controls.afterWrite = () => {
    const retained = f.grants.get("7")?.[0];
    if (retained === undefined) throw new TypeError("Missing retained fixture grant");
    retained.holder = { type: "anyone" };
  };
  expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[4].receipt });
});
it("refuses an unavailable attribute writer before reading actor or scheme", async () => {
  const f = fixture();
  expect(await execute(CASES[5].tool, CASES[5].args, { request: f.ports.request })).toMatchObject({ ok: false, reason: "unavailable" });
  expect(f.calls).toEqual([]);
});
it.each([null, undefined, "", "TRUE", "yes", false])("does not silently Boolean-coerce reviewed native attribute %j", async (value) => {
  const f = fixture();
  f.attributes.set("ADMINISTER_PROJECTS.extended.enabled", value);
  expect(await execute(CASES[5].tool, CASES[5].args, f.ports)).toMatchObject({ ok: false });
  expect(f.writes()).toBe(0);
});
it("preserves false as a value and reports a matching observed attribute without a write", async () => {
  const f = fixture();
  f.attributes.set("ADMINISTER_PROJECTS.extended.enabled", "false");
  expect(await execute(CASES[5].tool, { ...CASES[5].args, expectedValue: "false" }, f.ports)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt: { attributeEnabled: false } });
  expect(f.writes()).toBe(0);
});
it.each([
  { type: "anyone", parameter: "ignored" }, { type: "group" }, { type: "projectRole", parameter: "90071992547409931234" },
  { type: "plugin-holder", parameter: "selected" }, { type: "reporterWithCreatePermission" },
])("refuses unsupported or contradictory new holder %j without an effect", async (holder) => {
  const f = fixture();
  expect(await execute(CASES[3].tool, { ...CASES[3].args, grant: { permission: "ADD_COMMENTS", holder } }, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(f.calls).toEqual([]);
});
it.each(["a/b", "a\\b", "%25", ".", "..", "bad\u0000key", "bad\ud800key"])("refuses unsafe attribute path %j before lookup", async (attributeKey) => {
  const f = fixture();
  expect(await execute(CASES[5].tool, { ...CASES[5].args, attributeKey }, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(f.calls).toEqual([]);
});
it("does not claim scheme deletion is confirmed by an empty visible index", async () => {
  const f = fixture();
  expect(await execute(CASES[2].tool, CASES[2].args, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[2].receipt });
  expect(f.schemes.size).toBe(0);
  expect(f.calls.at(-1)).toEqual({ method: "GET", path: "permissionscheme" });
});
it.each([200, 202, 204])("uses independent retained-parent proof after a readable delete-grant ACK %i", async (status) => {
  const f = fixture();
  f.controls.writeStatus = status;
  expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: true, receipt: CASES[4].receipt });
  expect(f.calls.at(-1)).toEqual({ method: "GET", path: "permissionscheme/7/permission" });
  expect(f.writes()).toBe(1);
});
it("reports an already-present exact grant without another POST", async () => {
  const f = fixture();
  const grant = { permission: SNAPSHOT.permissions[0].permission, holder: SNAPSHOT.permissions[0].holder };
  expect(await execute(CASES[3].tool, { ...CASES[3].args, grant }, f.ports)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt: { permissionId: "21", grantPresent: true } });
  expect(f.writes()).toBe(0);
});
it.each([null, undefined])("refuses an unknown reviewed description %j, never converting it to an empty string", async (description) => {
  const f = fixture();
  const expectedScheme = description === undefined
    ? { id: SNAPSHOT.id, name: SNAPSHOT.name, permissions: SNAPSHOT.permissions }
    : { ...SNAPSHOT, description };
  expect(await execute(CASES[1].tool, { ...CASES[1].args, expectedScheme }, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(f.calls).toEqual([]);
});
it("refuses an incomplete reviewed grant set rather than silently deleting unseen permissions", async () => {
  const f = fixture();
  expect(await execute(CASES[1].tool, { ...CASES[1].args, expectedScheme: { ...SNAPSHOT, permissions: [SNAPSHOT.permissions[0]] }, permissions: [] }, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
  expect(f.writes()).toBe(0);
});
it("uses only fixed native routes when observed beans contain remote self URLs", async () => {
  const f = fixture();
  const scheme = f.schemes.get("7");
  const grant = f.grants.get("7")?.[0];
  if (scheme === undefined || grant === undefined) throw new TypeError("Missing fixed native fixture");
  scheme.self = "https://untrusted.invalid/scheme";
  grant.self = "https://untrusted.invalid/grant";
  expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: true });
  expect(f.calls.every(({ path }) => path === "myself" || path.startsWith("permissionscheme/7"))).toBe(true);
});
it("does not preserve unrelated newly-added grants as an apparently complete delete result", async () => {
  const f = fixture();
  f.controls.afterWrite = () => f.grants.get("7")?.push({ id: "93", permission: "DELETE_ISSUES", holder: { type: "anyone" } });
  expect(await execute(CASES[4].tool, CASES[4].args, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[4].receipt });
  expect(f.writes()).toBe(1);
});

it.each(["ADMINISTER_PROJECTS", "DELETE_ISSUES", "EDIT_ISSUES", "ADD_COMMENTS", "PLUGIN_UNKNOWN_PERMISSION"])("refuses a new anonymous %s grant before native reads or writes", async (permission) => {
  const f = fixture();
  expect(await execute("jira.add-permission-grant", { ...CASES[3].args,
    grant: { permission, holder: { type: "anyone" } } }, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(f.calls).toEqual([]);
});
it.each(["jira.create-permission-scheme", "jira.update-permission-scheme"] as const)("cannot smuggle anonymous writes in a complete %s grant replacement", async (operation) => {
  const f = fixture(); const selected = operation === "jira.create-permission-scheme" ? CASES[0] : CASES[1];
  expect(await execute(operation, { ...selected.args,
    permissions: [{ permission: "ADMINISTER_PROJECTS", holder: { type: "anyone" } }] }, f.ports))
    .toMatchObject({ ok: false, reason: "field-validation" });
  expect(f.calls).toEqual([]);
});
it("keeps an existing anonymous write grant readable and removable", async () => {
  const f = fixture();
  const unsafe = { id: "29", permission: "DELETE_ISSUES", holder: { type: "anyone" } };
  f.grants.set("7", [unsafe]);
  expect(await execute("jira.delete-permission-grant", { expectedActorKey: "synthetic-actor",
    expectedScheme: { ...SNAPSHOT, permissions: [unsafe] }, permissionId: "29" }, f.ports))
    .toMatchObject({ ok: true, receipt: { permissionId: "29", grantPresent: false } });
  expect(f.writes()).toBe(1);
});
