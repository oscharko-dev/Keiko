// renderVoiceRecapSummary (Issue #504): VoiceRecapScorecard -> human-readable string. One line per
// fixture (name, category, dimension pass/fail glyphs), a per-dimension table, the covered-candidate-status
// line, the no-voice / voice coverage line, and a Go/No-Go verdict. The scorecard carries only
// harness-authored, content-free fields (counts, closed-vocabulary labels, numeric scores), so this
// renderer performs no redaction — it only formats fields that are safe to print.

import type {
  VoiceRecapDimensionResult,
  VoiceRecapFixtureResult,
  VoiceRecapScorecard,
  VoiceRecapScorecardEntry,
} from "./types.js";

// `not-applicable` results are filtered out before this is called, so only pass / fail reach a glyph.
function glyph(result: VoiceRecapDimensionResult): string {
  return result.outcome === "pass" ? "PASS" : "FAIL";
}

function fixtureLine(fixture: VoiceRecapFixtureResult): string {
  const dims = fixture.dimensionResults
    .filter((d) => d.outcome !== "not-applicable")
    .map((d) => `${d.dimension}=${glyph(d)}`)
    .join(" ");
  const verdict = fixture.fullyPassed ? "OK" : "FAIL";
  return `- ${fixture.fixtureName} [${fixture.category}] ${verdict} ${dims}`.trimEnd();
}

function dimensionLine(entry: VoiceRecapScorecardEntry): string {
  const rate = entry.passRate === null ? "n/a" : `${(entry.passRate * 100).toFixed(0)}%`;
  const verdict = entry.failCount > 0 ? "FAIL" : entry.passCount > 0 ? "PASS" : "n/a";
  return `  ${entry.dimension.padEnd(32)} ${verdict.padEnd(5)} pass=${String(entry.passCount)} fail=${String(entry.failCount)} n/a=${String(entry.notApplicableCount)} rate=${rate}`;
}

export function renderVoiceRecapSummary(scorecard: VoiceRecapScorecard): string {
  const lines: string[] = [];
  lines.push(`Voice Session Recap evaluation summary (schema v${scorecard.schemaVersion})`);
  lines.push(
    `Fixtures: ${String(scorecard.summary.totalFixtures)} total, ${String(scorecard.summary.fullyPassedFixtures)} fully passed`,
  );
  lines.push(
    `Candidate statuses covered: ${String(scorecard.coveredCandidateStatuses.length)} (${scorecard.coveredCandidateStatuses.join(", ")})`,
  );
  lines.push(
    `Profile coverage: no-voice=${scorecard.summary.coversNoVoiceProfile ? "yes" : "no"} voice=${scorecard.summary.coversVoiceProfile ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("Fixtures:");
  for (const fixture of scorecard.fixtureResults) {
    lines.push(fixtureLine(fixture));
  }
  lines.push("");
  lines.push("Dimensions:");
  for (const entry of scorecard.dimensions) {
    lines.push(dimensionLine(entry));
  }
  lines.push("");
  lines.push(
    scorecard.summary.goNoGo === "GO"
      ? "Verdict: GO - every exercised recap dimension passed across no-voice and voice profiles."
      : "Verdict: NO-GO - a dimension failed or a profile coverage gate was unmet (see table above).",
  );
  return lines.join("\n");
}
