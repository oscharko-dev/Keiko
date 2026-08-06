// Audit KEIKO-0053 — grounded retrieval + entailment LATENCY gate.
//
// The LATENCY counterpart of `check:grounded-retrieval-quality`. That gate drives the real
// semantic + RRF + model-reranker path but records no timing at all; `check:retrieval-latency`
// records timing but only for lexical `searchText` over a synthetic fixture. Nothing gated the
// wall-clock of embeddings, ANN, reranking, or the entailment stage ADR-0144 layered onto the same
// request — a regression there passes every existing gate and surfaces as users waiting.
//
// Shape follows check-retrieval-latency.mjs: pure exported helpers (unit-tested in
// scripts/__tests__/), a fixed fixture, discarded warmup iterations, a percentile compared against
// a generous committed ceiling. Measurement lives in keiko-server
// (`runGroundedRetrievalLatencyEval`) because the real pipeline is not reachable across the package
// boundary from a script, and it reuses the quality gate's corpus so the two cannot drift apart.
//
// Non-tautology: like check-grounded-retrieval-quality.mjs, the gate proves it can fail. It runs
// one extra sample with an artificial per-judge-call delay and asserts that sample breaches the
// budget. If an injected regression ever passes, the gate itself is broken and this fails closed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGroundedRetrievalLatencyEval } from "@oscharko-dev/keiko-server";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-grounded-retrieval-latency.budget.json");

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** Nearest-rank percentile over a copy of `samples` (ascending). `p` is 0..100. Empty → 0. */
export function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function evaluateLatencyBudget({ observedMs, budgetMs }) {
  return { ok: observedMs <= budgetMs, observedMs, budgetMs };
}

/**
 * Both percentiles must clear their ceilings. p50 catches a uniform slowdown that a p95 ceiling
 * generous enough to absorb machine variance would let through; p95 catches a tail regression that
 * leaves the median intact.
 */
export function evaluateGroundedLatency({ samples, budget }) {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const failures = [];
  if (p50 > budget.p50BudgetMs) {
    failures.push(`p50 ${p50.toFixed(1)}ms exceeds budget ${String(budget.p50BudgetMs)}ms`);
  }
  if (p95 > budget.p95BudgetMs) {
    failures.push(`p95 ${p95.toFixed(1)}ms exceeds budget ${String(budget.p95BudgetMs)}ms`);
  }
  return { ok: failures.length === 0, p50, p95, failures };
}

/**
 * The injected-regression probe's verdict. `regressedMs` is one sample taken with an artificial
 * per-judge-call delay; it MUST breach the p95 ceiling, or the budget is loose enough to absorb a
 * real regression and the gate proves nothing.
 */
export function evaluateRegressionProbe({ regressedMs, budget }) {
  const detected = regressedMs > budget.p95BudgetMs;
  return {
    detected,
    regressedMs,
    failures: detected
      ? []
      : [
          `injected ${String(budget.regressionProbe.judgeDelayMs)}ms judge delay produced ` +
            `${regressedMs.toFixed(1)}ms, still within the ${String(budget.p95BudgetMs)}ms p95 ` +
            "budget (tautological gate)",
        ],
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────────

function rejectBudgetField(field, value, requirement) {
  throw new TypeError(
    `check-grounded-retrieval-latency: budget.${field} must be ${requirement}; got ` +
      `${JSON.stringify(value)}.`,
  );
}

// Every field this gate's verdict depends on is validated before a single measurement is taken.
// Each unvalidated field is a way for the gate to report PASS while enforcing nothing:
//   * a non-positive `iterations` leaves `samples` empty, and `percentile([])` is 0 — clearing
//     every ceiling having measured nothing;
//   * a non-numeric ceiling (`"disabled"`) makes `observed > budget` false for ANY observation,
//     silently switching that percentile's check off;
//   * a `p95BudgetMs` below `p50BudgetMs` is incoherent — the tail ceiling would be tighter than
//     the median one, so the p50 check could never be the binding constraint it exists to be;
//   * a missing or non-positive probe delay injects no regression, so the non-tautology proof
//     passes without having proven anything.
// This is the same false-green class the whole change set exists to remove, so it fails loudly.
function assertIntegerAtLeast(field, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    rejectBudgetField(field, value, `an integer of at least ${String(minimum)}`);
  }
}

function assertFinitePositive(field, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    rejectBudgetField(field, value, "a finite positive number");
  }
}

export function assertMeasurableBudget(budget) {
  assertIntegerAtLeast("warmupIterations", budget.warmupIterations, 0);
  assertIntegerAtLeast("iterations", budget.iterations, 1);
  assertFinitePositive("p50BudgetMs", budget.p50BudgetMs);
  assertFinitePositive("p95BudgetMs", budget.p95BudgetMs);
  if (budget.p95BudgetMs < budget.p50BudgetMs) {
    rejectBudgetField("p95BudgetMs", budget.p95BudgetMs, "at least budget.p50BudgetMs");
  }
  assertFinitePositive("regressionProbe.judgeDelayMs", budget.regressionProbe?.judgeDelayMs);
  return budget;
}

async function collectSamples(budget) {
  for (let i = 0; i < budget.warmupIterations; i += 1) {
    await runGroundedRetrievalLatencyEval();
  }
  const samples = [];
  for (let i = 0; i < budget.iterations; i += 1) {
    samples.push((await runGroundedRetrievalLatencyEval()).totalMs);
  }
  return samples;
}

export async function runGroundedRetrievalLatencyGate({
  budgetPath = DEFAULT_BUDGET_PATH,
  log,
  fail,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`grounded-retrieval-latency check failed: ${message}`);
      process.exit(1);
    });
  // An absent or malformed budget aborts the run either way; the difference is whether CI shows a
  // named gate failure or a bare stack trace from a JSON parser.
  let budget;
  try {
    budget = assertMeasurableBudget(JSON.parse(readFileSync(budgetPath, "utf8")));
  } catch (error) {
    onFail(
      `budget unusable at ${budgetPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, p50: 0, p95: 0, failures: ["budget unusable"], probe: undefined };
  }

  const samples = await collectSamples(budget);
  const result = evaluateGroundedLatency({ samples, budget });
  onLog(
    `grounded-retrieval-latency: p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms ` +
      `over ${String(budget.iterations)} iterations (budgets ${String(budget.p50BudgetMs)}ms / ` +
      `${String(budget.p95BudgetMs)}ms).`,
  );

  const regressed = await runGroundedRetrievalLatencyEval({
    injectedJudgeDelayMs: budget.regressionProbe.judgeDelayMs,
  });
  const probe = evaluateRegressionProbe({ regressedMs: regressed.totalMs, budget });
  onLog(
    `grounded-retrieval-latency regression probe: +${String(
      budget.regressionProbe.judgeDelayMs,
    )}ms/judge-call -> ${regressed.totalMs.toFixed(1)}ms, detected=${String(probe.detected)}.`,
  );

  const failures = [...result.failures, ...probe.failures];
  if (failures.length > 0) onFail(failures.join("; "));
  return { ...result, probe, failures };
}

// Run when invoked directly, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runGroundedRetrievalLatencyGate();
}
