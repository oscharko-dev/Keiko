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

  it("anchors recency on lastAccessedAt once the memory has a real access", () => {
    const r = makeRecord({ id: "m", confidence: 0.8, createdAt: NOW - 90 * DAY });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 3 }]]);
    // A genuine recall (count > 0) resets the decay anchor to lastAccessedAt (NOW), so recency = 1
    // and only the frequency boost applies.
    const expected = 0.8 * (1 + 0.15 * Math.log1p(3));
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(expected, 10);
  });

  it("anchors recency on createdAt for an outcome-only row (accessCount 0)", () => {
    // O-V1: an outcome was recorded (lastAccessedAt set) but the memory was never recalled (count 0),
    // so recency must fall back to createdAt — one half-life => 0.5, NOT the lastAccessedAt's 1.0.
    const r = makeRecord({ id: "m", confidence: 0.8, createdAt: NOW - 45 * DAY });
    const s = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 0, outcomeCount: 1, utilitySum: 0.5 }],
    ]);
    // recency 0.5 (createdAt anchor), freqBoost 1, utilityFactor 1.0 (mean 0.5) => 0.8 * 0.5 = 0.4
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(0.4, 6);
  });

  it("clamps to [0,1]", () => {
    const r = makeRecord({ id: "m", confidence: 1, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 1000 }]]);
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBe(1);
  });
});

describe("effectiveStrength — outcome-gated utility factor (O-V1)", () => {
  it("is byte-identical when the stat carries no outcome fields", () => {
    const r = makeRecord({ id: "m", confidence: 0.5, createdAt: NOW });
    const withAccess = stats([["m", { lastAccessedAt: NOW, accessCount: 4 }]]);
    const withZeroOutcomes = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 4, outcomeCount: 0, utilitySum: 0 }],
    ]);
    expect(effectiveStrength(r, withAccess.get("m" as MemoryId), NOW)).toBe(
      effectiveStrength(r, withZeroOutcomes.get("m" as MemoryId), NOW),
    );
  });

  it("boosts strength 1.5x when every outcome is positive", () => {
    const r = makeRecord({ id: "m", confidence: 0.5, createdAt: NOW });
    const s = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 0, outcomeCount: 2, utilitySum: 2 }],
    ]);
    // meanUtility 1 => factor 1.5; freqBoost 1, recency 1 => 0.5 * 1.5 = 0.75
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(0.75, 10);
  });

  it("halves strength when every outcome is negative", () => {
    const r = makeRecord({ id: "m", confidence: 0.6, createdAt: NOW });
    const s = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 0, outcomeCount: 3, utilitySum: 0 }],
    ]);
    // meanUtility 0 => factor 0.5 => 0.6 * 0.5 = 0.3
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(0.3, 10);
  });

  it("is neutral (factor 1) for a mean utility of 0.5", () => {
    const r = makeRecord({ id: "m", confidence: 0.5, createdAt: NOW });
    const s = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 0, outcomeCount: 2, utilitySum: 1 }],
    ]);
    expect(effectiveStrength(r, s.get("m" as MemoryId), NOW)).toBeCloseTo(0.5, 10);
  });
});

describe("planMemoryMaintenance — outcome-driven forgetting (O-V1)", () => {
  it("archives a negative-outcome accepted memory the neutral one would keep", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.35,
      createdAt: NOW - 4 * DAY,
    });
    // Neutral: strength ≈ 0.35 * 0.940 ≈ 0.329 ≥ 0.2 => kept.
    expect(planFor([r], emptyStats()).archive).toEqual([]);
    // Proven bad (mean 0 => 0.5x): ≈ 0.165 < 0.2, age > 3d => archived.
    const bad = stats([
      ["m", { lastAccessedAt: NOW - 4 * DAY, accessCount: 0, outcomeCount: 2, utilitySum: 0 }],
    ]);
    expect(planFor([r], bad).archive).toEqual(["m"]);
  });

  it("keeps a positive-outcome accepted memory the neutral one would archive", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.45,
      createdAt: NOW - 60 * DAY,
    });
    // Neutral: strength ≈ 0.45 * 0.397 ≈ 0.179 < 0.2 => archived.
    expect(planFor([r], emptyStats()).archive).toEqual(["m"]);
    // Proven useful (mean 1 => 1.5x): ≈ 0.268 ≥ 0.2 => survives with no decision.
    const good = stats([
      ["m", { lastAccessedAt: NOW, accessCount: 0, outcomeCount: 1, utilitySum: 1 }],
    ]);
    const plan = planFor([r], good);
    expect(plan.archive).toEqual([]);
    expect(plan.forget).toEqual([]);
    expect(plan.promote).toEqual([]);
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

describe("planMemoryMaintenance — confidence is immutable (O-V2)", () => {
  it("never emits a confidence-mutating decision (no reinforce/decay fields on the plan)", () => {
    const r = makeRecord({ id: "m", status: "accepted", confidence: 0.7, createdAt: NOW });
    const s = stats([["m", { lastAccessedAt: NOW, accessCount: 5 }]]);
    const plan = planFor([r], s);
    // The plan surface carries ONLY status-changing decisions; confidence (provenance) is never a
    // target. Reuse strengthens memories live in retrieval ranking, not by patching confidence here.
    expect(Object.keys(plan).sort()).toEqual(["archive", "forget", "promote"]);
  });

  it("leaves an aged, unaccessed, mid-strength accepted memory untouched (was a decay candidate)", () => {
    // confidence 0.7, 60 days, no access => recencyFactor ≈ 0.397; strength ≈ 0.278 ≥ archive floor
    // 0.2, so it is NOT archived. Previously this would have decayed confidence to 0.42; now it is
    // simply left alone — disuse is reflected by its live strength, not a rewritten confidence.
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.7,
      createdAt: NOW - 60 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.promote).toEqual([]);
    expect(plan.archive).toEqual([]);
    expect(plan.forget).toEqual([]);
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

  it("archives a faint accepted memory (and emits no other decision for it)", () => {
    const r = makeRecord({
      id: "m",
      status: "accepted",
      confidence: 0.25,
      createdAt: NOW - 60 * DAY,
    });
    const plan = planFor([r], emptyStats());
    expect(plan.archive).toEqual(["m"]);
    expect(plan.promote).toEqual([]);
    expect(plan.forget).toEqual([]);
  });
});

describe("planMemoryMaintenance — forget", () => {
  it("forgets an old, faint archived memory", () => {
    const r = makeRecord({
      id: "m",
      status: "archived",
      confidence: 0.3,
      createdAt: NOW - 40 * DAY,
    });
    // strength = 0.3 * 0.5^(40/45) ≈ 0.162 < 0.2 (faint) AND age > 30d => pruned.
    const plan = planFor([r], emptyStats());
    expect(plan.forget.map((f) => f.id)).toEqual(["m"]);
    expect(plan.forget[0]?.reason).toContain("archived");
  });

  it("retains a strong archived memory even when aged out (O-V5 prune guard)", () => {
    // The archive route accepts any memory regardless of strength, so a user can archive a
    // high-confidence record to de-prioritise it. Age alone must not delete it — only disuse.
    const r = makeRecord({
      id: "m",
      status: "archived",
      confidence: 0.9,
      createdAt: NOW - 40 * DAY,
    });
    // strength = 0.9 * 0.5^(40/45) ≈ 0.485 ≥ 0.2 => not faint => not pruned.
    expect(planFor([r], emptyStats()).forget).toEqual([]);
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
  it("never archives/forgets a pinned memory", () => {
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
