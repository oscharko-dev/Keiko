import { describe, expect, it } from "vitest";

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
    clock.advance(10);
    release?.();
    expect(registry.inspect(first.cookieToken)).toBeUndefined();
    expect(registry.inspect(replacement.cookieToken)?.lastSeenAtMs).toBe(1);
    expect(registry.sessionCount()).toBe(1);
  });

  it.each(["revocation", "rotation", "absolute-expiry"] as const)(
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
      const rotated = cause === "rotation" ? registry.rotate(mint.session.sessionId) : undefined;
      clock.advance(cause === "absolute-expiry" ? 151 : 70);
      expect(registry.inspect(mint.cookieToken)).toBeUndefined();
      release?.();
      expect(registry.inspect(mint.cookieToken)).toBeUndefined();
      if (rotated !== undefined) {
        expect(registry.inspect(rotated.cookieToken)?.lastSeenAtMs).toBe(50);
        clock.advance(31);
        expect(registry.inspect(rotated.cookieToken)).toBeUndefined();
      }
    },
  );

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
