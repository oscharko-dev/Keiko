import { describe, expect, it } from "vitest";

import { validateMemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import { buildExpirationUpdate } from "./retention.js";
import { ctx, FIXED_NOW_MS, makeRecord } from "./_support.js";

describe("buildExpirationUpdate", () => {
  it("returns a validated MemoryUpdate that patches only validity", () => {
    const m = makeRecord({ id: "m-1", validFrom: 100 });
    const u = buildExpirationUpdate(m, FIXED_NOW_MS + 60_000, ctx());
    expect(validateMemoryUpdate(u).ok).toBe(true);
    expect(u.memoryId).toBe(m.id);
    expect(u.validityPatch?.validFrom).toBe(100);
    expect(u.validityPatch?.validUntil).toBe(FIXED_NOW_MS + 60_000);
    expect(u.bodyPatch).toBeUndefined();
    expect(u.payloadPatch).toBeUndefined();
    expect(u.tagsPatch).toBeUndefined();
    expect(u.sensitivityPatch).toBeUndefined();
    expect(u.retentionHintPatch).toBeUndefined();
  });

  it("rejects newValidUntilMs equal to validFrom (zero-duration is invalid)", () => {
    const m = makeRecord({ id: "m-1", validFrom: 1_000 });
    expect(() => buildExpirationUpdate(m, 1_000, ctx())).toThrow(GovernanceError);
  });

  it("rejects newValidUntilMs less than validFrom", () => {
    const m = makeRecord({ id: "m-1", validFrom: 1_000 });
    expect(() => buildExpirationUpdate(m, 500, ctx())).toThrow(/invalid-validity-window/);
  });

  it("rejects a non-finite newValidUntilMs", () => {
    const m = makeRecord({ id: "m-1", validFrom: 1_000 });
    expect(() => buildExpirationUpdate(m, Number.POSITIVE_INFINITY, ctx())).toThrow(
      GovernanceError,
    );
    expect(() => buildExpirationUpdate(m, Number.NaN, ctx())).toThrow(GovernanceError);
  });
});
