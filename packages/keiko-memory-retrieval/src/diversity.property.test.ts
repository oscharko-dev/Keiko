import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  type Random,
} from "../../../tests/support/property-testing.js";
import { cosineSimilarity, reorderByMmr, type MmrItem } from "./diversity.js";

// Seeded property of the incremental MMR re-ordering (#4228): keeping each candidate's highest
// similarity to the selected vectors and raising it per pick must give exactly the order the
// definition gives, which recomputes that maximum over every selected vector on every pick.

const RUNS = 300;
const LAMBDAS = [0, 0.3, 0.5, 0.7, 0.9] as const;
// Few coarse levels, so equal MMR values occur and the original-rank tie-break is exercised.
const LEVELS = [-1, 0, 0.5, 1] as const;

interface Case {
  readonly ranked: readonly MmrItem[];
  readonly vectors: ReadonlyMap<MemoryId, Float32Array>;
  readonly lambda: number;
}

function referenceMmr(
  ranked: readonly MmrItem[],
  vectors: ReadonlyMap<MemoryId, Float32Array>,
  lambda: number,
): readonly MmrItem[] {
  if (ranked.length <= 2 || vectors.size === 0 || lambda >= 1) return [...ranked];
  const remaining = [...ranked];
  const selected: MmrItem[] = [];
  while (remaining.length > 0) {
    let bestPos = 0;
    let bestValue = -Infinity;
    remaining.forEach((cand, index) => {
      const vec = vectors.get(cand.memoryId);
      let max = 0;
      for (const chosen of selected) {
        const other = vectors.get(chosen.memoryId);
        if (vec === undefined || other === undefined) continue;
        max = Math.max(max, cosineSimilarity(vec, other));
      }
      const value = lambda * cand.score - (1 - lambda) * max;
      if (value > bestValue) {
        bestValue = value;
        bestPos = index;
      }
    });
    const [chosen] = remaining.splice(bestPos, 1);
    if (chosen !== undefined) selected.push(chosen);
  }
  return selected;
}

function generateCase(random: Random): Case {
  const size = random.integer(0, 24);
  const dims = random.integer(1, 4);
  const ranked: MmrItem[] = [];
  const vectors = new Map<MemoryId, Float32Array>();
  for (let index = 0; index < size; index += 1) {
    const memoryId = `m-${String(index)}` as MemoryId;
    ranked.push({ memoryId, score: random.integer(0, 4) / 4 });
    if (random.chance(0.8)) {
      vectors.set(
        memoryId,
        Float32Array.from({ length: dims }, () => random.pick(LEVELS)),
      );
    }
  }
  return { ranked, vectors, lambda: random.pick(LAMBDAS) };
}

describe("reorderByMmr (property)", () => {
  it("gives the order of the definition that recomputes every maximum", async () => {
    const name = "incremental MMR equals the recomputing definition";
    let reordered = 0;
    await checkProperty<Case>({
      name,
      runs: RUNS,
      generate: generateCase,
      property: ({ ranked, vectors, lambda }) => {
        const actual = reorderByMmr(ranked, vectors, lambda).map((item) => item.memoryId);
        const expected = referenceMmr(ranked, vectors, lambda).map((item) => item.memoryId);
        expect(actual).toEqual(expected);
        if (actual.some((id, index) => id !== ranked[index]?.memoryId)) reordered += 1;
      },
    });
    const { runs } = propertySettings({ name, runs: RUNS });
    // Vacuity: the diversity term actually changed the order in a good share of the cases.
    assertFrequencyFloor({
      what: "an order changed by diversity",
      count: reordered,
      runs,
      share: 0.3,
      validatedRuns: RUNS,
    });
  });
});
