import { describe, expect, it } from "vitest";
import {
  PRIVATE_ACCOUNT_ACTOR as ACTOR,
  PRIVATE_ACCOUNT_WRITE_CASES as WRITES,
  PRIVATE_ACCOUNT_READ_CASES as READS,
  privateAccountFixture,
} from "../../../tests/support/jira-private-account-fixture.js";
import {
  executeJiraPrivateAccountMutation as execute,
  executeJiraPrivateAccountRead as read,
  isJiraPrivateAccountMutation,
  isJiraPrivateAccountRead,
} from "./jira-managed-private-account.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { privateAccountFailure } from "./jira-private-account-values.js";

describe("private actor-bound account operations", () => {
  it.each(WRITES)(
    "performs exactly one $name through its closed private port",
    async (selected) => {
      const f = privateAccountFixture();
      const result = await execute(selected.name, selected.args, f.request, f.ports);
      expect(result).toMatchObject({ ok: selected.confirmed, receipt: selected.receipt });
      if (!selected.confirmed) expect(result).toMatchObject({ reason: "unavailable" });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ action: selected.action, fields: selected.fields });
      expect(f.snapshot().privateCalls).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(
        /currentPassword|newPassword|licenseString|cookie|token|secretValue/u,
      );
    },
  );
  it.each(WRITES)(
    "previews $name without consuming protected input or requiring a private port",
    async (selected) => {
      const f = privateAccountFixture();
      expect(await execute(selected.name, selected.args, f.request, undefined, true)).toMatchObject(
        { ok: true },
      );
      expect(f.calls).toEqual([]);
      expect(f.reads.length).toBeGreaterThan(0);
    },
  );
  it.each(WRITES)(
    "does not replace a missing private port for $name with model credentials",
    async (selected) => {
      const f = privateAccountFixture();
      expect(await execute(selected.name, selected.args, f.request, undefined)).toMatchObject({
        ok: false,
        reason: "unavailable",
      });
      expect(f.calls).toEqual([]);
    },
  );
  it.each(WRITES)(
    "retains the bound target after a lost $name ACK without a second call",
    async (selected) => {
      const f = privateAccountFixture();
      f.setOutcome({ ok: false, reason: "timeout" });
      const result = await execute(selected.name, selected.args, f.request, f.ports);
      expect(result).toMatchObject({
        ok: false,
        reason: "timeout",
        receipt: {
          actorUserKey: selected.receipt.actorUserKey,
          userKey: selected.receipt.userKey,
          username: selected.receipt.username,
        },
      });
      expect(result.receipt).not.toHaveProperty("sessionEstablished");
      expect(f.calls).toHaveLength(1);
    },
  );
  it.each([
    "password",
    "currentPassword",
    "newPassword",
    "licenseString",
    "cookie",
    "sessionId",
    "inputRequestId",
    "headers",
    "url",
  ])("rejects model secret/selection field %s before any read", async (key) => {
    const f = privateAccountFixture();
    expect(
      await execute(WRITES[0].name, { ...WRITES[0].args, [key]: "untrusted" }, f.request, f.ports),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.reads).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it("binds explicit no-op to current metadata without protected input consumption", async () => {
    const f = privateAccountFixture();
    expect(
      await execute(
        "jira.update-myself",
        { ...WRITES[0].args, displayName: ACTOR.displayName },
        f.request,
        undefined,
      ),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      detail: { unchanged: true },
      receipt: WRITES[0].receipt,
    });
    expect(f.calls).toEqual([]);
    f.actor.displayName = "Concurrent change";
    const changed = await execute(
      "jira.update-myself",
      { ...WRITES[0].args, displayName: ACTOR.displayName },
      f.request,
      undefined,
    );
    expect(changed).toMatchObject({ ok: false, reason: "conflict" });
    expect(changed).not.toHaveProperty("detail.unchanged");
  });
  it("requires observed active state rather than defaulting it", async () => {
    const f = privateAccountFixture();
    delete f.actor.active;
    expect(await execute(WRITES[0].name, WRITES[0].args, f.request, f.ports)).toMatchObject({
      ok: false,
    });
    expect(f.calls).toEqual([]);
  });
  it("preserves inactive false as reviewed metadata without changing active state", async () => {
    const f = privateAccountFixture();
    f.actor.active = false;
    const args = { ...WRITES[0].args, expectedUser: { ...ACTOR, active: false } };
    expect(await execute("jira.update-myself", args, f.request, f.ports)).toMatchObject({
      ok: true,
    });
    expect(f.snapshot().actor.active).toBe(false);
  });
  it("refuses a shadowed target user and a non-self password target", async () => {
    const f = privateAccountFixture();
    f.controls.shadowUser = true;
    expect(await execute(WRITES[2].name, WRITES[2].args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(f.calls).toEqual([]);
    expect(
      await execute("jira.update-my-password", WRITES[2].args, f.request, f.ports),
    ).toMatchObject({ ok: false, reason: "field-validation" });
  });
  it("rechecks the actor immediately before consuming private input", async () => {
    const f = privateAccountFixture();
    f.controls.staleActorBeforeDispatch = true;
    expect(await execute(WRITES[3].name, WRITES[3].args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(f.calls).toEqual([]);
  });
  it("refuses inconsistent actor/profile usernames across independently read snapshots", async () => {
    const f = privateAccountFixture();
    const request: typeof f.request = async (path, method, body, expected) => {
      const response = await f.request(path, method, body, expected);
      return response.ok && f.reads.length === 1
        ? { ...response, body: { ...response.body, name: "concurrent-username" } }
        : response;
    };
    expect(await execute(WRITES[0].name, WRITES[0].args, request, f.ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(f.calls).toEqual([]);
  });
  it.each(["denyReadback", "wrongReadback"] as const)(
    "does not turn a profile ACK into confirmation after %s",
    async (control) => {
      const f = privateAccountFixture();
      f.controls[control] = true;
      expect(await execute(WRITES[0].name, WRITES[0].args, f.request, f.ports)).toMatchObject({
        ok: false,
        receipt: WRITES[0].receipt,
      });
      expect(f.calls).toHaveLength(1);
    },
  );
  it("retains known receipt and acknowledged phase when profile readback throws", async () => {
    const f = privateAccountFixture();
    f.controls.throwReadback = true;
    const effect = execute(WRITES[0].name, WRITES[0].args, f.request, f.ports);
    await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    await expect(effect).rejects.toMatchObject({ receipt: WRITES[0].receipt });
    expect(f.calls).toHaveLength(1);
  });
  it.each(WRITES)(
    "rebinds a private-port ACK error to the complete reviewed $name target",
    async (selected) => {
      const f = privateAccountFixture();
      const privateFailure = new JiraAcknowledgedMutationError(
        new TypeError("Synthetic post-ACK failure"),
        { actorUserKey: ACTOR.key, userKey: ACTOR.key, username: ACTOR.name },
      );
      const ports: typeof f.ports = {
        ...f.ports,
        perform: async (purpose, fields) => {
          await f.ports.perform(purpose, fields);
          throw privateFailure;
        },
        session: async (action, actor) => {
          await f.ports.session(action, actor);
          throw privateFailure;
        },
      };
      const effect = execute(selected.name, selected.args, f.request, ports);
      await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
      await expect(effect).rejects.not.toBe(privateFailure);
      await expect(effect).rejects.toHaveProperty("receipt", {
        actorUserKey: selected.receipt.actorUserKey,
        userKey: selected.receipt.userKey,
        username: selected.receipt.username,
      });
      await expect(effect).rejects.toHaveProperty("cause", privateFailure);
      if (selected.name === "jira.update-user-password")
        expect(selected.receipt.userKey).not.toBe(ACTOR.key);
      expect(f.calls).toHaveLength(1);
    },
  );
  it.each(["wrongSessionIdentity", "missingSessionProof"] as const)(
    "does not infer login success from %s",
    async (control) => {
      const f = privateAccountFixture();
      f.controls[control] = true;
      const result = await execute(WRITES[3].name, WRITES[3].args, f.request, f.ports);
      expect(result).toMatchObject({
        ok: false,
        reason: "unavailable",
        receipt: { actorUserKey: ACTOR.key },
      });
      expect(result.receipt).not.toHaveProperty("sessionEstablished");
    },
  );
  it.each([WRITES[4], WRITES[5]])(
    "passes the reviewed actor to the actual $name session boundary",
    async (selected) => {
      const f = privateAccountFixture();
      await execute(selected.name, selected.args, f.request, f.ports);
      expect(f.calls).toEqual([
        { action: selected.action, fields: {}, expectedActorKey: ACTOR.key },
      ]);
    },
  );
  it("does not reflect remote credential errors into a failure", async () => {
    const f = privateAccountFixture();
    f.setOutcome({
      ok: false,
      reason: "permission-denied",
      httpStatus: 403,
      remote: { messages: ["secretValue"] },
    });
    const result = await execute(WRITES[1].name, WRITES[1].args, f.request, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "permission-denied" });
    expect(JSON.stringify(result)).not.toContain("secretValue");
    expect(f.calls).toHaveLength(1);
  });
  it("does not copy unrelated prerequisite receipts", () => {
    const prerequisite = { reason: "unavailable", receipt: { filterId: "37" } } as const;
    expect(privateAccountFailure(prerequisite)).toEqual({ ok: false, reason: "unavailable" });
  });
  it("propagates programmer defects from an undispatched private port", async () => {
    const f = privateAccountFixture();
    const defect = new TypeError("Private port defect");
    const ports = {
      ...f.ports,
      perform: async () => {
        throw defect;
      },
    };
    await expect(execute(WRITES[1].name, WRITES[1].args, f.request, ports)).rejects.toBe(defect);
    expect(f.calls).toEqual([]);
  });
});

describe("native POST password/license validators remain reads", () => {
  it.each(READS)("calls only the fixed $name purpose with public context", async (selected) => {
    const f = privateAccountFixture();
    const result = await read(selected.name, selected.args, f.request, f.ports);
    expect(result.isError).not.toBe(true);
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      actorUserKey: ACTOR.key,
      validationScope: selected.scope,
      accepted: true,
      violationCount: 0,
    });
    expect(f.calls).toEqual([{ action: selected.purpose, fields: selected.fields }]);
    expect(isJiraPrivateAccountRead(selected.name)).toBe(true);
    expect(isJiraPrivateAccountMutation(selected.name)).toBe(false);
  });
  it.each(READS)(
    "preserves native policy refusal as a successful observation for $name",
    async (selected) => {
      const f = privateAccountFixture();
      Object.assign(f.validation, { accepted: false, violationCount: 2 });
      expect((await read(selected.name, selected.args, f.request, f.ports)).data).toMatchObject({
        outcome: "succeeded",
        accepted: false,
        violationCount: 2,
      });
    },
  );
  it.each([
    {},
    { accepted: true },
    { violationCount: 0 },
    { accepted: true, violationCount: 1 },
    { accepted: false, violationCount: 0 },
    { accepted: "true", violationCount: 0 },
    { accepted: true, violationCount: null },
  ])("refuses missing or contradictory sanitized native validation %#", async (body) => {
    const f = privateAccountFixture();
    f.setOutcome({ ok: true, status: 200, body });
    expect((await read(READS[0].name, READS[0].args, f.request, f.ports)).data).toMatchObject({
      outcome: "failed",
      reason: "malformed-payload",
    });
  });
  it.each([-1, 0.5, 1001, Number.POSITIVE_INFINITY])(
    "refuses unbounded native violation count %s",
    async (violationCount) => {
      const f = privateAccountFixture();
      Object.assign(f.validation, { accepted: false, violationCount });
      expect((await read(READS[2].name, READS[2].args, f.request, f.ports)).data).toMatchObject({
        outcome: "failed",
        reason: "bounds-exceeded",
      });
    },
  );
  it.each(READS)(
    "does not parse or expose additional native secret fields for $name",
    async (selected) => {
      const f = privateAccountFixture();
      Object.assign(f.validation, {
        licenseString: "secretValue",
        errors: { license: "secretValue" },
        password: "secretValue",
      });
      const result = await read(selected.name, selected.args, f.request, f.ports);
      expect(result.data).toMatchObject({ accepted: true, violationCount: 0 });
      expect(JSON.stringify(result)).not.toContain("secretValue");
    },
  );
  it.each(READS)("refuses model credentials or absent custody for $name", async (selected) => {
    const f = privateAccountFixture();
    expect(
      (await read(selected.name, { ...selected.args, password: "untrusted" }, f.request, f.ports))
        .data,
    ).toMatchObject({ reason: "field-validation" });
    expect(f.reads).toEqual([]);
    expect((await read(selected.name, selected.args, f.request, undefined)).data).toMatchObject({
      reason: "unavailable",
    });
    expect(f.calls).toEqual([]);
  });
  it("independently binds existing password-validation target by key and username", async () => {
    const f = privateAccountFixture();
    f.controls.shadowUser = true;
    expect((await read(READS[1].name, READS[1].args, f.request, f.ports)).data).toMatchObject({
      reason: "conflict",
    });
    expect(f.calls).toEqual([]);
  });
  it("advertises no generic secret sender or anonymization unlock", () => {
    for (const name of [
      "jira.private-http",
      "jira.unlock-anonymization",
      "jira.set-password",
      "jira.activate-license",
    ]) {
      expect(isJiraPrivateAccountMutation(name)).toBe(false);
      expect(isJiraPrivateAccountRead(name)).toBe(false);
    }
  });
});
