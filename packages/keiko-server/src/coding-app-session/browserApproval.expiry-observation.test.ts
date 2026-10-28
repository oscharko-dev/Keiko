import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  browserApprovalChallengeText,
  type BrowserApprovalPublicKey,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { createInMemoryUiStore } from "../store/index.js";
import type { BrowserApprovalStore, StoredBrowserApproval } from "../store/browserApprovals.js";
import {
  createBrowserApprovalService,
  type BrowserApprovalService,
  type BrowserApprovalCompletion,
} from "./browserApproval.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const ORIGIN = "http://127.0.0.1:1983";
const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
type Observation = "challenge" | "proof" | "unrelated-request";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function keyPair(): {
  readonly publicKey: BrowserApprovalPublicKey;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = pair.publicKey.export({ format: "jwk" });
  if (key.x === undefined || key.y === undefined) throw new Error("Missing fixture public key");
  return { publicKey: { x: key.x, y: key.y }, privateKey: pair.privateKey };
}

function approve(
  service: BrowserApprovalService,
  store: BrowserApprovalStore,
  owner: string,
  key: BrowserApprovalPublicKey,
): StoredBrowserApproval {
  const result = service.request({ publicKey: key, remember: true }, ORIGIN);
  if (result.state !== "pending") throw new Error("Missing fixture request");
  expect(
    service.approve(owner, {
      requestId: result.request.requestId,
      comparisonCode: result.request.comparisonCode,
      remember: true,
    }),
  ).toBe(true);
  const approval = store.list().find((entry) => entry.publicKey.x === key.x);
  if (approval === undefined) throw new Error("Missing fixture approval");
  return approval;
}

function proof(
  service: BrowserApprovalService,
  approvalId: string,
  key: KeyObject,
): {
  readonly challengeId: string;
  readonly signature: string;
} {
  const result = service.challenge({ purpose: "renew", subjectId: approvalId }, ORIGIN);
  if (result.state !== "challenge") throw new Error("Missing fixture challenge");
  return {
    challengeId: result.challenge.challengeId,
    signature: sign("sha256", Buffer.from(browserApprovalChallengeText(result.challenge)), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
  };
}

function cookie(result: BrowserApprovalCompletion): string {
  if (result.state !== "active") throw new Error("Missing fixture session");
  return result.mint.cookieToken;
}

interface Fixture {
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly service: BrowserApprovalService;
  readonly expired: StoredBrowserApproval;
  readonly key: BrowserApprovalPublicKey;
  readonly cookies: Readonly<Record<"expired" | "other" | "launcher", string>>;
  readonly pendingProof: ReturnType<typeof proof>;
  readonly events: readonly ServerLogEvent[];
  readonly setTime: (time: number) => void;
}

function fixture(): Fixture {
  const uiStore = createInMemoryUiStore();
  stores.push(uiStore);
  const store = uiStore.browserApprovals;
  if (store === undefined) throw new Error("Missing fixture store");
  let now = 1_000;
  const clock = (): number => now;
  const events: ServerLogEvent[] = [];
  const registry = createSessionRegistry({
    now: clock,
    observeApprovalExpiry: store.observeTime,
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
  const service = createBrowserApprovalService({ registry, store, now: clock });
  const key = keyPair();
  const expired = approve(
    service,
    store,
    registry.mint("initial owner").cookieToken,
    key.publicKey,
  );
  now = expired.expiresAtMs - 2_000;
  const expiredCookie = cookie(
    service.prove(proof(service, expired.approvalId, key.privateKey), ORIGIN),
  );
  const ownerCookie = registry.mint("current owner").cookieToken;
  const otherKey = keyPair();
  const other = approve(service, store, ownerCookie, otherKey.publicKey);
  const otherCookie = cookie(
    service.prove(proof(service, other.approvalId, otherKey.privateKey), ORIGIN),
  );
  return {
    registry,
    service,
    expired,
    key: key.publicKey,
    cookies: { expired: expiredCookie, other: otherCookie, launcher: ownerCookie },
    pendingProof: proof(service, expired.approvalId, key.privateKey),
    events,
    setTime: (time: number): void => {
      now = time;
    },
  };
}

function observeExpiry(f: Fixture, observation: Observation): void {
  f.setTime(f.expired.expiresAtMs);
  switch (observation) {
    case "challenge":
      expect(
        f.service.challenge({ purpose: "renew", subjectId: f.expired.approvalId }, ORIGIN),
      ).toEqual({ state: "unavailable" });
      break;
    case "proof":
      expect(f.service.prove(f.pendingProof, ORIGIN)).toEqual({ state: "unavailable" });
      break;
    case "unrelated-request":
      expect(f.service.request({ publicKey: f.key, remember: false }, ORIGIN).state).toBe(
        "pending",
      );
  }
  f.setTime(f.expired.expiresAtMs - 1_000);
}

describe.each(["challenge", "proof", "unrelated-request"] as const)(
  "approval expiry first observed by %s",
  (observation) => {
    it.each(["expired", "other", "launcher"] as const)(
      "retains only valid %s session authority after clock correction",
      (target) => {
        const f = fixture();
        observeExpiry(f, observation);
        expect(f.registry.verify(f.cookies[target]) !== undefined).toBe(target !== "expired");
      },
    );

    it("retains the persisted renewal refusal after clock correction", () => {
      const f = fixture();
      observeExpiry(f, observation);
      expect(
        f.service.challenge({ purpose: "renew", subjectId: f.expired.approvalId }, ORIGIN),
      ).toEqual({ state: "unavailable" });
    });
  },
);

describe("existing expiry authority controls", () => {
  it.each(["inspect", "rotate", "release", "repair"] as const)(
    "persists grant expiry first observed by registry %s before any later renewal",
    (observer) => {
      const f = fixture();
      const release = f.registry.beginOperation(f.cookies.expired);
      f.setTime(f.expired.expiresAtMs);
      switch (observer) {
        case "inspect":
          f.registry.inspect(f.cookies.expired);
          break;
        case "rotate":
          f.registry.rotate(f.cookies.expired.split(".")[0] ?? "");
          break;
        case "release":
          release?.();
          break;
        case "repair":
          f.registry.verifyForCookieRepair(f.cookies.expired);
          break;
      }
      f.setTime(f.expired.expiresAtMs - 1_000);
      expect(
        f.service.challenge({ purpose: "renew", subjectId: f.expired.approvalId }, ORIGIN),
      ).toEqual({ state: "unavailable" });
      expect(f.registry.verify(f.cookies.other)).toBeDefined();
      expect(f.registry.verify(f.cookies.launcher)).toBeDefined();
      release?.();
    },
  );
  it("records associated-session expiry without private identity or bearer material", () => {
    const f = fixture();
    observeExpiry(f, "unrelated-request");
    const events = f.events.filter((event) => event.op === "coding-app-session.expired");
    expect(events).toHaveLength(1);
    expectActivityLogProof(
      "coding-app-session.expired.observation",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(events[0]?.extra?.expiredSessionCount).toBe(1);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(f.expired.approvalId);
    for (const token of Object.values(f.cookies)) expect(wire).not.toContain(token);
  });
  it("accepts the same grant before its original expiry", () => {
    const f = fixture();
    f.setTime(f.expired.expiresAtMs - 1_000);
    expect(f.registry.verify(f.cookies.expired)).toBeDefined();
    expect(f.registry.verify(f.cookies.other)).toBeDefined();
    expect(f.registry.verify(f.cookies.launcher)).toBeDefined();
  });

  it.each(["registry", "revoke"] as const)(
    "retains the existing %s first-observer refusal",
    (observer) => {
      const f = fixture();
      f.setTime(f.expired.expiresAtMs);
      if (observer === "registry") expect(f.registry.inspect(f.cookies.expired)).toBeUndefined();
      else expect(f.service.revoke(f.cookies.launcher, f.expired.approvalId)).toBe(true);
      f.setTime(f.expired.expiresAtMs - 1_000);
      expect(f.registry.verify(f.cookies.expired)).toBeUndefined();
      expect(f.registry.verify(f.cookies.other)).toBeDefined();
      expect(f.registry.verify(f.cookies.launcher)).toBeDefined();
    },
  );
});
