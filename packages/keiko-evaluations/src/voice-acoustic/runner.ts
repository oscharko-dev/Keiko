// Suite runner for the offline acoustic-quality gate. Pure and deterministic: fixtures in, scorecard out.

import { ALL_VOICE_ACOUSTIC_FIXTURES } from "./fixtures/index.js";
import { aggregateVoiceAcousticMetrics, scoreVoiceAcousticFixture } from "./scorer.js";
import {
  VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION,
  VOICE_ACOUSTIC_SCENARIOS,
  type VoiceAcousticEvalSummary,
  type VoiceAcousticFixture,
  type VoiceAcousticFixtureResult,
  type VoiceAcousticScenario,
  type VoiceAcousticScorecard,
} from "./types.js";

function coveredScenarios(
  fixtureResults: readonly VoiceAcousticFixtureResult[],
): readonly VoiceAcousticScenario[] {
  const seen = new Set(fixtureResults.map((result) => result.scenario));
  return VOICE_ACOUSTIC_SCENARIOS.filter((scenario) => seen.has(scenario));
}

function scenarioCoverageMet(covered: readonly VoiceAcousticScenario[]): boolean {
  return (
    covered.length === VOICE_ACOUSTIC_SCENARIOS.length &&
    VOICE_ACOUSTIC_SCENARIOS.every((scenario) => covered.includes(scenario))
  );
}

function summarize(
  fixtureResults: readonly VoiceAcousticFixtureResult[],
): VoiceAcousticEvalSummary {
  const positives = fixtureResults.filter((result) => result.polarity === "positive");
  const negatives = fixtureResults.filter((result) => result.polarity === "negative");
  const positivePassed = positives.filter((result) => result.qualityPassed).length;
  const negativeCaught = negatives.filter((result) => result.gatePassed).length;
  const covered = coveredScenarios(positives);
  const coverageMet = scenarioCoverageMet(covered);
  const allPositivePassed = positivePassed === positives.length;
  const allNegativeCaught = negativeCaught === negatives.length;
  return {
    totalFixtures: fixtureResults.length,
    positiveFixtures: positives.length,
    negativeFixtures: negatives.length,
    positivePassed,
    negativeCaught,
    coveredScenarios: covered,
    scenarioCoverageMet: coverageMet,
    goNoGo: allPositivePassed && allNegativeCaught && coverageMet ? "GO" : "NO-GO",
  };
}

export function runVoiceAcousticEvaluation(
  fixtures: readonly VoiceAcousticFixture[] = ALL_VOICE_ACOUSTIC_FIXTURES,
): VoiceAcousticScorecard {
  const fixtureResults = fixtures.map(scoreVoiceAcousticFixture);
  return {
    schemaVersion: VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION,
    fixtureResults,
    metricSummary: aggregateVoiceAcousticMetrics(fixtureResults),
    summary: summarize(fixtureResults),
  };
}
