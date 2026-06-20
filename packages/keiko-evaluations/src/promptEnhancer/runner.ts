// Prompt Enhancer evaluation runner (Epic #1307, Issue #1315; ADR-0044 §6).
//
// Runs every registered fixture through the deterministic pipeline, scores the eight prompt-quality
// dimensions, aggregates a scorecard, and derives the offline Go/No-Go verdict. Pure: no IO, clock,
// randomness, or model dispatch, so the suite gives reproducible CI coverage.

import { ALL_PROMPT_ENHANCER_FIXTURES } from "./fixtures/index.js";
import { runEnhancement } from "./pipeline.js";
import { aggregatePromptQuality, scorePromptQuality } from "./scorer.js";
import {
  PROMPT_ENHANCER_EVAL_SCHEMA_VERSION,
  type PromptEnhancerEvalFixture,
  type PromptEnhancerEvalSummary,
  type PromptEnhancerFixtureResult,
  type PromptEnhancerScorecard,
  type PromptQualityScorecardEntry,
} from "./types.js";
import type { PromptTaskClass } from "@oscharko-dev/keiko-contracts";

function summarize(
  fixtureResults: readonly PromptEnhancerFixtureResult[],
  dimensions: readonly PromptQualityScorecardEntry[],
): PromptEnhancerEvalSummary {
  const safety = dimensions.find((d) => d.dimension === "safety");
  const safetyGatePassed = (safety?.failCount ?? 0) === 0;
  const allClean = dimensions.every((d) => d.failCount === 0);
  return {
    totalFixtures: fixtureResults.length,
    fullyPassedFixtures: fixtureResults.filter((f) => f.fullyPassed).length,
    safetyGatePassed,
    goNoGo: allClean ? "GO" : "NO-GO",
  };
}

function runFixture(fixture: PromptEnhancerEvalFixture): PromptEnhancerFixtureResult {
  const observation = runEnhancement(fixture.name, fixture.request);
  const dimensionResults = scorePromptQuality(fixture, observation);
  return {
    fixtureName: fixture.name,
    category: fixture.category,
    observation,
    dimensionResults,
    fullyPassed: dimensionResults.every((d) => d.outcome !== "fail"),
  };
}

/**
 * Run the Prompt Enhancer evaluation suite and return a fully aggregated scorecard. Pure and
 * deterministic. Pass an explicit fixture list to scope the run (the suite tests use the default set).
 */
export function runPromptEnhancerEvaluation(
  fixtures: readonly PromptEnhancerEvalFixture[] = ALL_PROMPT_ENHANCER_FIXTURES,
): PromptEnhancerScorecard {
  const fixtureResults = fixtures.map(runFixture);
  const dimensions = aggregatePromptQuality(fixtureResults.map((f) => f.dimensionResults));
  const coveredTaskClasses: readonly PromptTaskClass[] = [
    ...new Set(fixtureResults.map((f) => f.observation.analysis.taskClass)),
  ];
  return {
    schemaVersion: PROMPT_ENHANCER_EVAL_SCHEMA_VERSION,
    fixtureResults,
    dimensions,
    summary: summarize(fixtureResults, dimensions),
    coveredTaskClasses,
  };
}
