// renderVoiceTwinSummary (Issue #505): VoiceTwinScorecard -> human-readable string. A verdict line, a
// per-dimension table, the profile / environment matrix-coverage lines, and the privacy line. The
// scorecard carries only harness-authored, content-free fields (counts, closed-vocabulary labels, numeric
// scores), so this renderer performs no redaction — it only formats fields that are safe to print.

import type {
  VoiceTwinDimensionResult,
  VoiceTwinFixtureResult,
  VoiceTwinScorecard,
  VoiceTwinScorecardEntry,
} from "./types.js";

function glyph(result: VoiceTwinDimensionResult): string {
  if (result.outcome === "pass") {
    return "PASS";
  }
  if (result.outcome === "fail") {
    return "FAIL";
  }
  return "n/a";
}

function fixtureLine(fixture: VoiceTwinFixtureResult): string {
  const dims = fixture.dimensionResults
    .filter((d) => d.outcome !== "not-applicable")
    .map((d) => `${d.dimension}=${glyph(d)}`)
    .join(" ");
  const verdict = fixture.fullyPassed ? "OK" : "FAIL";
  return `- ${fixture.fixtureName} [${fixture.category}/${fixture.environment}/${fixture.effectiveProfile}] ${verdict} ${dims}`.trimEnd();
}

function dimensionLine(entry: VoiceTwinScorecardEntry): string {
  const rate = entry.passRate === null ? "n/a" : `${(entry.passRate * 100).toFixed(0)}%`;
  const verdict = entry.failCount > 0 ? "FAIL" : entry.passCount > 0 ? "PASS" : "n/a";
  return `  ${entry.dimension.padEnd(32)} ${verdict.padEnd(5)} pass=${String(entry.passCount)} fail=${String(entry.failCount)} n/a=${String(entry.notApplicableCount)} rate=${rate}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function renderVoiceTwinSummary(scorecard: VoiceTwinScorecard): string {
  const summary = scorecard.summary;
  const lines: string[] = [];
  lines.push(`Voice Digital Twin evaluation summary (schema v${scorecard.schemaVersion})`);
  lines.push(
    `Fixtures: ${String(summary.totalFixtures)} total, ${String(summary.fullyPassedFixtures)} fully passed`,
  );
  lines.push(
    `Capability coverage: no-voice=${yesNo(summary.coversNoVoice)} stt=${yesNo(summary.coversSttOnly)} full-realtime=${yesNo(summary.coversFullRealtime)}`,
  );
  lines.push(
    `Environment coverage: azure-foundry=${yesNo(summary.coversAzureFoundry)} customer-hosted=${yesNo(summary.coversCustomerHosted)}`,
  );
  lines.push(
    `Privacy: negative-egress-caught=${yesNo(summary.coversPrivacyNegative)}, matrix cells=${String(scorecard.coveredMatrixCells.length)}`,
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
    summary.goNoGo === "GO"
      ? "Verdict: GO - every exercised dimension passed across the profile and environment matrix."
      : "Verdict: NO-GO - a dimension failed or a coverage gate was unmet (see table above).",
  );
  return lines.join("\n");
}
