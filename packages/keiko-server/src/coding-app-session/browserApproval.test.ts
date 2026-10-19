import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  BROWSER_APPROVAL_MAX_RECORDS,
  BROWSER_APPROVAL_REMEMBER_TTL_MS,
  BROWSER_APPROVAL_REQUEST_TTL_MS,
  browserApprovalChallengeText,
  type BrowserApprovalChallenge,
  type BrowserApprovalPublicKey,
  type BrowserApprovalRequestDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { createInMemoryUiStore } from "../store/index.js";
import { createBrowserApprovalService, type BrowserApprovalService } from "./browserApproval.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { APP_SESSION_COOKIE_MAX_AGE_SECONDS } from "./sessionCookie.js";

const ORIGIN = "http://127.0.0.1:1983";
const stores: ReturnType<typeof createInMemoryUiStore>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function keyPair(): {
  readonly publicKey: BrowserApprovalPublicKey;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("Missing public key");
  return { publicKey: { x: jwk.x, y: jwk.y }, privateKey: pair.privateKey };
}

function proof(
  challenge: BrowserApprovalChallenge,
  key: KeyObject,
): {
  readonly challengeId: string;
  readonly signature: string;
} {
  return {
    challengeId: challenge.challengeId,
    signature: sign("sha256", Buffer.from(browserApprovalChallengeText(challenge)), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
  };
}

function request(
  service: BrowserApprovalService,
  publicKey: BrowserApprovalPublicKey,
  remember = false,
): BrowserApprovalRequestDescriptor {
  const result = service.request({ publicKey, remember }, ORIGIN);
  if (result.state !== "pending") throw new Error("Missing approval request");
  return result.request;
}

function challenge(
  service: BrowserApprovalService,
  subjectId: string,
  purpose: "complete" | "renew" = "complete",
): BrowserApprovalChallenge {
  const result = service.challenge({ purpose, subjectId }, ORIGIN);
  if (result.state !== "challenge") throw new Error("Missing browser challenge");
  return result.challenge;
}

function fixture(): {
  readonly service: BrowserApprovalService;
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly store: NonNullable<ReturnType<typeof createInMemoryUiStore>["browserApprovals"]>;
  readonly ownerCookie: string;
  readonly setTime: (time: number) => void;
  readonly restart: () => BrowserApprovalService;
} {
  const uiStore = createInMemoryUiStore();
  stores.push(uiStore);
  const store = uiStore.browserApprovals;
  if (store === undefined) throw new Error("Missing browser approval store");
  let now = 1_000_000;
  const clock = (): number => now;
  const registry = createSessionRegistry({ now: clock });
  return {
    service: createBrowserApprovalService({ registry, store, now: clock }),
    registry,
    store,
    ownerCookie: registry.mint("launcher").cookieToken,
    setTime: (time): void => {
      now = time;
    },
    restart: (): BrowserApprovalService =>
      createBrowserApprovalService({
        registry: createSessionRegistry({ now: clock }),
        store,
        now: clock,
      }),
  };
}

function approve(
  service: BrowserApprovalService,
  cookie: string,
  descriptor: BrowserApprovalRequestDescriptor,
  remember = false,
): boolean {
  return service.approve(cookie, {
    requestId: descriptor.requestId,
    comparisonCode: descriptor.comparisonCode,
    remember,
  });
}

function sessionOnlyApproval(
  f: ReturnType<typeof fixture>,
  rememberRequested = false,
): {
  readonly descriptor: BrowserApprovalRequestDescriptor;
  readonly key: ReturnType<typeof keyPair>;
  readonly completion: Extract<ReturnType<BrowserApprovalService["prove"]>, { state: "active" }>;
  readonly approvalId: string;
} {
  const key = keyPair();
  const descriptor = request(f.service, key.publicKey, rememberRequested);
  expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
  const mint = vi.spyOn(f.registry, "mintForApproval");
  const completion = f.service.prove(
    proof(challenge(f.service, descriptor.requestId), key.privateKey),
    ORIGIN,
  );
  const binding = mint.mock.calls.at(-1)?.[1];
  if (completion.state !== "active" || binding === undefined)
    throw new Error("Missing session-only approval");
  return { key, descriptor, completion, approvalId: binding.approvalId };
}

describe("session-only browser approval management", () => {
  it.each([0, BROWSER_APPROVAL_REQUEST_TTL_MS, BROWSER_APPROVAL_REQUEST_TTL_MS + 1])(
    "retains a live session-only approval without persisting trust after %i ms",
    (elapsed) => {
      const f = fixture();
      const approved = sessionOnlyApproval(f);
      f.setTime(approved.descriptor.requestedAtMs + elapsed);
      expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeDefined();
      expect(f.service.snapshot(f.ownerCookie)?.approvals).toEqual([
        expect.objectContaining({
          approvalId: approved.approvalId,
          remembered: false,
          publicKeyFingerprint: approved.descriptor.publicKeyFingerprint,
          approvedAtMs: approved.descriptor.requestedAtMs,
          expiresAtMs:
            approved.descriptor.requestedAtMs + APP_SESSION_COOKIE_MAX_AGE_SECONDS * 1_000,
        }),
      ]);
      expect(f.store.list()).toEqual([]);
    },
  );

  it.each([0, BROWSER_APPROVAL_REQUEST_TTL_MS + 1])(
    "acknowledges actual session-only revocation after %i ms",
    (elapsed) => {
      const f = fixture();
      const approved = sessionOnlyApproval(f);
      f.setTime(approved.descriptor.requestedAtMs + elapsed);
      expect(f.service.revoke(f.ownerCookie, approved.approvalId)).toBe(true);
      expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeUndefined();
      expect(f.service.snapshot(f.ownerCookie)?.approvals).toEqual([]);
      expect(f.service.revoke(f.ownerCookie, approved.approvalId)).toBe(false);
      expect(f.store.list()).toEqual([]);
    },
  );

  it("retains the original completion window while its live approval remains manageable", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    f.setTime(approved.descriptor.expiresAtMs - 1);
    const signed = proof(
      challenge(f.service, approved.descriptor.requestId),
      approved.key.privateKey,
    );
    f.setTime(approved.descriptor.expiresAtMs);
    expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
    expect(
      f.service.challenge(
        { purpose: "complete", subjectId: approved.descriptor.requestId },
        ORIGIN,
      ),
    ).toEqual({ state: "unavailable" });
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeDefined();
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(1);
  });

  it("keeps rotated session-only access visible without extending the original grant", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    f.setTime(approved.descriptor.requestedAtMs + 1_000);
    const rotated = f.service.prove(
      proof(challenge(f.service, approved.descriptor.requestId), approved.key.privateKey),
      ORIGIN,
    );
    if (rotated.state !== "active") throw new Error("Missing rotated session");
    f.setTime(approved.descriptor.expiresAtMs + 1);
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeUndefined();
    expect(f.registry.inspect(rotated.mint.cookieToken)).toBeDefined();
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(1);
    expect(f.service.revoke(f.ownerCookie, approved.approvalId)).toBe(true);
    expect(f.registry.inspect(rotated.mint.cookieToken)).toBeUndefined();
    expect(f.registry.sessionCount()).toBe(1);
  });

  it("exposes and revokes an approved session-only decision before key completion", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey);
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
    const signed = proof(challenge(f.service, descriptor.requestId), key.privateKey);
    const approval = f.service.snapshot(f.ownerCookie)?.approvals.at(0);
    expect(approval).toBeDefined();
    if (approval === undefined) throw new Error("Missing approved session-only decision");
    expect(f.service.revoke(f.ownerCookie, approval.approvalId)).toBe(true);
    expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
    expect(f.registry.sessionCount()).toBe(1);
    expect(f.store.list()).toEqual([]);
  });

  it("does not revive session-only approval after a process restart", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    const restarted = f.restart();
    expect(restarted.snapshot(approved.completion.mint.cookieToken)).toBeUndefined();
    expect(
      restarted.challenge({ purpose: "renew", subjectId: approved.approvalId }, ORIGIN),
    ).toEqual({ state: "unavailable" });
    expect(f.store.list()).toEqual([]);
  });

  it("uses the approver's session-only choice when remembering was requested", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f, true);
    f.setTime(approved.descriptor.expiresAtMs + 1);
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toEqual([
      expect.objectContaining({ approvalId: approved.approvalId, remembered: false }),
    ]);
    expect(f.store.list()).toEqual([]);
  });

  it("does not let management polling refresh another browser's inactivity", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    const before = f.registry.inspect(approved.completion.mint.cookieToken);
    f.setTime(approved.descriptor.expiresAtMs + 1);
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(1);
    expect(f.registry.inspect(approved.completion.mint.cookieToken)?.lastSeenAtMs).toBe(
      before?.lastSeenAtMs,
    );
    f.setTime(approved.descriptor.requestedAtMs + 30 * 60_000);
    const replacement = f.registry.mint("replacement launcher");
    expect(f.service.snapshot(replacement.cookieToken)?.approvals).toEqual([]);
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeUndefined();
  });

  it("does not restore a revoked session when an older active operation releases", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    const release = f.registry.beginOperation(approved.completion.mint.cookieToken);
    f.setTime(approved.descriptor.expiresAtMs + 1);
    expect(f.service.revoke(f.ownerCookie, approved.approvalId)).toBe(true);
    release?.();
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeUndefined();
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toEqual([]);
    expect(f.registry.sessionCount()).toBe(1);
  });

  it("bounds pending requests without evicting live session-only management records", () => {
    const f = fixture();
    const live = Array.from({ length: BROWSER_APPROVAL_MAX_RECORDS - 1 }, () =>
      sessionOnlyApproval(f),
    );
    const key = keyPair();
    request(f.service, key.publicKey);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN)).toEqual({
      state: "unavailable",
    });
    f.setTime(1_000_000 + BROWSER_APPROVAL_REQUEST_TTL_MS + 1);
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(live.length);
    request(f.service, key.publicKey);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN)).toEqual({
      state: "unavailable",
    });
    for (const approved of live)
      expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeDefined();
    f.setTime(1_000_000 + 30 * 60_000);
    const replacement = f.registry.mint("replacement launcher");
    expect(f.service.snapshot(replacement.cookieToken)?.approvals).toEqual([]);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN).state).toBe(
      "pending",
    );
    expect(f.store.list()).toEqual([]);
  });

  it("releases an evicted session's management capacity before the request window ends", () => {
    const f = fixture();
    const live = Array.from({ length: BROWSER_APPROVAL_MAX_RECORDS - 1 }, () =>
      sessionOnlyApproval(f),
    );
    const key = keyPair();
    request(f.service, key.publicKey);
    f.setTime(1_000_001);
    expect(f.registry.verify(f.ownerCookie)).toBeDefined();
    f.registry.mint("independent launcher");
    const evicted = live.at(0);
    if (evicted === undefined) throw new Error("Missing eviction fixture");
    expect(f.registry.inspect(evicted.completion.mint.cookieToken)).toBeUndefined();
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN).state).toBe(
      "pending",
    );
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(live.length - 1);
    expect(
      f.service.challenge({ purpose: "complete", subjectId: evicted.descriptor.requestId }, ORIGIN),
    ).toEqual({ state: "unavailable" });
    for (const approved of live.slice(1))
      expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeDefined();
  });

  it("preserves active-operation visibility but retires the original approval deadline", () => {
    const f = fixture();
    const approved = sessionOnlyApproval(f);
    const releaseOwner = f.registry.beginOperation(f.ownerCookie);
    const releaseVisitor = f.registry.beginOperation(approved.completion.mint.cookieToken);
    f.setTime(approved.descriptor.requestedAtMs + 31 * 60_000);
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeDefined();
    expect(f.service.snapshot(f.ownerCookie)?.approvals).toHaveLength(1);
    f.setTime(approved.descriptor.requestedAtMs + APP_SESSION_COOKIE_MAX_AGE_SECONDS * 1_000);
    const replacement = f.registry.mint("replacement launcher");
    expect(f.service.snapshot(replacement.cookieToken)?.approvals).toEqual([]);
    expect(f.registry.inspect(approved.completion.mint.cookieToken)).toBeUndefined();
    releaseOwner?.();
    releaseVisitor?.();
    expect(f.registry.sessionCount()).toBe(1);
    expect(f.store.list()).toEqual([]);
  });
});

describe("explicit browser approval", () => {
  it("rejects malformed public points and never accepts private-key fields", () => {
    const f = fixture();
    const key = keyPair();
    for (const publicKey of [
      { x: "A".repeat(43), y: "A".repeat(43) },
      { ...key.publicKey, d: "private-key-field-must-not-cross-wire" },
      { ...key.publicKey, kty: "EC" },
    ]) {
      expect(f.service.request({ publicKey, remember: false }, ORIGIN)).toEqual({
        state: "unavailable",
      });
    }
    expect(f.service.snapshot(f.ownerCookie)?.requests).toEqual([]);
    expect(f.registry.sessionCount()).toBe(1);
  });
  it("requires existing authority, matching comparison code, and possession of the approved key", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey);
    expect(f.service.snapshot(undefined)).toBeUndefined();
    expect(f.service.snapshot("forged")).toBeUndefined();
    expect(approve(f.service, "forged", descriptor)).toBe(false);
    expect(approve(f.service, f.ownerCookie, { ...descriptor, comparisonCode: "not-a-code" })).toBe(
      false,
    );
    expect(
      f.service.challenge({ purpose: "complete", subjectId: descriptor.requestId }, ORIGIN),
    ).toEqual({ state: "pending" });
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(false);
    const wrong = proof(challenge(f.service, descriptor.requestId), keyPair().privateKey);
    expect(f.service.prove(wrong, ORIGIN)).toEqual({ state: "unavailable" });
    expect(f.registry.sessionCount()).toBe(1);
    const signed = proof(challenge(f.service, descriptor.requestId), key.privateKey);
    const completed = f.service.prove(signed, ORIGIN);
    expect(completed.state).toBe("active");
    if (completed.state !== "active") throw new Error("Missing completed session");
    expect(completed.approval).toBeUndefined();
    expect(f.registry.verify(completed.mint.cookieToken)).toBeDefined();
    expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
    expect(f.store.list()).toEqual([]);
  });

  it("requires both browsers to explicitly choose remembered access", () => {
    const f = fixture();
    const key = keyPair();
    const ordinary = request(f.service, key.publicKey);
    expect(approve(f.service, f.ownerCookie, ordinary, true)).toBe(false);
    expect(approve(f.service, f.ownerCookie, ordinary)).toBe(true);
    const optional = request(f.service, key.publicKey, true);
    expect(approve(f.service, f.ownerCookie, optional, false)).toBe(true);
    expect(f.store.list()).toEqual([]);
  });

  it("renews remembered approval after restart with a fresh process-bound proof", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey, true);
    expect(approve(f.service, f.ownerCookie, descriptor, true)).toBe(true);
    const oldChallenge = challenge(f.service, descriptor.requestId);
    const completed = f.service.prove(proof(oldChallenge, key.privateKey), ORIGIN);
    if (completed.state !== "active" || completed.approval === undefined)
      throw new Error("Missing remembered approval");
    const restarted = f.restart();
    expect(restarted.snapshot(completed.mint.cookieToken)).toBeUndefined();
    expect(restarted.prove(proof(oldChallenge, key.privateKey), ORIGIN)).toEqual({
      state: "unavailable",
    });
    const renewed = restarted.prove(
      proof(challenge(restarted, completed.approval.approvalId, "renew"), key.privateKey),
      ORIGIN,
    );
    expect(renewed.state).toBe("active");
    if (renewed.state !== "active") throw new Error("Missing renewed session");
    expect(renewed.approval?.expiresAtMs).toBe(completed.approval.expiresAtMs);
    expect(restarted.snapshot(renewed.mint.cookieToken)?.approvals).toHaveLength(1);
  });

  it("cannot renew session-only approval after restart", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey);
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
    const pending = challenge(f.service, descriptor.requestId);
    expect(f.restart().prove(proof(pending, key.privateKey), ORIGIN)).toEqual({
      state: "unavailable",
    });
    expect(f.store.list()).toEqual([]);
  });

  it("recovers a lost completion response by rotating the same session without extending its lifetime", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey);
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
    const first = f.service.prove(
      proof(challenge(f.service, descriptor.requestId), key.privateKey),
      ORIGIN,
    );
    if (first.state !== "active") throw new Error("Missing first session");
    f.setTime(1_000_100);
    const second = f.service.prove(
      proof(challenge(f.service, descriptor.requestId), key.privateKey),
      ORIGIN,
    );
    if (second.state !== "active") throw new Error("Missing recovered session");
    expect(second.mint.session.sessionId).toBe(first.mint.session.sessionId);
    expect(second.mint.session.issuedAtMs).toBe(first.mint.session.issuedAtMs);
    expect(f.registry.verify(first.mint.cookieToken)).toBeUndefined();
    expect(f.registry.verify(second.mint.cookieToken)).toBeDefined();
    expect(f.registry.sessionCount()).toBe(2);
    const outstanding = proof(challenge(f.service, descriptor.requestId), key.privateKey);
    f.registry.revoke(second.mint.session.sessionId);
    expect(f.service.prove(outstanding, ORIGIN)).toEqual({ state: "unavailable" });
    expect(
      f.service.challenge({ purpose: "complete", subjectId: descriptor.requestId }, ORIGIN),
    ).toEqual({ state: "unavailable" });
  });

  it.each(["before-proof", "after-proof"] as const)(
    "makes revocation authoritative %s",
    (order) => {
      const f = fixture();
      const key = keyPair();
      const descriptor = request(f.service, key.publicKey, true);
      expect(approve(f.service, f.ownerCookie, descriptor, true)).toBe(true);
      const approval = f.store.list().at(0);
      if (approval === undefined) throw new Error("Missing approval");
      const signed = proof(challenge(f.service, approval.approvalId, "renew"), key.privateKey);
      const completion = proof(challenge(f.service, descriptor.requestId), key.privateKey);
      expect(f.service.revoke("forged", approval.approvalId)).toBe(false);
      const minted = order === "after-proof" ? f.service.prove(signed, ORIGIN) : undefined;
      expect(f.service.revoke(f.ownerCookie, approval.approvalId)).toBe(true);
      expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
      expect(f.service.prove(completion, ORIGIN)).toEqual({ state: "unavailable" });
      if (minted?.state === "active")
        expect(f.registry.verify(minted.mint.cookieToken)).toBeUndefined();
      expect(f.registry.sessionCount()).toBe(1);
      expect(
        f.restart().challenge({ purpose: "renew", subjectId: approval.approvalId }, ORIGIN),
      ).toEqual({ state: "unavailable" });
    },
  );

  it.each(["http://localhost:1983", "http://127.0.0.1:1984", "https://127.0.0.1:1983"])(
    "binds completion and renewal to the approved origin: %s",
    (origin) => {
      const f = fixture();
      const key = keyPair();
      const descriptor = request(f.service, key.publicKey, true);
      expect(approve(f.service, f.ownerCookie, descriptor, true)).toBe(true);
      expect(
        f.service.challenge({ purpose: "complete", subjectId: descriptor.requestId }, origin),
      ).toEqual({ state: "unavailable" });
      const approval = f.store.list().at(0);
      if (approval === undefined) throw new Error("Missing approval");
      expect(
        f.service.challenge({ purpose: "renew", subjectId: approval.approvalId }, origin),
      ).toEqual({ state: "unavailable" });
      const signed = proof(challenge(f.service, descriptor.requestId), key.privateKey);
      expect(f.service.prove(signed, origin)).toEqual({ state: "unavailable" });
      expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
      expect(f.registry.sessionCount()).toBe(1);
    },
  );

  it("refuses exact challenge and request expiry without reviving authority on clock rollback", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey);
    expect(approve(f.service, f.ownerCookie, descriptor)).toBe(true);
    const signed = proof(challenge(f.service, descriptor.requestId), key.privateKey);
    f.setTime(1_000_000 + BROWSER_APPROVAL_CHALLENGE_TTL_MS);
    expect(f.service.prove(signed, ORIGIN)).toEqual({ state: "unavailable" });
    f.setTime(1_000_000 + BROWSER_APPROVAL_REQUEST_TTL_MS);
    expect(
      f.service.challenge({ purpose: "complete", subjectId: descriptor.requestId }, ORIGIN),
    ).toEqual({ state: "unavailable" });
    f.setTime(1_000_001);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN)).toEqual({
      state: "unavailable",
    });
    expect(f.registry.sessionCount()).toBe(1);
  });

  it("never slides remembered expiry and refuses renewal at the original thirty-day limit", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey, true);
    expect(approve(f.service, f.ownerCookie, descriptor, true)).toBe(true);
    const approval = f.store.list().at(0);
    if (approval === undefined) throw new Error("Missing approval");
    f.setTime(approval.expiresAtMs - 2_000);
    const signed = proof(challenge(f.service, approval.approvalId, "renew"), key.privateKey);
    const result = f.service.prove(signed, ORIGIN);
    if (result.state !== "active") throw new Error("Missing near-expiry session");
    expect(result.maxAgeSeconds).toBe(2);
    expect(result.approval?.expiresAtMs).toBe(1_000_000 + BROWSER_APPROVAL_REMEMBER_TTL_MS);
    const final = proof(challenge(f.service, approval.approvalId, "renew"), key.privateKey);
    f.setTime(approval.expiresAtMs);
    expect(f.service.prove(final, ORIGIN)).toEqual({ state: "unavailable" });
    expect(f.registry.verify(result.mint.cookieToken)).toBeUndefined();
    expect(
      f.restart().challenge({ purpose: "renew", subjectId: approval.approvalId }, ORIGIN),
    ).toEqual({ state: "unavailable" });
  });

  it("retains observed expiry across restart and clock rollback", () => {
    const f = fixture();
    const key = keyPair();
    const descriptor = request(f.service, key.publicKey, true);
    expect(approve(f.service, f.ownerCookie, descriptor, true)).toBe(true);
    const approval = f.store.list().at(0);
    if (approval === undefined) throw new Error("Missing approval");
    const input = { purpose: "renew", subjectId: approval.approvalId };
    f.setTime(approval.expiresAtMs);
    expect(f.service.challenge(input, ORIGIN)).toEqual({ state: "unavailable" });
    f.setTime(1_001_000);
    expect(f.service.challenge(input, ORIGIN)).toEqual({ state: "unavailable" });
    expect(f.restart().challenge(input, ORIGIN)).toEqual({ state: "unavailable" });
  });

  it("bounds pending requests without evicting pending approval and recovers capacity after expiry", () => {
    const f = fixture();
    const key = keyPair();
    for (let index = 0; index < BROWSER_APPROVAL_MAX_RECORDS; index += 1)
      request(f.service, key.publicKey);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN)).toEqual({
      state: "unavailable",
    });
    expect(f.service.snapshot(f.ownerCookie)?.requests).toHaveLength(BROWSER_APPROVAL_MAX_RECORDS);
    f.setTime(1_000_000 + BROWSER_APPROVAL_REQUEST_TTL_MS);
    expect(f.service.request({ publicKey: key.publicKey, remember: false }, ORIGIN).state).toBe(
      "pending",
    );
  });
});
