import { describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

import { createSessionRegistry } from "./sessionRegistry.js";

function fixedClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

describe("createSessionRegistry", () => {
  it("protects concurrent explicit operations until their final idempotent release", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100, absoluteTtlMs: 1000 });
    const mint = registry.mint("p");
    const first = registry.beginOperation(mint.cookieToken);
    const second = registry.beginOperation(mint.cookieToken);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    clock.advance(150);
    expect(registry.inspect(mint.cookieToken)).toBeDefined();
    first?.();
    clock.advance(150);
    expect(registry.inspect(mint.cookieToken)).toBeDefined();
    second?.();
    expect(registry.inspect(mint.cookieToken)?.lastSeenAtMs).toBe(300);
    clock.advance(80);
    first?.();
    second?.();
    expect(registry.inspect(mint.cookieToken)?.lastSeenAtMs).toBe(300);
    clock.advance(21);
    expect(registry.inspect(mint.cookieToken)).toBeUndefined();
  });

  it("cannot acquire operation protection for invalid or idle-expired authority", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100 });
    const mint = registry.mint("p");
    for (const token of [undefined, "malformed", `${mint.session.sessionId}.wrong`]) {
      expect(registry.beginOperation(token)).toBeUndefined();
    }
    expect(registry.inspect(mint.cookieToken)?.lastSeenAtMs).toBe(0);
    clock.advance(101);
    expect(registry.beginOperation(mint.cookieToken)).toBeUndefined();
    expect(registry.sessionCount()).toBe(0);
  });

  it("removes expired sessions before evicting an active operation", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100, maxSessions: 2 });
    const active = registry.mint("active");
    const release = registry.beginOperation(active.cookieToken);
    clock.advance(1);
    const expired = registry.mint("expired");
    clock.advance(101);
    const replacement = registry.mint("replacement");
    expect(replacement.capacityDecision).toEqual({
      expiredSessionCount: 1,
      evictedSessionClass: "none",
    });
    expect(registry.inspect(active.cookieToken)).toBeDefined();
    expect(registry.inspect(expired.cookieToken)).toBeUndefined();
    expect(registry.inspect(replacement.cookieToken)).toBeDefined();
    expect(registry.sessionCount()).toBe(2);
    release?.();
  });

  it("prefers an idle session over a valid active operation at capacity", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, maxSessions: 2 });
    const active = registry.mint("active");
    const release = registry.beginOperation(active.cookieToken);
    clock.advance(1);
    const idle = registry.mint("idle");
    clock.advance(1);
    const replacement = registry.mint("replacement");
    expect(replacement.capacityDecision).toEqual({
      expiredSessionCount: 0,
      evictedSessionClass: "inactive",
    });
    expect(registry.inspect(active.cookieToken)).toBeDefined();
    expect(registry.inspect(idle.cookieToken)).toBeUndefined();
    expect(registry.inspect(replacement.cookieToken)).toBeDefined();
    expect(registry.sessionCount()).toBe(2);
    release?.();
  });

  it("keeps capacity eviction authoritative during an active operation", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, maxSessions: 1 });
    const first = registry.mint("first");
    const release = registry.beginOperation(first.cookieToken);
    clock.advance(1);
    const replacement = registry.mint("replacement");
    expect(replacement.capacityDecision).toEqual({
      expiredSessionCount: 0,
      evictedSessionClass: "active",
    });
    clock.advance(10);
    release?.();
    expect(registry.inspect(first.cookieToken)).toBeUndefined();
    expect(registry.inspect(replacement.cookieToken)?.lastSeenAtMs).toBe(1);
    expect(registry.sessionCount()).toBe(1);
  });

  it.each(["revocation", "absolute-expiry"] as const)(
    "never revives authority after %s during an active operation",
    (cause) => {
      const clock = fixedClock(0);
      const registry = createSessionRegistry({
        now: clock.now,
        idleTtlMs: 100,
        absoluteTtlMs: 200,
      });
      const mint = registry.mint("p");
      const release = registry.beginOperation(mint.cookieToken);
      clock.advance(50);
      if (cause === "revocation") registry.revoke(mint.session.sessionId);
      clock.advance(cause === "absolute-expiry" ? 151 : 70);
      expect(registry.inspect(mint.cookieToken)).toBeUndefined();
      release?.();
      expect(registry.inspect(mint.cookieToken)).toBeUndefined();
    },
  );

  it("carries an active operation through rotation and releases the live entry after 31 minutes", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now });
    const minted = registry.mint("synthetic");
    const release = registry.beginOperation(minted.cookieToken);
    const rotated = registry.rotate(minted.session.sessionId);
    expect(rotated).toBeDefined();
    expect(registry.inspect(minted.cookieToken)).toBeUndefined();
    expect(registry.inspectOperationCount(rotated?.cookieToken)).toBe(1);
    clock.advance(31 * 60_000);
    release?.();
    expect(registry.inspectOperationCount(rotated?.cookieToken)).toBe(0);
    expect(registry.inspect(rotated?.cookieToken)?.lastSeenAtMs).toBe(clock.now());
    clock.advance(29 * 60_000);
    release?.();
    expect(registry.inspect(rotated?.cookieToken)).toBeDefined();
    clock.advance(60_000);
    expect(registry.inspect(rotated?.cookieToken)).toBeUndefined();
  });

  it("keeps a 40 minute operation valid without rotation", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now });
    const minted = registry.mint("synthetic");
    const release = registry.beginOperation(minted.cookieToken);
    clock.advance(40 * 60_000);
    expect(registry.inspect(minted.cookieToken)).toBeDefined();
    release?.();
    expect(registry.inspectOperationCount(minted.cookieToken)).toBe(0);
    expect(registry.inspect(minted.cookieToken)?.lastSeenAtMs).toBe(clock.now());
  });

  it("releases concurrent leases across repeated rotations exactly once", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100 });
    const minted = registry.mint("synthetic");
    const first = registry.beginOperation(minted.cookieToken);
    const second = registry.beginOperation(minted.cookieToken);
    registry.rotate(minted.session.sessionId);
    const rotated = registry.rotate(minted.session.sessionId);
    clock.advance(101);
    first?.();
    first?.();
    expect(registry.inspectOperationCount(rotated?.cookieToken)).toBe(1);
    clock.advance(101);
    second?.();
    expect(registry.inspectOperationCount(rotated?.cookieToken)).toBe(0);
    clock.advance(100);
    expect(registry.inspect(rotated?.cookieToken)).toBeUndefined();
  });

  it("mints a cookie token that verifies to the issued session", () => {
    const registry = createSessionRegistry();
    const mint = registry.mint("local-app-session");
    expect(mint.cookieToken).toContain(".");
    const verified = registry.verify(mint.cookieToken);
    expect(verified?.principalLabel).toBe("local-app-session");
    expect(verified?.rotationCount).toBe(0);
    expect(registry.sessionCount()).toBe(1);
  });

  it("rejects an absent, malformed, foreign, or wrong-secret cookie", () => {
    const registry = createSessionRegistry();
    const mint = registry.mint("p");
    const sessionId = mint.cookieToken.split(".")[0] ?? "";
    expect(registry.verify(undefined)).toBeUndefined();
    expect(registry.verify("")).toBeUndefined();
    expect(registry.verify("no-separator")).toBeUndefined();
    expect(registry.verify("sess_bad.secret")).toBeUndefined();
    expect(registry.verify(`${sessionId}.wrong-secret`)).toBeUndefined();
  });

  it("expires a session after the inactivity bound", () => {
    const clock = fixedClock(1_000);
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: 100,
      absoluteTtlMs: 1_000_000,
    });
    const mint = registry.mint("p");
    clock.advance(101);
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
    expect(registry.sessionCount()).toBe(0);
  });

  it("slides the inactivity window on each successful verify", () => {
    const clock = fixedClock(1_000);
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: 100,
      absoluteTtlMs: 1_000_000,
    });
    const mint = registry.mint("p");
    clock.advance(80);
    expect(registry.verify(mint.cookieToken)).toBeDefined();
    clock.advance(80);
    expect(registry.verify(mint.cookieToken)).toBeDefined();
  });

  it("does not slide the inactivity window for server-originated stream inspection", () => {
    const clock = fixedClock(1_000);
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: 100,
      absoluteTtlMs: 1_000_000,
    });
    const mint = registry.mint("p");
    clock.advance(80);
    expect(registry.inspect(mint.cookieToken)).toBeDefined();
    clock.advance(21);
    expect(registry.inspect(mint.cookieToken)).toBeUndefined();
  });

  it("expires a session after the absolute lifetime bound", () => {
    const clock = fixedClock(1_000);
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: 1_000_000,
      absoluteTtlMs: 500,
    });
    const mint = registry.mint("p");
    clock.advance(501);
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
  });

  it("rotation invalidates the prior cookie and issues a fresh one", () => {
    const registry = createSessionRegistry();
    const mint = registry.mint("p");
    const sessionId = mint.cookieToken.split(".")[0] ?? "";
    const rotated = registry.rotate(sessionId);
    expect(rotated).toBeDefined();
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
    const verified = registry.verify(rotated?.cookieToken);
    expect(verified?.rotationCount).toBe(1);
    expect(registry.sessionCount()).toBe(1);
  });

  it("revocation invalidates the cookie", () => {
    const registry = createSessionRegistry();
    const mint = registry.mint("p");
    const sessionId = mint.cookieToken.split(".")[0] ?? "";
    registry.revoke(sessionId);
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
    expect(registry.sessionCount()).toBe(0);
  });

  it("a fresh registry knows nothing of a prior process's cookie (restart expiry)", () => {
    const first = createSessionRegistry();
    const mint = first.mint("p");
    const afterRestart = createSessionRegistry();
    expect(afterRestart.verify(mint.cookieToken)).toBeUndefined();
  });

  it("caps the registry and evicts the least-recently-seen session", () => {
    const registry = createSessionRegistry({ maxSessions: 2 });
    const a = registry.mint("a");
    registry.mint("b");
    registry.mint("c");
    expect(registry.sessionCount()).toBe(2);
    expect(registry.verify(a.cookieToken)).toBeUndefined();
  });
});

it.each(["idle", "absolute"] as const)(
  "direct rotation cannot revive %s-expired registry authority",
  (kind) => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: kind === "idle" ? 50 : 1000,
      absoluteTtlMs: 100,
    });
    const minted = registry.mint("synthetic-principal");
    clock.advance(kind === "idle" ? 51 : 101);
    expect(registry.rotate(minted.session.sessionId)).toBeUndefined();
    expect(registry.sessionCount()).toBe(0);
  },
);

it("records deferred rotation and observed expiry without session identities or secrets", () => {
  const clock = fixedClock(0);
  const activityLog = createBufferedServerLogSink();
  const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100, activityLog });
  const mint = registry.mint("private-principal");
  const release = registry.beginOperation(mint.cookieToken);
  expect(
    registry.rotate(mint.session.sessionId, {
      onlyIfIdle: true,
      correlationId: "deferred-registry-audit",
    }),
  ).toBeUndefined();
  expect(registry.inspectOperationCount(mint.cookieToken)).toBe(1);
  const rotated = registry.rotate(mint.session.sessionId);
  expect(rotated).toBeDefined();
  release?.();
  clock.advance(100);
  expect(registry.inspect(rotated?.cookieToken)).toBeUndefined();
  expect(activityLog.events.map((event) => event.extra)).toEqual([
    { activeOperationCount: 1, reason: "active-operation", completeness: "complete", loss: "none" },
    {
      expiredSessionCount: 1,
      sessionCount: 0,
      reason: "inactivity",
      completeness: "complete",
      loss: "none",
    },
    {
      reason: "inactivity",
      purpose: "inspection",
      registered: true,
      sessionCount: 0,
      completeness: "complete",
      loss: "none",
    },
  ]);
  expectActivityLogProof(
    "coding-app-session.rotation.state.observation",
    formatActivityLogProofLine(activityLog.events[0] ?? {}),
  );
  const serialized = JSON.stringify(activityLog.events);
  for (const privateValue of [mint.cookieToken, mint.session.sessionId, "private-principal"])
    expect(serialized).not.toContain(privateValue);
});

it("keeps the browser credential and its lease when rotation evidence cannot be written", () => {
  const registry = createSessionRegistry({
    activityLog: {
      write: (): void => {
        throw new Error("synthetic-log-failure");
      },
    },
  });
  const mint = registry.mint("synthetic");
  const release = registry.beginOperation(mint.cookieToken);
  expect(() =>
    registry.rotate(mint.session.sessionId, {
      onlyIfIdle: true,
      correlationId: "deferred-log-failure",
    }),
  ).toThrow("synthetic-log-failure");
  expect(registry.inspectOperationCount(mint.cookieToken)).toBe(1);
  release?.();
  expect(registry.inspectOperationCount(mint.cookieToken)).toBe(0);
});

describe("valid session count and proof standing (#4370)", () => {
  it("counts only sessions that would still verify, not expired entries nothing has swept", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100 });
    registry.mint("a");
    registry.mint("b");
    expect(registry.sessionCount()).toBe(2);
    clock.advance(101);
    // Nothing verified the entries, so they are still stored, but neither can act any more.
    expect(registry.sessionCount()).toBe(0);
    const live = registry.mint("c");
    expect(registry.sessionCount()).toBe(1);
    expect(registry.inspect(live.cookieToken)).toBeDefined();
  });

  it("logs the valid count on a refusal and on an observed expiry", () => {
    const clock = fixedClock(0);
    const sink = createBufferedServerLogSink();
    const registry = createSessionRegistry({
      now: clock.now,
      idleTtlMs: 100,
      activityLog: sink,
    });
    const stale = registry.mint("stale");
    clock.advance(50);
    registry.mint("fresh-1");
    clock.advance(60);
    registry.mint("fresh-2");
    expect(registry.verify(stale.cookieToken)).toBeUndefined();
    const refusal = sink.events.find((event) => event.op === "coding-app-session.proof.refused");
    expect(refusal?.extra?.sessionCount).toBe(2);
  });

  it("classifies a presented proof without verifying or touching anything", () => {
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100 });
    expect(registry.proofStanding(undefined)).toEqual({ presented: "absent" });
    expect(registry.proofStanding("nonsense")).toEqual({ presented: "malformed" });
    const foreign = `sess_${"f".repeat(24)}.secret`;
    expect(registry.proofStanding(foreign)).toEqual({ presented: "unknown" });
    const mint = registry.mint("p");
    expect(registry.proofStanding(mint.cookieToken)).toEqual({ presented: "valid" });
    // A wrong secret still names a valid session: standing says whose session it is, nothing more.
    expect(registry.proofStanding(`${mint.session.sessionId}.wrong`).presented).toBe("valid");
    // Looking is not touching: asking never renewed the idle window.
    clock.advance(99);
    expect(registry.proofStanding(mint.cookieToken).presented).toBe("valid");
    clock.advance(1);
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
  });

  it("labels an idle-expired credential as ended even while the entry is still in the map (#4370)", () => {
    // The incident's shape: the session is no longer valid, yet nothing has swept the stored entry.
    const clock = fixedClock(0);
    const registry = createSessionRegistry({ now: clock.now, idleTtlMs: 100 });
    const mint = registry.mint("p");
    clock.advance(101);
    expect(registry.proofStanding(mint.cookieToken)).toEqual({ presented: "ended" });
    // The lookup removed nothing and logged nothing; a later observation still sees an ended one.
    expect(registry.verify(mint.cookieToken)).toBeUndefined();
    expect(registry.proofStanding(mint.cookieToken)).toEqual({ presented: "ended" });
  });

  it.each(["revoked", "evicted"] as const)(
    "labels a %s credential as ended, never as one this process did not issue",
    (how) => {
      const clock = fixedClock(0);
      const registry = createSessionRegistry({ now: clock.now, maxSessions: 1 });
      const first = registry.mint("first");
      if (how === "revoked") registry.revoke(first.session.sessionId);
      else registry.mint("second");
      expect(registry.proofStanding(first.cookieToken)).toEqual({ presented: "ended" });
    },
  );

  it("forgets the oldest issued ids beyond its bound, which then read as unknown", () => {
    const registry = createSessionRegistry({ maxSessions: 5_000 });
    const first = registry.mint("first");
    registry.revoke(first.session.sessionId);
    expect(registry.proofStanding(first.cookieToken).presented).toBe("ended");
    for (let index = 0; index < 4_100; index += 1)
      registry.revoke(registry.mint("m").session.sessionId);
    expect(registry.proofStanding(first.cookieToken).presented).toBe("unknown");
  });
});
