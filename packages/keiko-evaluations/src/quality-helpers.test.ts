import { describe, expect, it } from "vitest";

import {
  evaluateCeilings,
  evaluateFloors,
  meetsFiniteCeiling,
  meetsFiniteFloor,
  runRegressionProbes,
} from "./quality-helpers.js";

const SAMPLES = [0, 0.5, 0.999, 1, 1.5] as const;

describe("evaluateFloors", () => {
  it("is monotonic, reports every strict failure, and equals the floor conjunction", () => {
    for (const floor of SAMPLES) {
      for (const left of SAMPLES) {
        for (const right of SAMPLES) {
          const result = evaluateFloors({ left, right }, { left: floor, right: floor });
          expect(result.ok).toBe(left >= floor && right >= floor);
          expect(result.failures.includes("left")).toBe(left < floor);
          expect(result.failures.includes("right")).toBe(right < floor);
          const raised = evaluateFloors(
            { left: left + 1, right: right + 1 },
            { left: floor, right: floor },
          );
          if (result.ok) expect(raised.ok).toBe(true);
        }
      }
    }
  });

  it("admits no epsilon below a hard 1.0 floor", () => {
    expect(evaluateFloors({ isolation: 1 }, { isolation: 1 })).toEqual({
      ok: true,
      failures: [],
    });
    expect(evaluateFloors({ isolation: 1 - Number.EPSILON }, { isolation: 1 })).toEqual({
      ok: false,
      failures: ["isolation"],
    });
    expect(evaluateFloors({ isolation: 1 }, { isolation: 1 })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails closed for a non-finite metric value (%s)",
    (value) => {
      expect(evaluateFloors({ quality: value }, { quality: 0 })).toEqual({
        ok: false,
        failures: ["quality"],
      });
      expect(meetsFiniteFloor(value, 0)).toBe(false);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails closed for a non-finite floor (%s)",
    (floor) => {
      expect(evaluateFloors({ quality: 1 }, { quality: floor })).toEqual({
        ok: false,
        failures: ["quality"],
      });
      expect(meetsFiniteFloor(1, floor)).toBe(false);
    },
  );
});

describe("evaluateCeilings", () => {
  it("reports strict, missing, and non-finite failures through the shared evaluator", () => {
    expect(
      evaluateCeilings(
        { within: 1, over: 3, nonFinite: Number.POSITIVE_INFINITY },
        { within: 1, over: 2, missing: 1, nonFinite: 10 },
      ),
    ).toEqual({
      ok: false,
      failures: ["over", "missing", "nonFinite"],
    });
    expect(meetsFiniteCeiling(1, 1)).toBe(true);
    expect(meetsFiniteCeiling(1, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

interface ProbeFixture {
  readonly id: string;
  readonly runnable: boolean;
}

describe("runRegressionProbes", () => {
  const fixture = (id: string): ProbeFixture => ({ id, runnable: true });
  const run = (score: number): Promise<{ readonly score: number }> => Promise.resolve({ score });

  it("accepts below-floor probes and reports observations", async () => {
    const observations: string[] = [];
    const result = await runRegressionProbes({
      fixtures: [fixture("probe")],
      probeFixtureIds: ["probe"],
      fixtureId: (item) => item.id,
      regressFixture: (item) => item,
      runFixture: () => run(0),
      droppedBelowFloors: (scorecard) => scorecard.score < 1,
      observe: (observation) => observations.push(observation.fixtureId),
    });

    expect(result).toEqual({ ok: true, tautological: [], probed: 1, unresolved: [] });
    expect(observations).toEqual(["probe"]);
  });

  it("fails a tautological probe and any unresolved id regardless of other scores", async () => {
    const tautological = await runRegressionProbes({
      fixtures: [fixture("probe")],
      probeFixtureIds: ["probe"],
      fixtureId: (item) => item.id,
      regressFixture: (item) => item,
      runFixture: () => run(1),
      droppedBelowFloors: (scorecard) => scorecard.score < 1,
    });
    expect(tautological.ok).toBe(false);
    expect(tautological.tautological).toEqual(["probe"]);

    const unresolved = await runRegressionProbes({
      fixtures: [fixture("probe")],
      probeFixtureIds: ["probe", "missing"],
      fixtureId: (item) => item.id,
      regressFixture: (item) => item,
      runFixture: () => run(0),
      droppedBelowFloors: (scorecard) => scorecard.score < 1,
    });
    expect(unresolved).toEqual({
      ok: false,
      tautological: [],
      probed: 1,
      unresolved: ["missing"],
    });
  });

  it("fails closed when every selected probe is non-runnable", async () => {
    const result = await runRegressionProbes({
      fixtures: [{ id: "probe", runnable: false }],
      probeFixtureIds: ["probe"],
      fixtureId: (item) => item.id,
      regressFixture: (item) => (item.runnable ? item : undefined),
      runFixture: () => run(0),
      droppedBelowFloors: (scorecard) => scorecard.score < 1,
    });
    expect(result).toEqual({ ok: false, tautological: [], probed: 0, unresolved: [] });
  });
});
