// Type-aware decay multiplier tests (systems consolidation / semanticization). Pins the recommended
// preset ordering (episodic fades fastest; procedural is most durable) and the pure lookup's
// fail-safe behaviour: a partial override tunes one type while the rest fall back to the preset, and
// a malformed override can never zero or invert a memory's decay.

import { describe, expect, it } from "vitest";
import {
  MEMORY_TYPES,
  MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS,
  decayHalfLifeMultiplierForType,
} from "./memory.js";
import type { MemoryType } from "./memory.js";

describe("MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS", () => {
  it("covers every memory type (total table — a new type surfaces as a compile+runtime gap)", () => {
    for (const type of MEMORY_TYPES) {
      expect(MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS[type]).toBeGreaterThan(0);
    }
  });

  it("orders durability the way systems consolidation predicts", () => {
    const m = MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS;
    // Episodic (specific events) fades faster than the flat baseline; the semantic/skill stores persist.
    expect(m.episodic).toBeLessThan(1);
    expect(m.procedural).toBeGreaterThanOrEqual(m["semantic-fact"]);
    expect(m["semantic-fact"]).toBeGreaterThan(1);
    expect(m.preference).toBeGreaterThan(1);
    // Episodic is the most volatile of all types.
    for (const type of MEMORY_TYPES) {
      expect(m.episodic).toBeLessThanOrEqual(m[type]);
    }
  });
});

describe("decayHalfLifeMultiplierForType", () => {
  it("returns the preset when no override is supplied", () => {
    for (const type of MEMORY_TYPES) {
      expect(decayHalfLifeMultiplierForType(type)).toBe(
        MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS[type],
      );
    }
  });

  it("honours a partial override and falls back to the preset for untuned types", () => {
    const overrides: Partial<Record<MemoryType, number>> = { episodic: 0.25 };
    expect(decayHalfLifeMultiplierForType("episodic", overrides)).toBe(0.25);
    // An untuned type keeps the recommended preset, never a silent 1.
    expect(decayHalfLifeMultiplierForType("procedural", overrides)).toBe(
      MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS.procedural,
    );
  });

  it("ignores a malformed override so decay can never be zeroed or inverted", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decayHalfLifeMultiplierForType("episodic", { episodic: bad })).toBe(
        MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS.episodic,
      );
    }
  });
});
