import { describe, expect, it } from "vitest";

import {
  validateMemoryArchive,
  validateMemoryPin,
  validateMemoryUnpin,
} from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import { buildArchiveOperation, buildPinOperation, buildUnpinOperation } from "./status-ops.js";
import { ctx, FIXED_NOW_MS, makeRecord } from "./_support.js";

describe("buildPinOperation", () => {
  it("returns a validated MemoryPin for an unpinned memory", () => {
    const m = makeRecord({ id: "m-1", pinned: false });
    const env = buildPinOperation(m, ctx());
    expect(validateMemoryPin(env).ok).toBe(true);
    expect(env.memoryId).toBe(m.id);
    expect(env.pinnedAt).toBe(FIXED_NOW_MS);
    expect(env.reason).toBeUndefined();
  });

  it("threads an explicit reason onto the envelope", () => {
    const m = makeRecord({ id: "m-1", pinned: false });
    const env = buildPinOperation(m, ctx(), "elevate to always-on rule");
    expect(env.reason).toBe("elevate to always-on rule");
  });

  it("throws idempotent-noop when memory is already pinned", () => {
    const m = makeRecord({ id: "m-1", pinned: true });
    expect(() => buildPinOperation(m, ctx())).toThrow(/idempotent-noop/);
  });

  it("throws a GovernanceError instance specifically", () => {
    const m = makeRecord({ id: "m-1", pinned: true });
    try {
      buildPinOperation(m, ctx());
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceError);
      expect((err as GovernanceError).code).toBe("idempotent-noop");
    }
  });
});

describe("buildUnpinOperation", () => {
  it("returns a validated MemoryUnpin for a pinned memory", () => {
    const m = makeRecord({ id: "m-1", pinned: true });
    const env = buildUnpinOperation(m, ctx());
    expect(validateMemoryUnpin(env).ok).toBe(true);
    expect(env.memoryId).toBe(m.id);
    expect(env.unpinnedAt).toBe(FIXED_NOW_MS);
  });

  it("threads an explicit reason onto the envelope", () => {
    const m = makeRecord({ id: "m-1", pinned: true });
    const env = buildUnpinOperation(m, ctx(), "user removed pin");
    expect(env.reason).toBe("user removed pin");
  });

  it("throws idempotent-noop when memory is already unpinned", () => {
    const m = makeRecord({ id: "m-1", pinned: false });
    expect(() => buildUnpinOperation(m, ctx())).toThrow(/idempotent-noop/);
  });
});

describe("buildArchiveOperation", () => {
  it("returns a validated MemoryArchive for an accepted memory", () => {
    const m = makeRecord({ id: "m-1", status: "accepted" });
    const env = buildArchiveOperation(m, ctx(), "no longer relevant");
    expect(validateMemoryArchive(env).ok).toBe(true);
    expect(env.memoryId).toBe(m.id);
    expect(env.archivedAt).toBe(FIXED_NOW_MS);
    expect(env.reason).toBe("no longer relevant");
  });

  it("throws idempotent-noop when memory is already archived", () => {
    const m = makeRecord({ id: "m-1", status: "archived" });
    expect(() => buildArchiveOperation(m, ctx())).toThrow(/idempotent-noop/);
  });

  it("throws memory-not-eligible when memory is forgotten", () => {
    const m = makeRecord({ id: "m-1", status: "forgotten" });
    try {
      buildArchiveOperation(m, ctx());
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceError);
      expect((err as GovernanceError).code).toBe("memory-not-eligible");
    }
  });

  it("throws illegal-status-transition when memory is rejected", () => {
    const m = makeRecord({ id: "m-1", status: "rejected" });
    try {
      buildArchiveOperation(m, ctx());
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceError);
      expect((err as GovernanceError).code).toBe("illegal-status-transition");
    }
  });

  it("permits archiving from superseded, conflicted, expired (per MEMORY_STATUS_TRANSITIONS)", () => {
    for (const status of ["superseded", "conflicted", "expired"] as const) {
      const m = makeRecord({ id: `m-${status}`, status });
      const env = buildArchiveOperation(m, ctx());
      expect(validateMemoryArchive(env).ok).toBe(true);
    }
  });
});
