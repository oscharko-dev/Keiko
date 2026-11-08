import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  JiraAcknowledgedMutationError,
  jiraPrivateSessionReference,
  jiraSessionBindingForInput,
  type JiraHumanInputSelection,
} from "@oscharko-dev/keiko-connectors";
import { privateJiraCustodyFixture } from "../../../../tests/support/jira-private-custody-fixture.js";
import { createJiraPrivatePorts, createJiraPrivateLifetime } from "./httpPrivateIdentity.js";
import type { CreateAtlassianHttpPortOptions } from "./httpPort.js";

const BASE = "https://jira.example.invalid/context";
const PASSWORD = ["synthetic", "human", "password"].join(" ");
const COOKIE = { name: "JSESSIONID", value: ["synthetic", "private", "cookie"].join("-") };
type PrivatePorts = ReturnType<typeof createJiraPrivatePorts>;
function hasTurnFinish(
  ports: PrivatePorts,
): ports is PrivatePorts & { readonly finish: () => Promise<void> } {
  return "finish" in ports && typeof ports.finish === "function";
}
async function finishTurn(ports: PrivatePorts): Promise<void> {
  if (!hasTurnFinish(ports)) throw new TypeError("Missing private Jira turn finalizer");
  await ports.finish();
}
type FixturePurpose =
  "login" | "update-user-password" | "unlock-user-anonymization" | "validate-update-user-password";
function fixture(
  purpose: FixturePurpose = "login",
  legacyTemporaryRelease?: "10.3" | "10.4",
  turnLifetimeMs = 60_000,
) {
  const custody = privateJiraCustodyFixture(`jira.${purpose}`);
  const pending = custody.inputs.prepare(custody.binding);
  const values =
    purpose === "unlock-user-anonymization"
      ? { ownerShutdownConfirmation: "confirmed" }
      : purpose === "validate-update-user-password"
        ? { newPassword: PASSWORD }
        : { password: PASSWORD };
  const ready = custody.inputs.submit(pending.requestId, custody.binding, pending.revision, values);
  const selection: JiraHumanInputSelection = {
    requestId: ready.requestId,
    revision: ready.revision,
    binding: custody.binding,
  };
  const controls = {
    cookieActor: "actor-key",
    loginStatus: 200,
    lostLogin: false,
    privateStatus: 204,
    logoutStatus: 204,
    lostLogout: false,
    cookieStoredAtLogout: false,
    targetAdmitted: true,
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === `${BASE}/rest/api/2/myself`)
      return Response.json({
        key: headers.has("cookie") ? controls.cookieActor : "actor-key",
        name: "Native Actor",
      });
    if (url === `${BASE}/rest/auth/1/session` && init?.method === "POST") {
      if (controls.lostLogin) throw new TypeError("Synthetic lost login response");
      return Response.json({ session: COOKIE }, { status: controls.loginStatus });
    }
    if (url === `${BASE}/rest/auth/1/session` && init?.method === "GET")
      return Response.json({ name: "Native Actor" });
    if (url === `${BASE}/rest/auth/1/session` && init?.method === "DELETE") {
      controls.cookieStoredAtLogout = [...custody.sealedPortEntries.values()].some((value) =>
        value.includes(COOKIE.value),
      );
      if (controls.lostLogout) throw new TypeError("Synthetic logout transport failure");
      return new Response(null, { status: controls.logoutStatus });
    }
    if (url === `${BASE}/rest/api/2/user/password?key=target-key` && init?.method === "PUT")
      return new Response(null, { status: controls.privateStatus });
    if (url === `${BASE}/rest/api/2/user/anonymization/unlock` && init?.method === "DELETE")
      return new Response(null, { status: controls.privateStatus });
    if (url === `${BASE}/rest/api/2/password/policy/updateUser` && init?.method === "POST")
      return Response.json([]);
    if (
      url === `${BASE}/rest/api/2/avatar/user/temporary?filename=avatar.png&size=8` &&
      init?.method === "POST"
    )
      return Response.json({
        cropperOffsetX: 0,
        cropperOffsetY: 0,
        cropperWidth: 1,
        needsCropping: false,
      });
    throw new TypeError("Unexpected synthetic private-session route");
  });
  const beforeEffect = vi.fn(() => true);
  const controller = new AbortController();
  const context = {
    invocationId: "private-session",
    correlationId: "private-session",
    signal: controller.signal,
    beforeEffect,
  };
  const onResponse = vi.fn<NonNullable<CreateAtlassianHttpPortOptions["onResponse"]>>(() => true);
  const targetAdmission: NonNullable<
    CreateAtlassianHttpPortOptions["targetAdmission"]
  > = async () => (controls.targetAdmitted ? { baseUrl: BASE, addressClass: "public" } : undefined);
  const options = {
    baseUrl: BASE,
    authRef: custody.binding.authRef,
    credentials: custody.executionResolver,
    fetchImpl,
    onResponse,
    targetAdmission,
  };
  const onConsumed = vi.fn();
  const cleanupFailures: unknown[] = [];
  const sessionScope = {
    ...jiraSessionBindingForInput(custody.binding),
    expiresAt: custody.binding.expiresAt + turnLifetimeMs - 60_000,
  };
  const privatePortOptions = {
    selection,
    sessionScope,
    onConsumed,
    onCleanupFailure: (error: unknown): void => {
      cleanupFailures.push(error);
    },
    ...(legacyTemporaryRelease === undefined ? {} : { legacyTemporaryRelease }),
  };
  const ports = createJiraPrivatePorts(options, options, context, privatePortOptions);
  return {
    ...custody,
    controls,
    fetchImpl,
    beforeEffect,
    controller,
    ports,
    onConsumed,
    onResponse,
    cleanupFailures,
    sessionScope,
  };
}
describe("real private Jira session composition", () => {
  it("keeps the consumed-input TTL separate from the already authorized turn lifetime", async () => {
    const f = fixture("login", undefined, 120_000);
    await f.ports.identity.perform("login", {});
    f.advance(61_000);
    await f.sessions.withLease(f.sessionScope, async (session) => {
      expect(session.current()?.expiresAt).toBe(f.sessionScope.expiresAt);
      expect(session.cookieHeader()).toBe(`${COOKIE.name}=${COOKIE.value}`);
    });
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
    f.advance(59_000);
    f.controller.abort();
    await vi.waitFor(() =>
      expect(f.sealedPortEntries.has(jiraPrivateSessionReference(f.sessionScope))).toBe(false),
    );
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("logs out once at turn finish with the exact cookie, then erases the sealed cookie and temp slot", async () => {
    const f = fixture();
    const result = await f.ports.identity.perform("login", {});
    const scope = jiraSessionBindingForInput(f.binding);
    const reference = jiraPrivateSessionReference(scope);
    await f.sessions.withLease(scope, async (session) => {
      session.rememberTemporary({
        actorKey: "actor-key",
        target: { kind: "user", key: "actor-key", name: "Native Actor" },
        uploadSha256: "a".repeat(64),
        uploadBytes: 8,
        crop: { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 1 },
        needsCropping: false,
      });
    });
    expect(f.sealedPortEntries.get(reference)).toContain(COOKIE.value);
    f.onResponse.mockClear();
    await finishTurn(f.ports);
    const calls = f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${BASE}/rest/auth/1/session`, "DELETE"],
    ]);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("cookie")).toBe(`${COOKIE.name}=${COOKIE.value}`);
    expect(headers.has("authorization")).toBe(false);
    expect(calls[0]?.[1]?.body).toBeUndefined();
    expect(f.controls.cookieStoredAtLogout).toBe(true);
    expect(f.sealedPortEntries.get(reference)).toBeUndefined();
    expect(f.onResponse).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, status: 200, body: { sessionEstablished: true } });
    await finishTurn(f.ports);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it.each(["abort", "expiry", "credential-revoked"])(
    "ends the live session on %s without a later allocation or authority renewal",
    async (ending) => {
      const f = fixture();
      await f.ports.identity.perform("login", {});
      const reference = jiraPrivateSessionReference(jiraSessionBindingForInput(f.binding));
      if (ending === "expiry") f.advance(60_000);
      if (ending === "credential-revoked") f.custody.beginVerification(f.binding.authRef, 1);
      f.beforeEffect.mockReturnValue(false);
      f.onResponse.mockClear();
      f.controller.abort();
      await vi.waitFor(() => {
        expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
          1,
        );
        expect(f.sealedPortEntries.get(reference)).toBeUndefined();
      });
      expect(f.onResponse).not.toHaveBeenCalled();
      expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    },
  );
  it.each(["native-503", "lost-response"])(
    "erases local secrets and reports %s without retry or replacing the login outcome",
    async (failure) => {
      const f = fixture();
      const result = await f.ports.identity.perform("login", {});
      f.controls.logoutStatus = 503;
      f.controls.lostLogout = failure === "lost-response";
      f.onResponse.mockImplementation(() => {
        throw new TypeError("Cleanup must not call the mutation journal observer");
      });
      await expect(finishTurn(f.ports)).resolves.toBeUndefined();
      expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
        1,
      );
      expect([...f.sealedPortEntries.values()].join("")).not.toContain(COOKIE.value);
      expect(f.cleanupFailures).toHaveLength(1);
      expect(JSON.stringify(f.cleanupFailures)).not.toContain(COOKIE.value);
      expect(result).toMatchObject({ ok: true, status: 200, body: { sessionEstablished: true } });
    },
  );
  it("does not revive withdrawn target admission for logout and still erases its own cookie", async () => {
    const f = fixture();
    await f.ports.identity.perform("login", {});
    f.controls.targetAdmitted = false;
    await finishTurn(f.ports);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(COOKIE.value);
    expect(f.cleanupFailures).toHaveLength(1);
    await finishTurn(f.ports);
    expect(f.cleanupFailures).toHaveLength(1);
  });
  it.each(["new-turn", "same-turn-new-revision"])(
    "does not log out or erase a replacement session when its previous owner finishes late (%s)",
    async (replacementKind) => {
      const f = fixture();
      await f.ports.identity.perform("login", {});
      const old = jiraSessionBindingForInput(f.binding);
      const next =
        replacementKind === "new-turn"
          ? {
              ...old,
              authority: { runId: "new-accepted-turn", envelopeDigest: "e".repeat(64) },
              expiresAt: old.expiresAt + 60_000,
            }
          : old;
      const replacement = { name: "JSESSIONID", value: "synthetic-replacement-session" };
      await f.sessions.withLease(next, async (session) => {
        session.establish(replacement);
      });
      const reference = jiraPrivateSessionReference(next);
      const before = f.sealedPortEntries.get(reference);
      await finishTurn(f.ports);
      expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
      expect(f.sealedPortEntries.get(reference)).toBe(before);
      await f.sessions.withLease(next, async (session) => {
        expect(session.cookieHeader()).toBe(`${replacement.name}=${replacement.value}`);
      });
    },
  );
  it.each([false, true])(
    "awaits its active callback even when that callback immediately aborts the lifetime (%s)",
    async (abortInside) => {
      const f = fixture();
      await f.ports.identity.perform("login", {});
      if (!hasTurnFinish(f.ports)) throw new TypeError("Missing private Jira turn finalizer");
      let release = (): void => {
        throw new TypeError("Missing held session callback");
      };
      let entered = (): void => {
        throw new TypeError("Missing session entry observer");
      };
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const active = f.ports.withAvatarSession("actor-key", async (session) => {
        expect(session.temporary()).toBeUndefined();
        if (abortInside) f.controller.abort();
        entered();
        await held;
        return { ok: false, reason: "unavailable" };
      });
      await started;
      const finishing = f.ports.finish();
      try {
        await Promise.resolve();
        expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
        expect([...f.sealedPortEntries.values()].join("")).toContain(COOKIE.value);
      } finally {
        release();
      }
      await expect(active).resolves.toEqual({ ok: false, reason: "unavailable" });
      await finishing;
      expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
        1,
      );
      expect([...f.sealedPortEntries.values()].join("")).not.toContain(COOKIE.value);
    },
  );
  it("publishes turn completion before invoking a reentrant finalizer", async () => {
    const lifetime = createJiraPrivateLifetime(
      new AbortController().signal,
      "private-reentrant-finish",
    );
    let release = (): void => {
      throw new TypeError("Missing finalizer latch");
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nested: Promise<void> | undefined;
    let nestedSettled = false;
    const late = vi.fn(async () => undefined);
    lifetime.register(async () => {
      nested = lifetime.finish();
      void nested.then(() => {
        nestedSettled = true;
      });
      lifetime.register(late);
      await held;
    });
    const finishing = lifetime.finish();
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(nestedSettled).toBe(false);
    } finally {
      release();
    }
    await finishing;
    await nested;
    expect(nestedSettled).toBe(true);
    expect(late).toHaveBeenCalledOnce();
  });
  it("finishes an unused private factory without resolving a credential or opening a session", async () => {
    const f = fixture();
    await finishTurn(f.ports);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(
      f.sealedPortEntries.has(jiraPrivateSessionReference(jiraSessionBindingForInput(f.binding))),
    ).toBe(false);
  });
  it.each(["10.3", "10.4"] as const)(
    "passes the same bound %s release to the leaf and the private HTTP avatar guard",
    async (release) => {
      const f = fixture("login", release);
      await f.ports.identity.perform("login", {});
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const file = {
        name: "avatar.png",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      expect(f.ports.legacyTemporaryRelease).toBe(release);
      await f.ports.withAvatarSession("actor-key", async (session) => {
        expect(
          await session.upload(
            "jira.upload-temporary-avatar",
            { kind: "session", avatarType: "user" },
            file,
            "image/png",
            bytes,
          ),
        ).toMatchObject({ ok: true, status: 200 });
        return { ok: false, reason: "unavailable" };
      });
      const writes = f.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/avatar/"));
      expect(writes).toHaveLength(1);
      expect(new Headers(writes[0]?.[1]?.headers).get("cookie")).toBe(
        `${COOKIE.name}=${COOKIE.value}`,
      );
      expect(new Headers(writes[0]?.[1]?.headers).has("authorization")).toBe(false);
    },
  );
  it("establishes a session only after cookie-only actor/session proofs and never substitutes the PAT", async () => {
    const f = fixture();
    const result = await f.ports.identity.perform("login", {});
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { sessionEstablished: true, userKey: "actor-key", username: "Native Actor" },
    });
    const calls = f.fetchImpl.mock.calls;
    expect(calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${BASE}/rest/api/2/myself`, "GET"],
      [`${BASE}/rest/auth/1/session`, "POST"],
      [`${BASE}/rest/api/2/myself`, "GET"],
      [`${BASE}/rest/auth/1/session`, "GET"],
    ]);
    expect(new Headers(calls[0]?.[1]?.headers).has("authorization")).toBe(true);
    const loginHeaders = new Headers(calls[1]?.[1]?.headers);
    expect(loginHeaders.has("authorization")).toBe(false);
    expect(loginHeaders.has("cookie")).toBe(false);
    expect(calls[1]?.[1]?.body).toBe(
      JSON.stringify({ username: "Native Actor", password: PASSWORD }),
    );
    for (const [, init] of calls.slice(2)) {
      expect(new Headers(init?.headers).get("cookie")).toBe(`${COOKIE.name}=${COOKIE.value}`);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(COOKIE.value);
    expect(JSON.stringify(f.onConsumed.mock.calls)).not.toContain(PASSWORD);
    await expect(f.ports.identity.perform("login", {})).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(f.onConsumed).toHaveBeenCalledOnce();
  });
  it("does not trust the login ACK or a cookie associated with another actor", async () => {
    const f = fixture();
    f.controls.cookieActor = "different-native-user";
    expect(await f.ports.identity.perform("login", {})).toMatchObject({
      ok: false,
      reason: "unavailable",
      httpStatus: 200,
    });
    await f.sessions.withLease(jiraSessionBindingForInput(f.binding), async (session) => {
      expect(session.current()).toBeUndefined();
    });
  });
  it("retains known actor identity after a login ACK when persisting the independently proven session fails", async () => {
    const f = fixture();
    const compare = f.vault.compareAndSet;
    f.vault.compareAndSet = (reference, expected, next) => {
      if (next?.includes('"cookie":')) throw new TypeError("Synthetic session store failure");
      return compare(reference, expected, next);
    };
    await expect(f.ports.identity.perform("login", {})).rejects.toMatchObject({
      name: "JiraAcknowledgedMutationError",
      receipt: { actorUserKey: "actor-key", userKey: "actor-key", username: "Native Actor" },
    });
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not invent an ACK or replay a consumed login after a lost response", async () => {
    const f = fixture();
    f.controls.lostLogin = true;
    expect(await f.ports.identity.perform("login", {})).toMatchObject({ ok: false });
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await expect(f.ports.identity.perform("login", {})).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(f.onConsumed).toHaveBeenCalledOnce();
  });
  it("requires the live expected actor for logout and removes the sealed session after one native DELETE", async () => {
    const f = fixture();
    await f.ports.identity.perform("login", {});
    expect(await f.ports.identity.session("logout", "other-actor")).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(await f.ports.identity.session("logout", "actor-key")).toMatchObject({
      ok: true,
      status: 204,
    });
    const writes = f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(writes).toHaveLength(1);
    expect(new Headers(writes[0]?.[1]?.headers).has("authorization")).toBe(false);
    await f.sessions.withLease(jiraSessionBindingForInput(f.binding), async (session) => {
      expect(session.current()).toBeUndefined();
    });
  });
  it.each([200, 202, 204])(
    "preserves a real unlock ACK %s when its journal observer throws afterwards",
    async (status) => {
      const f = fixture("unlock-user-anonymization");
      f.controls.privateStatus = status;
      const defect = new TypeError("Synthetic post-response journal failure");
      f.onResponse.mockImplementation((request) => {
        if (request.method === "DELETE") throw defect;
        return true;
      });
      const effect = f.ports.identity.unlock("actor-key");
      await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
      await expect(effect).rejects.toMatchObject({
        cause: defect,
        receipt: { actorUserKey: "actor-key" },
      });
      expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
        1,
      );
      expect(f.onConsumed).toHaveBeenCalledOnce();
    },
  );
  it("never labels the operator as the administrative password target after an ACK failure", async () => {
    const f = fixture("update-user-password");
    const defect = new TypeError("Synthetic post-response journal failure");
    f.onResponse.mockImplementation((request) => {
      if (request.method === "PUT") throw defect;
      return true;
    });
    const effect = f.ports.identity.perform("update-user-password", { userKey: "target-key" });
    await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    await expect(effect).rejects.toHaveProperty("receipt", { actorUserKey: "actor-key" });
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("does not invent acknowledgement from a prerequisite GET or a refused native DELETE", async () => {
    const defect = new TypeError("Synthetic response observer failure");
    const prerequisite = fixture("unlock-user-anonymization");
    prerequisite.onResponse.mockImplementation(() => {
      throw defect;
    });
    await expect(prerequisite.ports.identity.unlock("actor-key")).rejects.toBe(defect);
    expect(
      prerequisite.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toEqual([]);
    expect(prerequisite.onConsumed).not.toHaveBeenCalled();
    const refused = fixture("unlock-user-anonymization");
    refused.controls.privateStatus = 403;
    refused.onResponse.mockImplementation((request) => {
      if (request.method === "DELETE") throw defect;
      return true;
    });
    await expect(refused.ports.identity.unlock("actor-key")).rejects.toBe(defect);
    expect(
      refused.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });
  it("keeps password-policy POST observation errors outside mutation acknowledgement", async () => {
    const f = fixture("validate-update-user-password");
    const defect = new TypeError("Synthetic read observer failure");
    f.onResponse.mockImplementation((request) => {
      if (request.method === "POST") throw defect;
      return true;
    });
    await expect(
      f.ports.identity.perform("validate-update-user-password", { username: "Target User" }),
    ).rejects.toBe(defect);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
