import { describe, expect, it } from "vitest";

import {
  buildStrengthById,
  reinforcementStrength,
  STRENGTH_FREQUENCY_SATURATION,
  STRENGTH_HALF_LIFE_MS,
} from "./strength.js";

const NOW = 1_700_000_000_000;

describe("reinforcementStrength", () => {
  it("is 0 for a memory that was never accessed (no stat)", () => {
    expect(reinforcementStrength(undefined, NOW)).toBe(0);
  });

  it("is 0 when the access count is 0", () => {
    expect(reinforcementStrength({ accessCount: 0, lastAccessedAt: NOW }, NOW)).toBe(0);
  });

  it("rises with access frequency for an equally-recent memory", () => {
    const few = reinforcementStrength({ accessCount: 4, lastAccessedAt: NOW }, NOW);
    const many = reinforcementStrength({ accessCount: 16, lastAccessedAt: NOW }, NOW);
    expect(many).toBeGreaterThan(few);
    expect(few).toBeGreaterThan(0);
    // Saturating frequency: count == SATURATION reaches ~0.632 of the ceiling for a just-touched row.
    const atSaturation = reinforcementStrength(
      { accessCount: STRENGTH_FREQUENCY_SATURATION, lastAccessedAt: NOW },
      NOW,
    );
    expect(atSaturation).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it("halves over one disuse half-life", () => {
    const fresh = reinforcementStrength({ accessCount: 8, lastAccessedAt: NOW }, NOW);
    const oneHalfLife = reinforcementStrength(
      { accessCount: 8, lastAccessedAt: NOW - STRENGTH_HALF_LIFE_MS },
      NOW,
    );
    expect(oneHalfLife).toBeCloseTo(fresh * 0.5, 6);
  });

  it("clamps a future-dated last-access to full recency rather than exceeding 1", () => {
    const future = reinforcementStrength({ accessCount: 1000, lastAccessedAt: NOW + 1_000 }, NOW);
    expect(future).toBeGreaterThan(0);
    expect(future).toBeLessThanOrEqual(1);
    // accessCount huge => frequency ~1, recency clamped to 1 => strength ~1.
    expect(future).toBeCloseTo(1, 6);
  });

  it("stays within [0,1] across extreme inputs", () => {
    const s = reinforcementStrength({ accessCount: 1e9, lastAccessedAt: NOW }, NOW);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("buildStrengthById", () => {
  it("maps each access stat to its strength and omits zero-strength entries", () => {
    const stats = new Map<string, { accessCount: number; lastAccessedAt: number }>([
      ["reused", { accessCount: 12, lastAccessedAt: NOW }],
      ["never", { accessCount: 0, lastAccessedAt: NOW }],
    ]);
    const map = buildStrengthById(stats, NOW);
    expect(map.has("reused")).toBe(true);
    expect(map.get("reused")).toBeGreaterThan(0);
    // Zero-strength entries are dropped so the ranker treats them exactly like an absent stat.
    expect(map.has("never")).toBe(false);
  });
});
