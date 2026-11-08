import { describe, expect, it } from "vitest";
import { IDENTITY_MUTATION_FIXTURE_CASES as CASES, identityMutationFixture } from "../../../tests/support/jira-identity-mutation-fixture.js";
import { executeJiraIdentityMutation as execute, isJiraIdentityMutation } from "./jira-managed-identity-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { identityPrerequisiteFailure } from "./jira-identity-mutation-values.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const writes = (fixture: ReturnType<typeof identityMutationFixture>) => fixture.calls.filter((call) => call.method !== "GET");
describe("bound native identity operations without model secrets", () => {
  it("never imports an unrelated prerequisite receipt into the identity result", () => {
    expect(identityPrerequisiteFailure({ ok: false, reason: "conflict", detail: { messages: ["Native identity changed"] },
      receipt: { filterId: "37", userKey: "different-owner" } })).toEqual({
      ok: false, reason: "conflict", detail: { messages: ["Native identity changed"] },
    });
  });
  it.each(CASES)("performs one fixed $name and keeps its independent confirmation boundary", async (selected) => {
    const f = identityMutationFixture(selected);
    const result = await execute(selected.name, selected.args, f.request, f.ports);
    expect(result).toMatchObject({ ok: selected.confirmed, receipt: selected.receipt });
    if (!selected.confirmed) expect(result).toMatchObject({ reason: "unavailable" });
    expect(writes(f)).toEqual([{ path: selected.path, method: selected.method, body: selected.body,
      expect: selected.name === "jira.create-user" ? "json" : "none" }]);
    expect(f.snapshot().effects).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/emailAddress|password|sessionCookie|authorization|native-token/u);
  });
  it.each(CASES)("prepares $name through the same readonly admission without effects", async (selected) => {
    const f = identityMutationFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, f.ports, true)).toMatchObject({ ok: true });
    expect(writes(f)).toEqual([]);
  });
  it.each(CASES.slice(0, 3))("refuses $name before every read when its fixed experimental port is missing", async (selected) => {
    const f = identityMutationFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, undefined)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls).toEqual([]);
  });
  it.each(CASES)("keeps one uncertain $name target after a lost ACK without replay", async (selected) => {
    const f = identityMutationFixture(selected); f.controls.lostAck = true;
    const result = await execute(selected.name, selected.args, f.request, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "timeout", receipt: { actorUserKey: "synthetic-actor" } });
    if (selected.name === "jira.create-user") expect(result).toMatchObject({ receipt: { userPresent: true } });
    else expect(result).toMatchObject({ receipt: selected.receipt });
    expect(writes(f)).toHaveLength(1);
  });
  it.each(["password", "currentPassword", "newPassword", "licenseString", "cookie", "headers", "url"])("refuses model field %s before any request", async (key) => {
    const selected = CASES[0]; const f = identityMutationFixture(selected);
    expect(await execute(selected.name, { ...selected.args, [key]: "must-not-leave" }, f.request, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("never turns a passwordless create into default-access or credential-delivery confirmation", async () => {
    const f = identityMutationFixture(CASES[0]);
    expect(await execute(CASES[0].name, CASES[0].args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[0].receipt });
    expect(writes(f)[0]?.body).toEqual({ name: "new-user", emailAddress: "new@example.invalid", displayName: "New user" });
    expect(writes(f)[0]?.body).not.toHaveProperty("password");
    expect(writes(f)[0]?.body).not.toHaveProperty("applicationKeys");
  });
  it("keeps a created native identity if independent readback throws", async () => {
    const f = identityMutationFixture(CASES[0]); f.controls.throwReadback = true;
    const effect = execute(CASES[0].name, CASES[0].args, f.request, f.ports);
    await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    await expect(effect).rejects.toMatchObject({ receipt: CASES[0].receipt });
    expect(writes(f)).toHaveLength(1);
  });
  it("does not resolve a missing create ACK by name search or infer a user key", async () => {
    const f = identityMutationFixture(CASES[0]); f.controls.missingAckIdentity = true;
    const result = await execute(CASES[0].name, CASES[0].args, f.request, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { actorUserKey: "synthetic-actor", userPresent: true } });
    expect(result.receipt).not.toHaveProperty("userKey");
    expect(f.calls.at(-1)?.method).toBe("POST");
  });
  it.each(["wrongUser", "staleUser"] as const)("refuses exact user drift %s before PUT", async (control) => {
    const f = identityMutationFixture(CASES[1]); f.controls[control] = true;
    expect(await execute(CASES[1].name, CASES[1].args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(f)).toEqual([]);
  });
  it("preserves explicit inactive false but never infers all access consequences", async () => {
    const selected = { ...CASES[1], args: { ...CASES[1].args, active: false, acceptUnverifiedAccess: true }, body: { displayName: "Updated user", active: false } };
    const f = identityMutationFixture(selected);
    expect(await execute(selected.name, selected.args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: { userActive: false } });
    expect(f.snapshot().user.active).toBe(false);
  });
  it("requires an observed active field instead of defaulting missing metadata", async () => {
    const f = identityMutationFixture(CASES[1]); delete f.user.active;
    expect(await execute(CASES[1].name, CASES[1].args, f.request, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(f)).toEqual([]);
  });
  it("does not claim deletion from a shadowing user or a later 404", async () => {
    const f = identityMutationFixture(CASES[2]); f.controls.shadowDeletedUser = true;
    expect(await execute(CASES[2].name, CASES[2].args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[2].receipt });
    expect(f.calls.at(-1)?.method).toBe("DELETE");
  });
  it.each([
    { success: false }, { businessLogicValidationFailed: true }, { errors: { GENERAL: { errorMessages: ["Native failure"] } } },
    { warnings: { GENERAL: { errorMessages: ["Native warning"] } } }, { userKey: "different-user" }, { userName: "Different user" },
    { operations: ["USER_DISABLE"] }, { operations: ["USER_DISABLE", "USER_DISABLE", "USER_NAME_CHANGE"] }, { errors: undefined },
  ])("refuses unavailable, failed or changed native anonymization validation %#", async (delta) => {
    const f = identityMutationFixture(CASES[4]); Object.assign(f.validation, delta);
    expect(await execute(CASES[4].name, CASES[4].args, f.request, f.ports)).toMatchObject({ ok: false });
    expect(writes(f)).toEqual([]);
  });
  it("does not change the ownership recipient to an unknown/inactive user", async () => {
    const f = identityMutationFixture(CASES[4]); delete f.owner.active;
    expect(await execute(CASES[4].name, CASES[4].args, f.request, f.ports)).toMatchObject({ ok: false });
    expect(writes(f)).toEqual([]);
  });
  it("never follows job progress or response locations after scheduling", async () => {
    const f = identityMutationFixture(CASES[5]);
    expect(await execute(CASES[5].name, CASES[5].args, f.request, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[5].receipt });
    expect(f.calls.at(-1)?.path).toBe("user/anonymization/rerun");
    expect(f.calls.some((call) => call.path.includes("progress"))).toBe(false);
  });
  it.each(["bad/name", "bad%name", "bad\\name", ".."])("refuses unsupported session path selector %s before reads", async (name) => {
    const f = identityMutationFixture(CASES[3]);
    const args: CatalogJsonObject = { ...CASES[3].args, user: { key: "target-user", name } };
    expect(await execute(CASES[3].name, args, f.request, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("does not advertise unbound secret/session/unlock capabilities", () => {
    for (const name of ["jira.set-user-password", "jira.validate-license", "jira.login", "jira.logout", "jira.unlock-anonymization"])
      expect(isJiraIdentityMutation(name)).toBe(false);
  });
});
