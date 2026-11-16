import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkProperty,
  runSeed,
  seededRandom,
  shrinkArray,
  shrinkString,
  shrinkWithin,
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
    expect(run).toThrow(
      /case seed \d+, base seed 3; replay with KEIKO_PROPERTY_SEED=\d+ KEIKO_PROPERTY_RUNS=1\) for input "!": bang/u,
    );
  });

  it("replays one failing case from the seed its report names", () => {
    const failing = (seed: number): void => {
      checkProperty(
        (random) => random.integer(0, 999),
        (input) => {
          if (input % 7 === 3) throw new Error(`hit ${String(input)}`);
        },
        { seed, runs: 200 },
      );
    };
    const report = ((): string => {
      try {
        failing(11);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();
    const caseSeed = /case seed (\d+)/u.exec(report)?.[1] ?? "";
    const hit = /: (hit \d+)$/u.exec(report)?.[1] ?? "";
    vi.stubEnv("KEIKO_PROPERTY_SEED", caseSeed);
    vi.stubEnv("KEIKO_PROPERTY_RUNS", "1");
    expect(() => {
      failing(11);
    }).toThrow(`run 0 (case seed ${caseSeed}`);
    expect(() => {
      failing(11);
    }).toThrow(hit);
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

  it("keeps a narrowed shrink inside the generator's class", () => {
    const keepsNul = shrinkWithin(shrinkString, (text) => text.includes("\u0000"));
    expect([...keepsNul("a\u0000b")]).toEqual(["\u0000b", "\u0000b", "a\u0000"]);
    expect(() => {
      checkProperty(
        () => "abc\u0000def",
        (text) => {
          if (text.includes("\u0000")) throw new Error("refused");
        },
        { runs: 1, shrink: keepsNul },
      );
    }).toThrow(/for input "\\u0000": refused/u);
  });
});
