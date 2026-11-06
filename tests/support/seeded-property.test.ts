import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkProperty,
  runSeed,
  seededRandom,
  shrinkArray,
  shrinkString,
} from "./seeded-property.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seeded property testing", () => {
  it("draws the same sequence from the same seed and another from another seed", () => {
    const draw = (seed: number): number[] => {
      const random = seededRandom(seed);
      return Array.from({ length: 8 }, () => random.next());
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    expect(draw(7).every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("keeps integers, strings and arrays inside their bounds", () => {
    const random = seededRandom(1);
    for (let index = 0; index < 500; index += 1) {
      const value = random.integer(-3, 3);
      expect(value >= -3 && value <= 3 && Number.isInteger(value)).toBe(true);
      const text = random.string(["a", "bc"], 2, 4);
      expect(text.replaceAll("bc", "").replaceAll("a", "")).toBe("");
      expect(random.array(1, 3, () => 0).length).toBeGreaterThanOrEqual(1);
    }
    expect(() => random.pick([])).toThrow(RangeError);
  });

  it("derives a distinct seed for every run", () => {
    const seeds = new Set(Array.from({ length: 1_000 }, (_, run) => runSeed(17, run)));
    expect(seeds.size).toBe(1_000);
  });

  it("names the seed of a failing run and shrinks its input", () => {
    const run = (): void => {
      checkProperty(
        (random) => random.string(["x", "y", "!"], 5, 20),
        (input) => {
          if (input.includes("!")) throw new Error("bang");
        },
        { seed: 3, runs: 50, shrink: shrinkString },
      );
    };
    expect(run).toThrow(/case seed \d+, base seed 3\) for input "!": bang/u);
  });

  it("passes a property that holds and refuses an invalid run count", () => {
    expect(() => {
      checkProperty(
        (random) => random.integer(0, 9),
        (input) => {
          expect(input).toBeLessThan(10);
        },
      );
    }).not.toThrow();
    vi.stubEnv("KEIKO_PROPERTY_RUNS", "0");
    expect(() => {
      checkProperty(
        () => 0,
        () => undefined,
      );
    }).toThrow(/KEIKO_PROPERTY_RUNS/u);
  });

  it("offers halves before single removals", () => {
    expect([...shrinkString("abcd")].slice(0, 3)).toEqual(["ab", "cd", "bcd"]);
    expect([...shrinkArray([1, 2, 3])]).toEqual([[1], [2, 3], [2, 3], [1, 3], [1, 2]]);
    expect([...shrinkString("")]).toEqual([]);
  });
});
