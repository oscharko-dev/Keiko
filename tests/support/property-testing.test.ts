import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkProperty,
  createRandom,
  measureScaling,
  SCALING_FACTOR,
  propertySettings,
  seedOf,
  shrinkArray,
  shrinkRecord,
  shrinkString,
  unicodeString,
} from "./property-testing.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function draws(seed: number, count: number): number[] {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => random.next());
}

async function failureOf(run: Promise<void>): Promise<Error> {
  const error: unknown = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error("The property was expected to fail.");
  return error;
}

describe("seeded random", () => {
  it("repeats its sequence for one seed and differs between seeds", () => {
    expect(draws(42, 64)).toEqual(draws(42, 64));
    expect(draws(42, 64)).not.toEqual(draws(43, 64));
  });

  it("stays inside its bounds and reaches both ends", () => {
    const random = createRandom(7);
    const seen = new Set(Array.from({ length: 2_000 }, () => random.integer(-2, 2)));
    expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    expect(draws(9, 2_000).every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("refuses bounds and choices it cannot honour", () => {
    const random = createRandom(1);
    expect(() => random.integer(3, 2)).toThrow(RangeError);
    expect(() => random.integer(0.5, 2)).toThrow(RangeError);
    expect(() => random.pick([])).toThrow(RangeError);
  });

  it("gives every property name its own stable seed", () => {
    expect(seedOf("origin")).toBe(seedOf("origin"));
    expect(seedOf("origin")).not.toBe(seedOf("totality"));
  });
});

describe("checkProperty", () => {
  it("passes a property that holds and runs exactly the requested cases", async () => {
    let calls = 0;
    await checkProperty({
      name: "lengths are never negative",
      runs: 25,
      generate: unicodeString(20),
      property: (value) => {
        calls += 1;
        expect(value.length).toBeGreaterThanOrEqual(0);
      },
    });
    expect(calls).toBe(25);
  });

  it("reports the replay seed and a shrunk counterexample", async () => {
    const error = await failureOf(
      checkProperty({
        name: "no x",
        seed: 1234,
        runs: 500,
        generate: (random) =>
          `${"ab".repeat(random.integer(0, 30))}${random.chance(0.5) ? "x" : ""}`,
        shrink: shrinkString,
        property: (value) => {
          expect(value.includes("x")).toBe(false);
        },
      }),
    );
    expect(error.message).toContain('Property "no x" failed on case');
    expect(error.message).toContain("Replay: KEIKO_PROPERTY_SEED=1234");
    expect(error.message).toContain('Counterexample: "x"');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("finds the same counterexample again from the printed seed", async () => {
    const run = (): Promise<Error> =>
      failureOf(
        checkProperty({
          name: "below 900",
          runs: 50,
          generate: (random) => random.integer(0, 1_000),
          property: (value) => {
            expect(value).toBeLessThan(900);
          },
        }),
      );
    const first = await run();
    const seed = /KEIKO_PROPERTY_SEED=(\d+)/u.exec(first.message)?.[1] ?? "";
    vi.stubEnv("KEIKO_PROPERTY_SEED", seed);
    expect((await run()).message).toBe(first.message);
  });

  it("reports an async rejection like a thrown failure", async () => {
    const error = await failureOf(
      checkProperty({
        name: "async",
        runs: 3,
        generate: () => 1,
        property: () => Promise.reject(new Error("rejected")),
      }),
    );
    expect(error.message).toContain("Cause: rejected");
  });

  it("stops shrinking within its evaluation budget", async () => {
    let evaluations = 0;
    await failureOf(
      checkProperty({
        name: "always fails",
        runs: 1,
        generate: () => 0,
        // Endless smaller candidates, each failing: the budget must end the shrink.
        shrink: function* endless(value: number): Iterable<number> {
          yield value + 1;
        },
        property: () => {
          evaluations += 1;
          throw new Error("fails");
        },
      }),
    );
    expect(evaluations).toBeLessThanOrEqual(401);
  });
});

describe("settings", () => {
  it("uses the per-name seed and the default run count unless told otherwise", () => {
    expect(propertySettings({ name: "p" })).toEqual({ seed: seedOf("p"), runs: 200 });
    expect(propertySettings({ name: "p", seed: 5, runs: 9 })).toEqual({ seed: 5, runs: 9 });
  });

  it("lets the environment replay a seed and widen the runs", () => {
    vi.stubEnv("KEIKO_PROPERTY_SEED", "0");
    vi.stubEnv("KEIKO_PROPERTY_RUNS", "5000");
    expect(propertySettings({ name: "p", seed: 5, runs: 9 })).toEqual({ seed: 0, runs: 5000 });
  });

  it.each(["-1", "1.5", "abc", "4294967296", " 7"])("refuses the seed %j", (raw) => {
    vi.stubEnv("KEIKO_PROPERTY_SEED", raw);
    expect(() => propertySettings({ name: "p" })).toThrow(RangeError);
  });

  it.each(["0", "1000001", "many"])("refuses the run count %j", (raw) => {
    vi.stubEnv("KEIKO_PROPERTY_RUNS", raw);
    expect(() => propertySettings({ name: "p" })).toThrow(RangeError);
  });
});

describe("shrinkers", () => {
  it("never splits a character while shrinking a string", () => {
    const candidates = [...shrinkString("a😀b")];
    expect(candidates).toContain("");
    expect(candidates).toContain("😀b");
    expect(candidates.every((candidate) => !/[\ud800-\udfff]/u.test(candidate))).toBe(true);
  });

  it("removes items before shrinking them, and shrinks one field at a time", () => {
    expect([...shrinkArray(["ab", "c"], shrinkString)].slice(0, 2)).toEqual([["c"], ["ab"]]);
    const shrink = shrinkRecord<{ readonly a: string; readonly b: string }>({ a: shrinkString });
    expect([...shrink({ a: "xy", b: "keep" })]).toEqual([
      { a: "", b: "keep" },
      { a: "y", b: "keep" },
      { a: "x", b: "keep" },
    ]);
  });
});

describe("measureScaling", () => {
  const linear = (input: string): number => {
    let count = 0;
    for (let index = 0; index < input.length; index += 1) count += input.charCodeAt(index) & 1;
    return count;
  };
  const quadratic = (input: string): number => {
    let count = 0;
    for (let start = 0; start < input.length; start += 1)
      count += input.includes("y", start) ? 0 : 1;
    return count;
  };

  it("tells a linear scan from a quadratic one", () => {
    const build = (size: number): string => "x".repeat(size);
    const flat = measureScaling({ build, run: linear, size: 1_000, maximumSize: 4_096_000 });
    const steep = measureScaling({ build, run: quadratic, size: 250, maximumSize: 64_000 });
    expect(flat.measurable && steep.measurable, JSON.stringify({ flat, steep })).toBe(true);
    expect(flat.largeMs / flat.smallMs).toBeLessThan(SCALING_FACTOR * 2);
    expect(steep.largeMs / steep.smallMs).toBeGreaterThan(SCALING_FACTOR * 2);
  });

  it("reports a rule too fast to time as not measurable instead of guessing", () => {
    const scaling = measureScaling({ build: () => "", run: () => 0, size: 1, maximumSize: 4 });
    expect(scaling.measurable).toBe(false);
    expect(scaling.size).toBe(4);
  });
});
