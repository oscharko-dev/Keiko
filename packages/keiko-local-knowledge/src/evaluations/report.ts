// Markdown renderer for Issue #268 quality-gate evidence. The report is built entirely
// from synthetic scorecards, so it is safe to attach to epic closure evidence without
// leaking customer content, credentials, or runtime logs.

import { PASS_THRESHOLDS, type RetrievalEvalScorecard } from "./types.js";

const THRESHOLD_LABELS = [
  ["recall", "recall"],
  ["precision", "precision"],
  ["meanReciprocalRank", "mrr"],
  ["ndcg", "ndcg"],
  ["sourceIsolation", "isolation"],
  ["citationQuality", "citation"],
  ["noEvidenceAccuracy", "no-evidence"],
  ["contextBudgetFit", "context-budget"],
] as const satisfies readonly (readonly [keyof typeof PASS_THRESHOLDS, string])[];

function format(value: number): string {
  return value.toFixed(3);
}

function formatReasonCounts(
  counts: RetrievalEvalScorecard["outcomes"]["noEvidenceReasonCounts"],
): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "none";
  return entries.map(([reason, count]) => `${reason}:${String(count)}`).join(",");
}

function formatOutcomes(scorecard: RetrievalEvalScorecard): string {
  const outcomes = scorecard.outcomes;
  return [
    `queries=${String(outcomes.queryCount)}`,
    `refs=${String(outcomes.referenceCount)}`,
    `no-evidence=${String(outcomes.noEvidenceCount)}/${String(outcomes.expectedNoEvidenceCount)}`,
    `reasons=${formatReasonCounts(outcomes.noEvidenceReasonCounts)}`,
  ].join("; ");
}

function formatThresholds(): string {
  return THRESHOLD_LABELS.map(([key, label]) => `${label}>=${format(PASS_THRESHOLDS[key])}`).join(
    "; ",
  );
}

export function renderRetrievalEvalQualityGateReport(
  scorecards: readonly RetrievalEvalScorecard[],
): string {
  const header = [
    "# Local Knowledge Retrieval Quality Gate",
    "",
    `Thresholds: ${formatThresholds()}`,
    "",
    "| Fixture | Recall | Precision | MRR | nDCG | Isolation | Citation | No-evidence | Context budget | Latency | Outcomes | Pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  const rows = scorecards.map((scorecard) => {
    const d = scorecard.dimensions;
    return `| ${[
      scorecard.fixtureId,
      format(d.recall),
      format(d.precision),
      format(d.meanReciprocalRank),
      format(d.ndcg),
      format(d.sourceIsolation),
      format(d.citationQuality),
      format(d.noEvidenceAccuracy),
      format(d.contextBudgetFit),
      format(d.latencyMs),
      formatOutcomes(scorecard),
      scorecard.passed ? "PASS" : "FAIL",
    ].join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}
