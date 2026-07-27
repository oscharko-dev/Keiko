// Shared evaluation-gate helpers (ADR-0152 D5). The helpers operate on structural metric records
// and injected fixture runners only; they never import a system under test or persist evidence.

import type {
  EvalBudget,
  EvalFloorResult,
  RegressionProbeResult,
} from "@oscharko-dev/keiko-contracts";

export type MinimumFloorResult<Metric extends string = string> = EvalFloorResult<Metric>;
export type { EvalBudget, EvalFloorResult, RegressionProbeResult };

export function meetsFiniteFloor(value: number, minimum: number): boolean {
  return Number.isFinite(value) && Number.isFinite(minimum) && value >= minimum;
}

export function meetsFiniteCeiling(value: number, maximum: number): boolean {
  return Number.isFinite(value) && Number.isFinite(maximum) && value <= maximum;
}

export function evaluateFloors<const Metric extends string>(
  metrics: Readonly<Partial<Record<NoInfer<Metric>, number>>>,
  minimums: EvalBudget<Metric>,
): EvalFloorResult<Metric> {
  const failures: Metric[] = [];
  const metricNames = Object.keys(minimums) as Metric[];
  for (const metric of metricNames) {
    const value = metrics[metric];
    if (value === undefined || !meetsFiniteFloor(value, minimums[metric])) failures.push(metric);
  }
  return { ok: failures.length === 0, failures };
}

export function evaluateCeilings<const Metric extends string>(
  metrics: Readonly<Partial<Record<NoInfer<Metric>, number>>>,
  maximums: EvalBudget<Metric>,
): EvalFloorResult<Metric> {
  const failures: Metric[] = [];
  const metricNames = Object.keys(maximums) as Metric[];
  for (const metric of metricNames) {
    const value = metrics[metric];
    if (value === undefined || !meetsFiniteCeiling(value, maximums[metric])) failures.push(metric);
  }
  return { ok: failures.length === 0, failures };
}

export interface RegressionProbeObservation {
  readonly fixtureId: string;
  readonly droppedBelowFloors: boolean;
}

export interface RunRegressionProbesOptions<Fixture, Scorecard> {
  readonly fixtures: readonly Fixture[];
  readonly probeFixtureIds: readonly string[];
  readonly fixtureId: (fixture: Fixture) => string;
  readonly regressFixture: (fixture: Fixture) => Fixture | undefined;
  readonly runFixture: (fixture: Fixture) => Promise<Scorecard>;
  readonly droppedBelowFloors: (scorecard: Scorecard) => boolean;
  readonly observe?: (observation: RegressionProbeObservation) => void;
}

export async function runRegressionProbes<Fixture, Scorecard>(
  options: RunRegressionProbesOptions<Fixture, Scorecard>,
): Promise<RegressionProbeResult> {
  const availableIds = new Set(options.fixtures.map(options.fixtureId));
  const selectedIds = new Set(options.probeFixtureIds);
  const unresolved = options.probeFixtureIds.filter((id) => !availableIds.has(id));
  const tautological: string[] = [];
  let probed = 0;
  for (const fixture of options.fixtures) {
    const fixtureId = options.fixtureId(fixture);
    if (!selectedIds.has(fixtureId)) continue;
    const regressed = options.regressFixture(fixture);
    if (regressed === undefined) continue;
    probed += 1;
    const scorecard = await options.runFixture(regressed);
    const droppedBelowFloors = options.droppedBelowFloors(scorecard);
    options.observe?.({ fixtureId, droppedBelowFloors });
    if (!droppedBelowFloors) tautological.push(fixtureId);
  }
  return {
    ok: tautological.length === 0 && probed > 0 && unresolved.length === 0,
    tautological,
    probed,
    unresolved,
  };
}
