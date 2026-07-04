// RB-5 / GEN-AI-RELEASE-GATE-001 / GEN-AI-RETRIEVAL-006 / GEN-TEST-FIXTURE-002.
//
// The shipping `check:retrieval-quality` gate scores ONLY lexical `searchText` over toy repos with
// every threshold = 1 — the production SEMANTIC retrieval + RRF fusion + model reranker + grounded
// answer path is gated by nothing. This gate closes that hole by driving the REAL functions
// (grounded-repo-semantic-search + grounded-rerank + grounded-model-reranker) over a distractor-dense
// corpus, and — critically — PROVES the gate is non-tautological by asserting that an injected
// ranking / reranker regression drops the metrics BELOW the floors. If a regression ever passed, the
// gate itself is broken and this script fails closed.

import {
  DEFAULT_GROUNDED_RETRIEVAL_BUDGET,
  GROUNDED_RETRIEVAL_REGRESSION_MODES,
  evaluateGroundedRetrievalBudget,
  runGroundedRetrievalQualityEval,
} from "@oscharko-dev/keiko-server";

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatScorecard(scorecard) {
  return (
    `mode=${scorecard.mode} cases=${String(scorecard.cases)} ` +
    `top1=${formatPct(scorecard.top1Rate)} recall@3=${formatPct(scorecard.recallAtK)} ` +
    `ndcg@3=${scorecard.ndcgAtK.toFixed(3)} citation-support=${formatPct(scorecard.citationSupport)}`
  );
}

async function runRegressionProbes(onLog) {
  const reports = [];
  for (const mode of GROUNDED_RETRIEVAL_REGRESSION_MODES) {
    const scorecard = await runGroundedRetrievalQualityEval(mode);
    const result = evaluateGroundedRetrievalBudget(scorecard);
    onLog(
      `grounded-retrieval-quality regression: ${formatScorecard(scorecard)} -> ok=${result.ok}`,
    );
    reports.push({ mode, ok: result.ok });
  }
  return reports;
}

function collectFailures(baselineResult, rerankerOffResult, regressionReports) {
  const failures = [];
  if (!baselineResult.ok)
    failures.push(`baseline below floors (${baselineResult.failures.join(", ")})`);
  if (!rerankerOffResult.ok)
    failures.push(`reranker-off control below floors (${rerankerOffResult.failures.join(", ")})`);
  for (const report of regressionReports) {
    if (report.ok) {
      failures.push(
        `injected regression '${report.mode}' did NOT drop below floors (tautological gate)`,
      );
    }
  }
  return failures;
}

export async function runGroundedRetrievalQualityGate({ log, fail } = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`grounded-retrieval-quality check failed: ${message}`);
      process.exit(1);
    });

  // 1. Baseline: the full production semantic + RRF + model-reranker path must clear the floors.
  const baseline = await runGroundedRetrievalQualityEval("baseline");
  const baselineResult = evaluateGroundedRetrievalBudget(baseline);
  onLog(`grounded-retrieval-quality: ${formatScorecard(baseline)}`);
  onLog(
    `grounded-retrieval-quality floors: top1>=${formatPct(
      DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minTop1Rate,
    )} recall>=${formatPct(DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minRecallAtK)} ` +
      `ndcg>=${DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minNdcgAtK.toFixed(2)} ` +
      `citation-support>=${formatPct(DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minCitationSupport)}`,
  );

  // 2. Positive control: with the model reranker unavailable, the semantic + RRF fallback must still
  //    clear the floors — proving the retrieval ranking (not just the reranker) carries the result.
  const rerankerOff = await runGroundedRetrievalQualityEval("reranker-off");
  const rerankerOffResult = evaluateGroundedRetrievalBudget(rerankerOff);
  onLog(`grounded-retrieval-quality control: ${formatScorecard(rerankerOff)}`);

  // 3. Non-tautology proof: every injected ranking / reranker regression MUST drop below the floors.
  const regressionReports = await runRegressionProbes(onLog);

  const failures = collectFailures(baselineResult, rerankerOffResult, regressionReports);
  if (failures.length > 0) {
    onFail(failures.join("; "));
    return { ok: false, failures };
  }
  onLog(
    "grounded-retrieval-quality: PASS — semantic/RRF/reranker path gated; regressions fail closed.",
  );
  return { ok: true, failures: [] };
}

if (
  process.argv[1] &&
  (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1]
) {
  await runGroundedRetrievalQualityGate();
}
