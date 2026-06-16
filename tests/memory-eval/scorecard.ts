// Pure scorecard accumulator for the memory evaluation harness (Epic #204 / Issue #215).
//
// All inputs are caller-supplied; the module reads no clock, no environment, no filesystem.
// `buildScorecard` accepts a `generatedAt` epoch-ms timestamp so two runs with identical
// inputs produce a byte-identical JSON serialisation. The eval-runner test asserts this.
//
// Stable serialisation: scenarios appear in the order `recordResult` was called; key order
// inside each object is fixed via explicit construction (NOT spread of unknown shape) so
// JSON.stringify produces a byte-equal output across runs.

export const EVAL_SCORECARD_SCHEMA_VERSION = "1" as const;

// A graded quality number a scenario chose to report alongside its pass/fail (recall@k, FAMA, …).
// Values are deterministic (the metric layer rounds them) so the serialised scorecard stays
// byte-stable across runs.
export interface ScenarioMetric {
  readonly name: string;
  readonly value: number;
}

export interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly evidence: string;
  // Optional graded metrics. Absent for boolean-only scenarios; present (and serialised) for the
  // graded scenarios so a quantitative regression is visible in the scorecard, not just a flipped
  // boolean. Omitted entirely when empty so the JSON shape is identical to a pre-metric scenario.
  readonly metrics?: readonly ScenarioMetric[];
}

export interface ScorecardTotals {
  readonly scenarios: number;
  readonly passed: number;
  readonly failed: number;
}

export interface EvalScorecard {
  readonly evalSchemaVersion: typeof EVAL_SCORECARD_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly totals: ScorecardTotals;
  readonly scenarios: readonly ScenarioResult[];
}

// Mutable accumulator. Scenario tests call `recordResult` once per assertion they own.
// The accumulator does NOT decide pass/fail itself; the scenario decides and reports.
export interface Scorecard {
  recordResult(
    name: string,
    passed: boolean,
    evidence: string,
    metrics?: readonly ScenarioMetric[],
  ): void;
  build(generatedAt: number): EvalScorecard;
  results(): readonly ScenarioResult[];
}

export function createScorecard(): Scorecard {
  const results: ScenarioResult[] = [];
  return {
    recordResult: (
      name: string,
      passed: boolean,
      evidence: string,
      metrics?: readonly ScenarioMetric[],
    ): void => {
      // Never write `metrics: undefined` (exactOptionalPropertyTypes) or `metrics: []` — an absent
      // or empty metric list keeps the scenario's serialised shape identical to a boolean scenario.
      results.push(
        metrics === undefined || metrics.length === 0
          ? { name, passed, evidence }
          : { name, passed, evidence, metrics },
      );
    },
    build: (generatedAt: number): EvalScorecard => buildScorecard(results, generatedAt),
    results: (): readonly ScenarioResult[] => results,
  };
}

export function buildScorecard(
  results: readonly ScenarioResult[],
  generatedAt: number,
): EvalScorecard {
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.passed) passed += 1;
    else failed += 1;
  }
  // Each scenario re-built into a fresh object literal in the canonical key order so the
  // serialiser sees a predictable shape regardless of how the caller constructed it. `metrics` is
  // appended last and ONLY when present, so boolean-only scenarios serialise exactly as before.
  const orderedScenarios: ScenarioResult[] = results.map((r) =>
    r.metrics === undefined || r.metrics.length === 0
      ? { name: r.name, passed: r.passed, evidence: r.evidence }
      : {
          name: r.name,
          passed: r.passed,
          evidence: r.evidence,
          metrics: r.metrics.map((m) => ({ name: m.name, value: m.value })),
        },
  );
  return {
    evalSchemaVersion: EVAL_SCORECARD_SCHEMA_VERSION,
    generatedAt,
    totals: { scenarios: results.length, passed, failed },
    scenarios: orderedScenarios,
  };
}

// Two-space-indented serialisation with a trailing newline. The trailing newline mirrors the
// convention `prettier` uses for *.json so the file looks idiomatic on disk and an editor
// `:wq` would not produce a noisy diff.
export function serializeScorecard(scorecard: EvalScorecard): string {
  return `${JSON.stringify(scorecard, null, 2)}\n`;
}
