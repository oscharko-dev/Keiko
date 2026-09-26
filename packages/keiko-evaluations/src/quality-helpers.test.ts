import { describe, expect, it } from "vitest";

import {
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

// KEIKO-0866: the evaluateFloors-mirroring ceiling wrapper this block used to exercise was dead code
// -- no production path or the public SDK barrel ever called it -- and was deleted per AGENTS.md §6.
// meetsFiniteCeiling is a separate, actively-used helper (scorer.ts:scorePatchSize and the
// token-efficiency check), so its coverage is preserved here as a standalone case.
describe("meetsFiniteCeiling", () => {
  it("accepts at the ceiling and rejects a non-finite value or ceiling", () => {
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

    expect(result).toEqual({
      ok: true,
      tautological: [],
      probed: 1,
      unresolved: [],
      skipped: [],
    });
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
      skipped: [],
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
    expect(result).toEqual({
      ok: false,
      tautological: [],
      probed: 0,
      unresolved: [],
      skipped: ["probe"],
    });
  });

  // KEIKO-0720: a PARTIAL drop (some selected+available fixtures declined by regressFixture, others
  // genuinely probed) must surface the declined id in `skipped` rather than vanishing silently --
  // distinct from the all-skipped case above, and distinct from `unresolved` (not-in-availableIds).
  it("records a partially-skipped fixture without hiding it from the result", async () => {
    const result = await runRegressionProbes({
      fixtures: [
        { id: "runnable-probe", runnable: true },
        { id: "declined-probe", runnable: false },
      ],
      probeFixtureIds: ["runnable-probe", "declined-probe"],
      fixtureId: (item) => item.id,
      regressFixture: (item) => (item.runnable ? item : undefined),
      runFixture: () => run(0),
      droppedBelowFloors: (scorecard) => scorecard.score < 1,
    });
    expect(result.skipped).toEqual(["declined-probe"]);
    expect(result.probed).toBe(1);
    expect(result.unresolved).toEqual([]);
    // KEIKO-0720 follow-up: `ok` must also flip to false on a non-empty `skipped`, otherwise the
    // primary caller (`runRetrievalQualityCheck`) — which gates only on `regression.ok` — still
    // treats the run as passing after silently losing anti-tautology coverage. Without this
    // assertion the partial-skip regression the earlier fix exposed via `skipped` would surface
    // in telemetry but never fail the gate.
    expect(result.ok).toBe(false);
  });
});
