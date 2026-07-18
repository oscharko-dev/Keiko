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
