// Markdown renderer for Issue #268 quality-gate evidence. The report is built entirely
// from synthetic scorecards, so it is safe to attach to epic closure evidence without
// leaking customer content, credentials, or runtime logs.

import type { RetrievalEvalScorecard } from "./types.js";

function format(value: number): string {
  return value.toFixed(3);
}

export function renderRetrievalEvalQualityGateReport(
  scorecards: readonly RetrievalEvalScorecard[],
): string {
  const header = [
    "# Local Knowledge Retrieval Quality Gate",
    "",
    "| Fixture | Recall | Precision | Isolation | Citation | No-evidence | Context budget | Latency | Pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const rows = scorecards.map((scorecard) => {
    const d = scorecard.dimensions;
    return [
      `| ${scorecard.fixtureId}`,
      format(d.recall),
      format(d.precision),
      format(d.sourceIsolation),
      format(d.citationQuality),
      format(d.noEvidenceAccuracy),
      format(d.contextBudgetFit),
      format(d.latencyMs),
      scorecard.passed ? "PASS" : "FAIL",
      "|",
    ].join(" | ");
  });
  return [...header, ...rows].join("\n");
}
