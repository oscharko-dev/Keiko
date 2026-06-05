// Frozen-profile guard: the exposed profile table and every profile inside it must be deep-frozen
// so a misbehaving caller cannot mutate the deny-list at runtime.

import { describe, expect, it } from "vitest";
import {
  applyQualityIntelligenceRetention,
  type QualityIntelligenceRunSnapshotEntry,
} from "../retention.js";
import {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
  QUALITY_INTELLIGENCE_RETENTION_PROFILES,
  getQualityIntelligenceRetentionProfile,
} from "../retentionPolicy.js";

describe("QUALITY_INTELLIGENCE_RETENTION_PROFILES", () => {
  it("ships three profiles with stable ids", () => {
    expect(Object.keys(QUALITY_INTELLIGENCE_RETENTION_PROFILES).sort()).toEqual([
      "qi:long-365d",
      "qi:short-30d",
      "qi:standard-90d",
    ]);
  });

  it("default profile id is qi:short-30d", () => {
    expect(QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID).toBe("qi:short-30d");
  });

  it("is frozen at the table level", () => {
    expect(Object.isFrozen(QUALITY_INTELLIGENCE_RETENTION_PROFILES)).toBe(true);
  });

  it("each profile is individually frozen", () => {
    for (const profile of Object.values(QUALITY_INTELLIGENCE_RETENTION_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });

  it("getQualityIntelligenceRetentionProfile returns undefined for unknown ids", () => {
    expect(getQualityIntelligenceRetentionProfile("qi:does-not-exist")).toBeUndefined();
  });
});

describe("applyQualityIntelligenceRetention — keep newest N", () => {
  function entry(runId: string, recordedAt: number): QualityIntelligenceRunSnapshotEntry {
    return { runId, recordedAt, retentionPolicyId: "qi:short-30d" };
  }

  it("retains everything when count and age both under thresholds", () => {
    const now = 1_700_000_000_000;
    const result = applyQualityIntelligenceRetention({
      snapshot: [entry("a", now - 1000), entry("b", now - 2000)],
      now,
    });
    expect(result.expiredRunIds).toEqual([]);
    expect([...result.retainedRunIds].sort()).toEqual(["a", "b"]);
  });

  it("expires runs older than the profile's retainedDays", () => {
    const now = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const result = applyQualityIntelligenceRetention({
      snapshot: [entry("old", now - 40 * dayMs), entry("fresh", now - 10 * dayMs)],
      now,
    });
    expect(result.expiredRunIds).toEqual(["old"]);
    expect(result.retainedRunIds).toEqual(["fresh"]);
    expect(result.decisions.find((d) => d.runId === "old")?.reason).toBe("age-exceeded");
  });

  it("when count exceeds maxRunArtifacts, expires the oldest (keep newest N)", () => {
    // qi:short-30d has maxRunArtifacts=100. Build 101 fresh entries and verify the oldest 1 expires.
    const now = 1_700_000_000_000;
    const snapshot = Array.from({ length: 101 }, (_, i) =>
      entry(`r${String(i).padStart(3, "0")}`, now - i),
    );
    const result = applyQualityIntelligenceRetention({ snapshot, now });
    expect(result.expiredRunIds).toEqual(["r100"]);
    expect(result.decisions.find((d) => d.runId === "r100")?.reason).toBe("count-exceeded");
  });

  it("retains everything for an unknown profile id (forward-compat)", () => {
    const now = 1_700_000_000_000;
    const result = applyQualityIntelligenceRetention({
      snapshot: [{ runId: "future", recordedAt: 0, retentionPolicyId: "qi:from-the-future" }],
      now,
    });
    expect(result.expiredRunIds).toEqual([]);
    expect(result.retainedRunIds).toEqual(["future"]);
  });
});
