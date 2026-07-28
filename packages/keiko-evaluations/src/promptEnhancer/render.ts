// renderPromptEnhancerSummary (Issue #1315): PromptEnhancerScorecard -> human-readable string. One
// line per fixture (name, category, dimension pass/fail glyphs), a per-dimension table, the covered-
// task-class coverage line, and a Go/No-Go verdict. The scorecard carries only harness-authored,
// content-free fields (structural counts, closed-vocabulary labels, numeric scores), so this renderer
// performs no redaction — it only formats fields that are safe to print.

import type {
  PromptEnhancerFixtureResult,
  PromptEnhancerScorecard,
  PromptQualityDimensionResult,
  PromptQualityScorecardEntry,
} from "./types.js";

function glyph(result: PromptQualityDimensionResult): string {
  if (result.outcome === "pass") {
    return "PASS";
  }
  if (result.outcome === "fail") {
    return "FAIL";
  }
  return "n/a";
}

function fixtureLine(fixture: PromptEnhancerFixtureResult): string {
  const dims = fixture.dimensionResults
    .filter((d) => d.outcome !== "not-applicable")
    .map((d) => `${d.dimension}=${glyph(d)}`)
    .join(" ");
  const verdict = fixture.fullyPassed ? "OK" : "FAIL";
  return `- ${fixture.fixtureName} [${fixture.category}] ${verdict} ${dims}`.trimEnd();
}

function dimensionVerdict(failCount: number, passCount: number): string {
  if (failCount > 0) {
    return "FAIL";
  }
  if (passCount > 0) {
    return "PASS";
  }
  return "n/a";
}

function dimensionLine(entry: PromptQualityScorecardEntry): string {
  const rate = entry.passRate === null ? "n/a" : `${(entry.passRate * 100).toFixed(0)}%`;
  const verdict = dimensionVerdict(entry.failCount, entry.passCount);
  return `  ${entry.dimension.padEnd(18)} ${verdict.padEnd(5)} pass=${String(entry.passCount)} fail=${String(entry.failCount)} n/a=${String(entry.notApplicableCount)} rate=${rate}`;
}

export function renderPromptEnhancerSummary(scorecard: PromptEnhancerScorecard): string {
  const lines: string[] = [];
  lines.push(
    `Prompt Enhancer evaluation summary (schema v${scorecard.schemaVersion})`,
    `Fixtures: ${String(scorecard.summary.totalFixtures)} total, ${String(scorecard.summary.fullyPassedFixtures)} fully passed`,
    `Task classes covered: ${String(scorecard.coveredTaskClasses.length)} (${scorecard.coveredTaskClasses.join(", ")})`,
    "",
    "Fixtures:",
  );
  for (const fixture of scorecard.fixtureResults) {
    lines.push(fixtureLine(fixture));
  }
  lines.push("", "Dimensions:");
  for (const entry of scorecard.dimensions) {
    lines.push(dimensionLine(entry));
  }
  lines.push("", `Safety gate: ${scorecard.summary.safetyGatePassed ? "PASS" : "FAIL"}`);
  lines.push(
    scorecard.summary.goNoGo === "GO"
      ? "Verdict: GO - every exercised prompt-quality dimension passed."
      : "Verdict: NO-GO - one or more prompt-quality dimensions failed (see table above).",
  );
  return lines.join("\n");
}
