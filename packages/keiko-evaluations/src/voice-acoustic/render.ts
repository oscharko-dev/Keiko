// Human-readable renderer for the offline acoustic gate. Output is content-free: scenario ids, fixture
// names, pass/fail states, counts, and numeric metrics only.

import type {
  VoiceAcousticFixtureResult,
  VoiceAcousticMetricSummary,
  VoiceAcousticScorecard,
} from "./types.js";

function passFail(value: boolean): string {
  return value ? "PASS" : "FAIL";
}

function metricLine(metric: VoiceAcousticMetricSummary): string {
  return `  ${metric.metric.padEnd(34)} pass=${String(metric.passCount)} fail=${String(metric.failCount)} n/a=${String(metric.notApplicableCount)}`;
}

function fixtureLine(fixture: VoiceAcousticFixtureResult): string {
  const failed = fixture.checks
    .filter((check) => !check.passed)
    .map((check) => check.metric)
    .join(",");
  const suffix = failed.length > 0 ? ` failed=${failed}` : "";
  return `- ${fixture.fixtureName} [${fixture.scenario}/${fixture.polarity}/${fixture.acousticProfile}] gate=${passFail(fixture.gatePassed)} quality=${passFail(fixture.qualityPassed)} wer=${fixture.metrics.wer.toFixed(3)} cer=${fixture.metrics.cer.toFixed(3)}${suffix}`;
}

export function renderVoiceAcousticSummary(scorecard: VoiceAcousticScorecard): string {
  const summary = scorecard.summary;
  const lines: string[] = [];
  lines.push(`Voice acoustic evaluation summary (schema v${scorecard.schemaVersion})`);
  lines.push(
    `Fixtures: ${String(summary.totalFixtures)} total, positives=${String(summary.positiveFixtures)} passed=${String(summary.positivePassed)}, negatives=${String(summary.negativeFixtures)} caught=${String(summary.negativeCaught)}`,
  );
  lines.push(
    `Scenario coverage: ${summary.coveredScenarios.join(",")} coverage=${passFail(summary.scenarioCoverageMet)}`,
  );
  lines.push("");
  lines.push("Fixtures:");
  for (const fixture of scorecard.fixtureResults) {
    lines.push(fixtureLine(fixture));
  }
  lines.push("");
  lines.push("Metrics:");
  for (const metric of scorecard.metricSummary) {
    lines.push(metricLine(metric));
  }
  lines.push("");
  lines.push(
    summary.goNoGo === "GO"
      ? "Verdict: GO - positives passed, adversarial negatives were caught, and every scenario is covered."
      : "Verdict: NO-GO - a positive failed, a negative escaped, or scenario coverage is incomplete.",
  );
  return lines.join("\n");
}
