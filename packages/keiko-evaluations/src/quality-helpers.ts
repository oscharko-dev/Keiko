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

// KEIKO-0720: extends the shared contracts RegressionProbeResult with a `skipped` bucket, kept as a
// keiko-evaluations-local extension (not folded into keiko-contracts' RegressionProbeResult) because
// this remediation is scoped to packages/keiko-evaluations/ only. `skipped` is distinct from
// `unresolved` (which means "not in availableIds" -- a fixture that was never even selectable):
// `skipped` means the fixture WAS selected and available, but `regressFixture` declined to produce a
// regressed variant for it. Without this, a partial silent drop is indistinguishable from a fully
// probed run, defeating the anti-tautology purpose `runRegressionProbes` exists to serve.
export interface RegressionProbeRunResult extends RegressionProbeResult {
  readonly skipped: readonly string[];
}

export async function runRegressionProbes<Fixture, Scorecard>(
  options: RunRegressionProbesOptions<Fixture, Scorecard>,
): Promise<RegressionProbeRunResult> {
  const availableIds = new Set(options.fixtures.map(options.fixtureId));
  const selectedIds = new Set(options.probeFixtureIds);
  const unresolved = options.probeFixtureIds.filter((id) => !availableIds.has(id));
  const tautological: string[] = [];
  const skipped: string[] = [];
  let probed = 0;
  for (const fixture of options.fixtures) {
    const fixtureId = options.fixtureId(fixture);
    if (!selectedIds.has(fixtureId)) continue;
    const regressed = options.regressFixture(fixture);
    if (regressed === undefined) {
      skipped.push(fixtureId);
      continue;
    }
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
    skipped,
  };
}
