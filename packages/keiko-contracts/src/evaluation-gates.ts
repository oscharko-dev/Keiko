// Shared evaluation-gate shapes (Issue #2570, ADR-0152 D5). Generic evaluation behavior remains
// in keiko-evaluations; contracts owns only the cross-package structural vocabulary.

export type EvalBudget<Metric extends string = string> = Readonly<Record<Metric, number>>;

export interface EvalFloorResult<Metric extends string = string> {
  readonly ok: boolean;
  readonly failures: readonly Metric[];
}

export interface RegressionProbeResult {
  readonly ok: boolean;
  readonly tautological: readonly string[];
  readonly probed: number;
  readonly unresolved: readonly string[];
}
