import { describe, expect, it } from "vitest";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import {
  effectiveStrength,
  planMemoryMaintenance,
  MEMORY_MAINTENANCE_DEFAULTS,
  type MemoryAccessStatLike,
  type MemoryMaintenancePlan,
} from "./maintenance.js";
import { makeRecord } from "./_support.js";

const DAY = 864e5;
const NOW = 1_700_000_000_000;

function stats(
  entries: readonly [string, MemoryAccessStatLike][],
): ReadonlyMap<MemoryId, MemoryAccessStatLike> {
  const map = new Map<MemoryId, MemoryAccessStatLike>();
  for (const [id, stat] of entries) map.set(id as MemoryId, stat);
  return map;
}

function emptyStats(): ReadonlyMap<MemoryId, MemoryAccessStatLike> {
  return new Map();
}

function planFor(
  records: readonly MemoryRecord[],
  accessStats: ReadonlyMap<MemoryId, MemoryAccessStatLike>,
  nowMs = NOW,
): MemoryMaintenancePlan {
  return planMemoryMaintenance(records, accessStats, { nowMs });
}

describe("effectiveStrength", () => {
  it("returns 1 for a pinned record regardless of confidence/recency", () => {
    const r = makeRecord({ id: "m", pinned: true, confidence: 0.1, createdAt: NOW - 400 * DAY });
    expect(effectiveStrength(r, undefined, NOW)).toBe(1);
  });

  it("equals confidence when freshly created and never accessed", () => {
    const r = makeRecord({ id: "m", confidence: 0.8, createdAt: NOW });
    // freqBoost = 1, recencyFactor = exp(0) = 1 => strength = confidence
    expect(effectiveStrength(r, undefined, NOW)).toBeCloseTo(0.8, 10);
  });

  it("halves the recency factor after exactly one half-life with no access", () => {
    const r = makeRecord({ id: "m", confidence: 0.8, createdAt: NOW - 45 * DAY });
    // recencyFactor = 0.5, freqBoost = 1 => 0.4
    expect(effectiveStrength(r, undefined, NOW)).toBeCloseTo(0.4, 6);
  });

  it("applies the frequency boost from access count", () => {
    const r = makeRecord({ id: "m", confidence: 0.5, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 10 }]]);
    const expected = 0.5 * (1 + 0.15 * Math.log1p(10));
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(expected, 10);
  });

  it("uses lastAccessedAt (not createdAt) for the recency factor when present", () => {
    const r = makeRecord({ id: "m", confidence: 0.8, createdAt: NOW - 90 * DAY });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 0 }]]);
    // recent touch resets decay => strength back to ~confidence
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(0.8, 6);
  });

  it("clamps to [0,1]", () => {
    const r = makeRecord({ id: "m", confidence: 1, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 1000 }]]);
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBe(1);
  });
});

describe("planMemoryMaintenance — promote", () => {
  it("promotes a strong public proposed memory", () => {
    const r = makeRecord({
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.6,
      createdAt: NOW,
    });
    expect(planFor([r], emptyStats()).promote).toEqual(["m"]);
  });

  it("does not promote a confidential proposed memory", () => {
    const r = makeRecord({
      id: "m",
      status: "proposed",
      sensitivity: "confidential",
      confidence: 0.9,
      createdAt: NOW,
    });
    expect(planFor([r], emptyStats()).promote).toEqual([]);
  });

  it("does not promote when strength is below 0.45", () => {
    const r = makeRecord({
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.44,
      createdAt: NOW,
    });
    expect(planFor([r], emptyStats()).promote).toEqual([]);
  });

  it("promotes exactly at the 0.45 boundary", () => {
    const r = makeRecord({
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.45,
      createdAt: NOW,
    });
    expect(planFor([r], emptyStats()).promote).toEqual(["m"]);
  });
});

describe("planMemoryMaintenance — reinforce", () => {
  it("reinforces an accepted, frequently-recalled, recent memory", () => {
    const r = makeRecord({ id: "m", status: "accepted", confidence: 0.7, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 5 }]]);
    const plan = planFor([r], s);
    expect(plan.reinforce).toHaveLength(1);
    expect(plan.reinforce[0]?.id).toBe("m");
    // confidence + 0.1; asserted with closeTo to absorb IEEE-754 round-off (0.7 + 0.1).
    expect(plan.reinforce[0]?.confidence).toBeCloseTo(0.8, 10);
  });

  it("caps reinforced confidence at 0.98", () => {
    const r = makeRecord({ id: "m", status: "accepted", confidence: 0.95, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 5 }]]);
    expect(planFor([r], s).reinforce).toEqual([{ id: "m", confidence: 0.98 }]);
  });

  it("does not reinforce with fewer than 2 accesses", () => {
    const r = makeRecord({ id: "m", status: "accepted", confidence: 0.7, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 1 }]]);
    expect(planFor([r], s).reinforce).toEqual([]);
  });

  it("does not reinforce when recencyFactor is below 0.6", () => {
    // 60 days with HALF_LIFE 45 => recencyFactor = 0.5^(60/45) ≈ 0.397 < 0.6
    const r = makeRecord({ id: "m", status: "accepted", confidence: 0.7, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW - 60 * DAY, accessCount: 5 }]]);
    expect(planFor([r], s).reinforce).toEqual([]);
  });
});

describe("planMemoryMaintenance — decay", () => {
  it("decays an unaccessed, stale, aged memory whose strength is still above the archive floor", () => {
    // confidence 0.7, 60 days, no access => recencyFactor ≈ 0.397 < 0.5; strength ≈ 0.278 ≥ 0.2 so
    // ARCHIVE does not pre-empt. decay => 0.7 * 0.6 = 0.42.
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.7,
      createdAt: NOW - 60 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.decay).toHaveLength(1);
    expect(plan.decay[0]?.id).toBe("m");
    expect(plan.decay[0]?.confidence).toBeCloseTo(0.42, 10);
  });

  it("floors decayed confidence at 0.05", () => {
    // A `conflicted` record dodges both archive (accepted-only) and forget (archived/proposed/
    // expired-only), so a very low confidence reaches the decay floor cleanly: 0.06 * 0.6 = 0.036,
    // floored to 0.05.
    const r = makeRecord({
      id: "m",
      status: "conflicted",
      confidence: 0.06,
      createdAt: NOW - 60 * DAY,
    });
    expect(planFor([r], emptyStats()).decay).toEqual([{ id: "m", confidence: 0.05 }]);
  });

  it("does not decay a recently-accessed memory", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.5,
      createdAt: NOW - 60 * DAY,
    });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 0 }]]);
    expect(planFor([r], s).decay).toEqual([]);
  });

  it("does not decay a young memory even if unaccessed and faint", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.5,
      createdAt: NOW - 2 * DAY,
    });
    expect(planFor([r], emptyStats()).decay).toEqual([]);
  });
});

describe("planMemoryMaintenance — archive", () => {
  it("archives an accepted memory whose strength dropped below 0.2", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.25,
      createdAt: NOW - 60 * DAY,
    });
    // strength = 0.25 * 0.397 ≈ 0.099 < 0.2, age > 3d
    expect(planFor([r], emptyStats()).archive).toEqual(["m"]);
  });

  it("prefers archive over decay (priority) for a faint accepted memory", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.25,
      createdAt: NOW - 60 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.archive).toEqual(["m"]);
    expect(plan.decay).toEqual([]);
  });
});

describe("planMemoryMaintenance — forget", () => {
  it("forgets an old archived memory", () => {
    const r = makeRecord({
      id: "m",
      status: "archived",
      confidence: 0.5,
      createdAt: NOW - 40 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.forget.map((f) => f.id)).toEqual(["m"]);
    expect(plan.forget[0]?.reason).toContain("archived");
  });

  it("forgets a very faint, old, unaccessed proposed memory", () => {
    const r = makeRecord({
      id: "m",
      status: "proposed",
      confidence: 0.1,
      createdAt: NOW - 20 * DAY,
    });
    // strength = 0.1 * 0.5^(20/45) ≈ 0.0735 < 0.1, age > 14d, no access
    expect(planFor([r], emptyStats()).forget.map((f) => f.id)).toEqual(["m"]);
  });

  it("forgets a validity-expired memory", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.9,
      createdAt: NOW - DAY,
      validUntil: NOW - 1,
    });
    expect(planFor([r], emptyStats()).forget.map((f) => f.id)).toEqual(["m"]);
  });

  it("bounds forget to 25 per run in strength-ascending order", () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 40; i += 1) {
      records.push(
        makeRecord({
          id: `a${String(i).padStart(2, "0")}`,
          status: "archived",
          confidence: 0.01 * (i + 1),
          createdAt: NOW - 40 * DAY,
        }),
      );
    }
    const plan = planFor(records, emptyStats());
    expect(plan.forget.length).toBe(25);
    // ascending strength => lowest-confidence ids first
    expect(plan.forget[0]?.id).toBe("a00");
    expect(plan.forget[24]?.id).toBe("a24");
  });
});

describe("planMemoryMaintenance — pinned protection & determinism", () => {
  it("never decays/archives/forgets a pinned memory", () => {
    const r = makeRecord({
      id: "m",
      status: "archived",
      pinned: true,
      confidence: 0.01,
      createdAt: NOW - 400 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.forget).toEqual([]);
    expect(plan.archive).toEqual([]);
    expect(plan.decay).toEqual([]);
  });

  it("assigns at most one decision per record", () => {
    const r = makeRecord({
      id: "m",
      status: "archived",
      confidence: 0.01,
      createdAt: NOW - 40 * DAY,
    });
    const plan = planFor([r], emptyStats());
    const appearances =
      plan.promote.filter((x) => x === "m").length +
      plan.reinforce.filter((x) => x.id === "m").length +
      plan.decay.filter((x) => x.id === "m").length +
      plan.archive.filter((x) => x === "m").length +
      plan.forget.filter((x) => x.id === "m").length;
    expect(appearances).toBe(1);
  });

  it("is deterministic: same input yields byte-identical output", () => {
    const records = [
      makeRecord({ id: "a", status: "accepted", confidence: 0.7, createdAt: NOW }),
      makeRecord({ id: "b", status: "archived", confidence: 0.2, createdAt: NOW - 40 * DAY }),
    ];
    const s = stats([["a", { lastAccessedAt: NOW, accessCount: 5 }]]);
    expect(JSON.stringify(planFor(records, s))).toBe(JSON.stringify(planFor(records, s)));
  });

  it("exposes a defaults object with the documented half-life", () => {
    expect(MEMORY_MAINTENANCE_DEFAULTS.halfLifeMs).toBe(45 * DAY);
  });
});
