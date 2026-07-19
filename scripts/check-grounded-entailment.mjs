// Knowledge M1.2 / Issue #2563 / GEN-AI-GROUNDING-001.
//
// The faithfulness moat verified citation MEMBERSHIP (was the cited chunk in the pack?) but was
// structurally blind to citation SUPPORT: a real, in-pack chunk cited for a claim it does not
// support passed. This gate scores the REAL claim-segmentation/entailment-reconciliation/marker
// logic (grounded-faithfulness.ts) over distractor-dense fixtures with a deterministic scripted
// judge, and fails closed if an unsupported claim stops being flagged, a supported claim is falsely
// flagged, an unavailable judge stops degrading to WARN, or the checker stops being load-bearing
// (a pass-through judge that still "detects" would make the gate a tautology).

import {
  DEFAULT_GROUNDED_ENTAILMENT_BUDGET,
  evaluateGroundedEntailmentBudget,
  runGroundedEntailmentEval,
} from "@oscharko-dev/keiko-server";

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export async function runGroundedEntailmentGate({ log, fail } = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`grounded-entailment check failed: ${message}`);
      process.exit(1);
    });

  const scorecard = await runGroundedEntailmentEval();
  const result = evaluateGroundedEntailmentBudget(scorecard);
  onLog(
    `grounded-entailment: fixtures=${String(scorecard.fixtures)} ` +
      `unsupported-detection=${formatPct(scorecard.unsupportedClaimDetectionRate)} ` +
      `claim-precision=${formatPct(scorecard.claimPrecision)} ` +
      `degradation=${formatPct(scorecard.degradationCorrectnessRate)} ` +
      `non-tautology=${scorecard.nonTautologyProven ? "proven" : "NOT-PROVEN"}`,
  );
  onLog(
    `grounded-entailment floors: unsupported-detection>=${formatPct(
      DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minUnsupportedClaimDetectionRate,
    )} claim-precision>=${formatPct(
      DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minClaimPrecision,
    )} degradation>=${formatPct(
      DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minDegradationCorrectnessRate,
    )} non-tautology=required`,
  );
  if (!result.ok) {
    onFail(result.failures.join("; "));
    return { ok: false, failures: result.failures };
  }
  onLog(
    "grounded-entailment: PASS — unsupported claims flagged, supported claims clean, " +
      "unavailable judge degrades to WARN, checker is load-bearing.",
  );
  return { ok: true, failures: [] };
}

if (
  process.argv[1] &&
  (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1]
) {
  await runGroundedEntailmentGate();
}
