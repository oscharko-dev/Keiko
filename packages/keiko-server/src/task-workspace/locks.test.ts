// Unit coverage for the consolidated advisory-lock model (Issue #449, ADR-0093 D2). The five services
// each previously inlined `lockIsLive` + the TTL + a lock builder; this proves the single home preserves
// the exact behaviour: an explicit `expiresAt` wins, otherwise the TTL since `acquiredAt`, and a
// non-finite timestamp fails closed (treated as not live).

import { describe, expect, it } from "vitest";
import type { WorkspaceLock } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_LOCK_TTL_MS, lockIsLive, makeWorkspaceLock, resolveLockTtl } from "./locks.js";

const NOW = 1_700_000_000_000;
const TTL = 5 * 60_000;

function lock(overrides: Partial<WorkspaceLock>): WorkspaceLock {
  return {
    lockId: "lock-1",
    owner: "actor",
    reason: "provisioning",
    acquiredAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("lockIsLive", () => {
  it("treats a null lock as not live", () => {
    expect(lockIsLive(null, NOW, TTL)).toBe(false);
  });

  it("uses an explicit expiry when present (live before, stale after)", () => {
    const l = lock({ expiresAt: new Date(NOW + 1000).toISOString() });
    expect(lockIsLive(l, NOW, TTL)).toBe(true);
    expect(lockIsLive(l, NOW + 999, TTL)).toBe(true);
    expect(lockIsLive(l, NOW + 1000, TTL)).toBe(false);
    expect(lockIsLive(l, NOW + 5000, TTL)).toBe(false);
  });

  it("falls back to TTL-since-acquisition when no expiry is set", () => {
    const l = lock({});
    expect(lockIsLive(l, NOW, TTL)).toBe(true);
    expect(lockIsLive(l, NOW + TTL - 1, TTL)).toBe(true);
    expect(lockIsLive(l, NOW + TTL, TTL)).toBe(false);
  });

  it("fails closed on a non-finite expiry timestamp", () => {
    expect(lockIsLive(lock({ expiresAt: "not-a-date" }), NOW, TTL)).toBe(false);
  });

  it("fails closed on a non-finite acquiredAt timestamp", () => {
    expect(lockIsLive(lock({ acquiredAt: "garbage" }), NOW, TTL)).toBe(false);
  });
});

describe("makeWorkspaceLock", () => {
  it("builds a content-free lock with an explicit expiry ttlMs after acquisition", () => {
    let n = 0;
    const built = makeWorkspaceLock({
      newId: (): string => `lock-${String(n++)}`,
      owner: "alice",
      reason: "repair",
      nowMs: NOW,
      ttlMs: TTL,
    });
    expect(built).toEqual({
      lockId: "lock-0",
      owner: "alice",
      reason: "repair",
      acquiredAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + TTL).toISOString(),
    });
  });

  it("produces a lock that lockIsLive agrees is live at acquisition and stale at expiry", () => {
    const built = makeWorkspaceLock({
      newId: (): string => "lock-x",
      owner: "bob",
      reason: "cleanup",
      nowMs: NOW,
      ttlMs: TTL,
    });
    expect(lockIsLive(built, NOW, TTL)).toBe(true);
    expect(lockIsLive(built, NOW + TTL, TTL)).toBe(false);
  });
});

describe("resolveLockTtl", () => {
  it("returns the default when no override is given", () => {
    expect(resolveLockTtl(undefined)).toBe(DEFAULT_LOCK_TTL_MS);
    expect(DEFAULT_LOCK_TTL_MS).toBe(5 * 60_000);
  });

  it("returns the override when provided", () => {
    expect(resolveLockTtl(1234)).toBe(1234);
    expect(resolveLockTtl(0)).toBe(0);
  });
});
