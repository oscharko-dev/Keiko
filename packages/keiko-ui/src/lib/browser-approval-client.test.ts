import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserApprovalChallenge,
  BrowserApprovalDescriptor,
  BrowserApprovalRequestDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  createBrowserApprovalClient,
  type BrowserApprovalClientOptions,
} from "./browser-approval-client";
import { createBrowserApprovalKey } from "./browser-approval-crypto";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const ORIGIN = "http://127.0.0.1:1983";
const AT = 1_800_000_000_000;
const INTENT = "12345678-1234-1234-1234-123456789abc";

function request(remember = true): BrowserApprovalRequestDescriptor {
  return {
    requestId: `brq_${"a".repeat(32)}`,
    comparisonCode: "01234567",
    requestedAtMs: AT,
    expiresAtMs: AT + 300_000,
    rememberRequested: remember,
    publicKeyFingerprint: "b".repeat(64),
  };
}

function approval(remembered = true): BrowserApprovalDescriptor {
  return {
    approvalId: `bra_${"c".repeat(32)}`,
    remembered,
    approvedAtMs: AT,
    expiresAtMs: AT + 300_000,
    lastUsedAtMs: AT,
    publicKeyFingerprint: request().publicKeyFingerprint,
  };
}

function challenge(purpose: "complete" | "renew" = "complete"): BrowserApprovalChallenge {
  return {
    schemaVersion: 1,
    challengeId: `bch_${"d".repeat(32)}`,
    purpose,
    subjectId: purpose === "complete" ? request().requestId : approval().approvalId,
    installationId: "e".repeat(32),
    serverInstanceId: "f".repeat(32),
    origin: ORIGIN,
    nonce: "A".repeat(43),
    issuedAtMs: AT,
    expiresAtMs: AT + 60_000,
  };
}

function harness(): {
  readonly options: BrowserApprovalClientOptions;
  readonly api: Required<BrowserApprovalClientOptions>["api"];
  readonly store: BrowserApprovalClientOptions["keyStore"];
  readonly changed: ReturnType<typeof vi.fn>;
} {
  const api = {
    inspect: vi.fn().mockResolvedValue({ state: "unavailable" }),
    request: vi.fn().mockResolvedValue({ state: "pending", request: request() }),
    challenge: vi.fn().mockResolvedValue({ state: "challenge", challenge: challenge() }),
    prove: vi.fn().mockResolvedValue({ state: "active", approval: approval() }),
  };
  const store = {
    prepare: vi.fn().mockResolvedValue(INTENT),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(undefined),
  };
  const changed = vi.fn();
  return {
    api,
    store,
    changed,
    options: { origin: ORIGIN, keyStore: store, api, sessionChanged: changed },
  };
}

describe("browser approval client orchestration", () => {
  beforeEach(async () => {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("CryptoKey", keys.privateKey.constructor);
    setClientDiagnosticWriter(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetClientDiagnosticWriter();
  });

  it.each([false, true])(
    "recovers a verified existing session after the original completion deadline, remember=%s",
    async (remember) => {
      const h = harness();
      vi.mocked(h.api.inspect).mockResolvedValue({ state: "active", requests: [], approvals: [] });
      vi.mocked(h.api.challenge).mockResolvedValue({ state: "unavailable" });
      const client = createBrowserApprovalClient(h.options);
      const key = await createBrowserApprovalKey();
      await expect(
        client.complete({
          key,
          request: request(remember),
          correlationId: "corr_recovery",
          persistenceIntent: INTENT,
        }),
      ).resolves.toEqual({ state: "active", persistence: remember ? "unconfirmed" : "session" });
      expect(h.api.challenge).not.toHaveBeenCalled();
      expect(h.api.prove).not.toHaveBeenCalled();
      expect(h.store.save).not.toHaveBeenCalled();
      expect(h.changed).toHaveBeenCalledOnce();
    },
  );

  it("does not treat proof acknowledgement as usable access when cookies are blocked", async () => {
    const h = harness();
    const key = await createBrowserApprovalKey();
    await expect(
      createBrowserApprovalClient(h.options).complete({
        key,
        request: request(),
        correlationId: "corr_blocked",
        persistenceIntent: INTENT,
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("does not access remembered key storage when a valid session already exists", async () => {
    const h = harness();
    vi.mocked(h.api.inspect).mockResolvedValue({ state: "active", requests: [], approvals: [] });
    await expect(createBrowserApprovalClient(h.options).restore()).resolves.toBe(true);
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.api.challenge).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("waits for committed storage before announcing remembered access", async () => {
    const h = harness();
    let commit: (() => void) | undefined;
    vi.mocked(h.store.save).mockImplementation(
      () =>
        new Promise<void>((resolve): void => {
          commit = resolve;
        }),
    );
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    const key = await createBrowserApprovalKey();
    const operation = createBrowserApprovalClient(h.options).complete({
      key,
      request: request(),
      correlationId: "corr_commit",
      persistenceIntent: INTENT,
    });
    await vi.waitFor(() => expect(h.store.save).toHaveBeenCalledOnce());
    expect(h.changed).not.toHaveBeenCalled();
    commit?.();
    await expect(operation).resolves.toEqual({ state: "active", persistence: "stored" });
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it("keeps active access honest when a remembered key transaction fails", async () => {
    const h = harness();
    vi.mocked(h.store.save).mockRejectedValue(new DOMException("Quota", "QuotaExceededError"));
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    const key = await createBrowserApprovalKey();
    await expect(
      createBrowserApprovalClient(h.options).complete({
        key,
        request: request(),
        correlationId: "corr_quota",
        persistenceIntent: INTENT,
      }),
    ).resolves.toEqual({ state: "active", persistence: "unconfirmed" });
    expect(h.store.forget).not.toHaveBeenCalled();
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it("honors an approver downgrade to one session without touching key storage", async () => {
    const h = harness();
    vi.mocked(h.api.prove).mockResolvedValue({ state: "active", approval: approval(false) });
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    const key = await createBrowserApprovalKey();
    await expect(
      createBrowserApprovalClient(h.options).complete({
        key,
        request: request(),
        correlationId: "corr_once",
        persistenceIntent: INTENT,
      }),
    ).resolves.toEqual({ state: "active", persistence: "session" });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it.each(["identity", "intent"])("refuses changed remembered approval %s", async (change) => {
    const h = harness();
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    if (change === "identity")
      vi.mocked(h.api.prove).mockResolvedValue({
        state: "active",
        approval: { ...approval(), publicKeyFingerprint: "f".repeat(64) },
      });
    const key = await createBrowserApprovalKey();
    await expect(
      createBrowserApprovalClient(h.options).complete({
        key,
        request: request(change !== "intent"),
        correlationId: "corr_binding",
        persistenceIntent: INTENT,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("renews only the stored installation and grant and verifies usable access again", async () => {
    const h = harness();
    const key = await createBrowserApprovalKey();
    vi.mocked(h.store.load).mockResolvedValue({
      schemaVersion: 1,
      privateKey: key.privateKey,
      approval: approval(),
      installationId: challenge().installationId,
      origin: ORIGIN,
    });
    vi.mocked(h.api.challenge).mockResolvedValue({
      state: "challenge",
      challenge: challenge("renew"),
    });
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    await expect(createBrowserApprovalClient(h.options).restore()).resolves.toBe(true);
    expect(h.api.challenge).toHaveBeenCalledWith(
      { purpose: "renew", subjectId: approval().approvalId },
      undefined,
      expect.any(String),
    );
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.store.forget).not.toHaveBeenCalled();
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it("stops an aborted restoration wait without letting a late key start a challenge", async () => {
    const h = harness();
    const key = await createBrowserApprovalKey();
    let release: ((record: Awaited<ReturnType<typeof h.store.load>>) => void) | undefined;
    vi.mocked(h.store.load).mockImplementation(
      () =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const operation = createBrowserApprovalClient(h.options).restore(controller.signal);
    await vi.waitFor(() => expect(h.store.load).toHaveBeenCalledOnce());
    controller.abort();
    await expect(operation).resolves.toBe(false);
    release?.({
      schemaVersion: 1,
      privateKey: key.privateKey,
      approval: approval(),
      installationId: challenge().installationId,
      origin: ORIGIN,
    });
    await Promise.resolve();
    expect(h.api.challenge).not.toHaveBeenCalled();
    expect(h.api.prove).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("does not create a browser approval after cancellation while generating its key", async () => {
    const h = harness();
    const controller = new AbortController();
    const operation = createBrowserApprovalClient(h.options).begin(true, controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(h.api.request).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it("does not accept a server echo that changes the human requester's remember choice", async () => {
    const h = harness();
    await expect(createBrowserApprovalClient(h.options).begin(false)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(h.api.request).toHaveBeenCalledWith(
      expect.objectContaining({ remember: false }),
      undefined,
      expect.any(String),
    );
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("prepares persistence before dispatching the public request", async () => {
    const h = harness();
    const attempt = await createBrowserApprovalClient(h.options).begin(true);
    expect(attempt?.persistenceIntent).toBe(INTENT);
    const prepareOrder = vi.mocked(h.store.prepare).mock.invocationCallOrder[0];
    const requestOrder = vi.mocked(h.api.request).mock.invocationCallOrder[0];
    expect(prepareOrder).toBeLessThan(requestOrder ?? 0);
  });

  it("preserves an already usable session without replacing its authority or claiming remembered persistence", async () => {
    const h = harness();
    vi.mocked(h.api.inspect).mockResolvedValue({ state: "active", requests: [], approvals: [] });
    const client = createBrowserApprovalClient(h.options);
    const attempt = await client.begin(true);
    if (attempt === undefined) throw new TypeError("Expected pending request.");
    await expect(client.complete(attempt)).resolves.toEqual({
      state: "active",
      persistence: "unconfirmed",
    });
    expect(h.api.prove).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it("keeps session access usable after preparation fails but never uses an unconditional save", async () => {
    const h = harness();
    vi.mocked(h.store.prepare).mockRejectedValue(
      new DOMException("Unavailable", "NotSupportedError"),
    );
    const client = createBrowserApprovalClient(h.options);
    const attempt = await client.begin(true);
    expect(attempt).toBeDefined();
    if (attempt === undefined) throw new TypeError("Expected pending request.");
    vi.mocked(h.api.inspect)
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValue({ state: "active", requests: [], approvals: [] });
    await expect(client.complete(attempt)).resolves.toEqual({
      state: "active",
      persistence: "unconfirmed",
    });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.changed).toHaveBeenCalledOnce();
  });
});
