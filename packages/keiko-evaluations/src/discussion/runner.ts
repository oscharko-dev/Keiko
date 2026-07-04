// Discussion Intelligence evaluation runner (Epic #491, Issue #502; ADR-0107).
//
// Derives a deterministic observation for each fixture from the frozen keiko-contracts tables and the
// pure recovery helpers, scores the seven discussion-quality dimensions, aggregates a scorecard, and
// derives the offline Go/No-Go verdict. Pure: no IO, clock, randomness, or model dispatch.

import {
  DISCUSSION_DIRECTIVE_TEMPLATES,
  applyDiscussionInterruption,
  applyDiscussionRecovery,
  beginDiscussionTurn,
  discussionModePlan,
  voiceCanDriveDiscussion,
  type DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import { ALL_DISCUSSION_FIXTURES } from "./fixtures/index.js";
import { aggregateDiscussionQuality, scoreDiscussionQuality } from "./scorer.js";
import {
  DISCUSSION_EVAL_SCHEMA_VERSION,
  type DiscussionEvalFixture,
  type DiscussionEvalSummary,
  type DiscussionFixtureResult,
  type DiscussionObservation,
  type DiscussionRecoveryTrajectory,
  type DiscussionScorecard,
  type DiscussionScorecardEntry,
} from "./types.js";

// The fixed turn index every fixture seeds. Recovery's load-bearing property is that this value is
// preserved across interrupt -> recover, not its magnitude, so a single constant suffices.
const FIXTURE_TURN_INDEX = 0;

// Begin a turn, interrupt it (active -> interrupted), then recover it (interrupted -> recovered). The
// contract helpers preserve mode/topicId/turnIndex; the scorer asserts that preservation (AC4).
function deriveRecoveryTrajectory(
  mode: DiscussionMode,
  topicId: string,
): DiscussionRecoveryTrajectory {
  const initial = beginDiscussionTurn(mode, topicId, FIXTURE_TURN_INDEX);
  const interrupted = applyDiscussionInterruption(initial);
  const recovered = applyDiscussionRecovery(interrupted);
  return { initial, interrupted, recovered };
}

/**
 * Derive the deterministic observation for one fixture: the mode plan, its directive templates rendered
 * verbatim, the voice-gating verdict, and (when the fixture declares one) the interruption-recovery
 * trajectory. Pure data derivation over the frozen contract tables.
 */
export function deriveDiscussionObservation(fixture: DiscussionEvalFixture): DiscussionObservation {
  const plan = discussionModePlan(fixture.mode);
  const renderedDirectives = plan.directives.map(
    (directive) => DISCUSSION_DIRECTIVE_TEMPLATES[directive],
  );
  const gatingAllowed = voiceCanDriveDiscussion(fixture.profile);
  if (fixture.interruption !== true) {
    return { plan, renderedDirectives, gatingAllowed };
  }
  return {
    plan,
    renderedDirectives,
    gatingAllowed,
    recovery: deriveRecoveryTrajectory(fixture.mode, fixture.topicId),
  };
}

function runFixture(fixture: DiscussionEvalFixture): DiscussionFixtureResult {
  const observation = deriveDiscussionObservation(fixture);
  const dimensionResults = scoreDiscussionQuality(fixture, observation);
  return {
    fixtureName: fixture.name,
    category: fixture.category,
    observation,
    dimensionResults,
    fullyPassed: dimensionResults.every((d) => d.outcome !== "fail"),
  };
}

function summarize(
  fixtureResults: readonly DiscussionFixtureResult[],
  dimensions: readonly DiscussionScorecardEntry[],
): DiscussionEvalSummary {
  const allClean = dimensions.every((d) => d.failCount === 0);
  const coversNoVoiceProfile = fixtureResults.some((f) => f.category === "no-voice");
  const coversVoiceProfile = fixtureResults.some((f) => f.observation.gatingAllowed);
  return {
    totalFixtures: fixtureResults.length,
    fullyPassedFixtures: fixtureResults.filter((f) => f.fullyPassed).length,
    coversNoVoiceProfile,
    coversVoiceProfile,
    goNoGo: allClean && coversNoVoiceProfile && coversVoiceProfile ? "GO" : "NO-GO",
  };
}

/**
 * Run the Discussion Intelligence evaluation suite and return a fully aggregated scorecard. Pure and
 * deterministic. Pass an explicit fixture list to scope the run (the suite tests use the default set).
 */
export function runDiscussionEvaluation(
  fixtures: readonly DiscussionEvalFixture[] = ALL_DISCUSSION_FIXTURES,
): DiscussionScorecard {
  const fixtureResults = fixtures.map(runFixture);
  const dimensions = aggregateDiscussionQuality(fixtureResults.map((f) => f.dimensionResults));
  const coveredModes: readonly DiscussionMode[] = [
    ...new Set(fixtureResults.map((f) => f.observation.plan.mode)),
  ];
  return {
    schemaVersion: DISCUSSION_EVAL_SCHEMA_VERSION,
    fixtureResults,
    dimensions,
    summary: summarize(fixtureResults, dimensions),
    coveredModes,
  };
}
