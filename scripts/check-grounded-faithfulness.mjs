// RB-4 / GEN-AI-EVAL-003 / GEN-AI-GROUNDING-001 / GEN-AI-GROUNDING-008 / GEN-TEST-MISSING-010.
//
// The estate had ZERO citation-faithfulness coverage — every citation test asserted pack→wire
// projection, so an answer citing evidence it never received, or answering confidently over empty
// evidence, was invisible. This gate scores the REAL reconciliation/abstention logic over scripted
// answerer variants (faithful, hallucinated-citation, confident-over-empty, refusal) and fails
// closed if fabricated citations stop being flagged or empty evidence stops abstaining.

import {
  DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
  evaluateGroundedFaithfulnessBudget,
  runGroundedFaithfulnessEval,
} from "@oscharko-dev/keiko-server";

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function runGroundedFaithfulnessGate({ log, fail } = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`grounded-faithfulness check failed: ${message}`);
      process.exit(1);
    });

  const scorecard = runGroundedFaithfulnessEval();
  const result = evaluateGroundedFaithfulnessBudget(scorecard);
  onLog(
    `grounded-faithfulness: fixtures=${String(scorecard.fixtures)} ` +
      `unsupported-detection=${formatPct(scorecard.unsupportedDetectionRate)} ` +
      `citation-precision=${formatPct(scorecard.citationPrecision)} ` +
      `abstention-on-empty=${formatPct(scorecard.abstentionOnEmptyRate)}`,
  );
  onLog(
    `grounded-faithfulness floors: unsupported-detection>=${formatPct(
      DEFAULT_GROUNDED_FAITHFULNESS_BUDGET.minUnsupportedDetectionRate,
    )} citation-precision>=${formatPct(
      DEFAULT_GROUNDED_FAITHFULNESS_BUDGET.minCitationPrecision,
    )} abstention>=${formatPct(DEFAULT_GROUNDED_FAITHFULNESS_BUDGET.minAbstentionOnEmptyRate)}`,
  );
  if (!result.ok) {
    onFail(result.failures.join("; "));
    return { ok: false, failures: result.failures };
  }
  onLog(
    "grounded-faithfulness: PASS — fabricated citations flagged, empty evidence abstains, no false positives.",
  );
  return { ok: true, failures: [] };
}

if (
  process.argv[1] &&
  (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1]
) {
  runGroundedFaithfulnessGate();
}
