// renderEvalSummary (ADR-0012 D8): EvalScorecard -> human-readable string. One line per fixture
// (name, status, dimension pass/fail glyphs), a per-dimension table, the surface-parity verdict, and
// a Go/No-Go line. The scorecard is already redacted by construction (it carries no model content
// beyond the already-redacted workflow reports, and reasons are harness-authored), so this renderer
// performs no further redaction — it only formats fields that are safe to print.

import type { DimensionResult, EvalScorecard, FixtureRunResult, ScorecardEntry } from "./types.js";

function glyph(result: DimensionResult): string {
  if (result.outcome === "pass") {
    return "PASS";
  }
  if (result.outcome === "fail") {
    return "FAIL";
  }
  return "n/a";
}

function fixtureLine(fixture: FixtureRunResult): string {
  const status = (fixture.report.status as string | undefined) ?? "unknown";
  const dims = fixture.dimensionResults
    .filter((d) => d.outcome !== "not-applicable")
    .map((d) => `${d.dimension}=${glyph(d)}`)
    .join(" ");
  return `- ${fixture.fixtureName} [${fixture.workflowKind}] status=${status} ${dims}`.trimEnd();
}

function dimensionLine(entry: ScorecardEntry): string {
  const rate = entry.passRate === null ? "n/a" : `${(entry.passRate * 100).toFixed(0)}%`;
  const verdict = entry.failCount > 0 ? "FAIL" : entry.passCount > 0 ? "PASS" : "n/a";
  return `  ${entry.dimension.padEnd(28)} ${verdict.padEnd(5)} pass=${String(entry.passCount)} fail=${String(entry.failCount)} n/a=${String(entry.notApplicableCount)} rate=${rate}`;
}

function verdictLine(scorecard: EvalScorecard): string {
  if (!scorecard.summary.safetyGatePassed) {
    return "Verdict: NO-GO — safety gate FAILED (an unsafe action was not rejected or surface parity broke).";
  }
  return scorecard.summary.pilotReadyIndicator
    ? "Verdict: GO — pilot ready (all Go/No-Go thresholds met)."
    : "Verdict: NO-GO — pilot thresholds not met (review per-dimension pass rates above).";
}

export function renderEvalSummary(scorecard: EvalScorecard): string {
  const lines: string[] = [];
  lines.push(
    `Keiko evaluation summary (schema v${scorecard.schemaVersion}, mode=${scorecard.mode})`,
  );
  lines.push(`Evaluated at: ${scorecard.evaluatedAt}`);
  lines.push(
    `Fixtures: ${String(scorecard.summary.totalFixtures)} total, ${String(scorecard.summary.fullyPassedFixtures)} fully passed`,
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
    `Surface parity: ${scorecard.surfaceParity.allPassed ? "PASS" : "FAIL"} (${String(scorecard.surfaceParity.checks.length)} checks)`,
  );
  for (const check of scorecard.surfaceParity.checks.filter((c) => !c.passed)) {
    lines.push(`  FAIL ${check.check} [${check.workflowKind}] — ${check.reason ?? "unknown"}`);
  }
  lines.push("");
  lines.push(verdictLine(scorecard));
  return lines.join("\n");
}
