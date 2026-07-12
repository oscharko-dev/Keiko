// Voice Action Governance evaluation runner (Epic #491, Issue #503; ADR-0108).
//
// Derives a deterministic observation for each fixture from the frozen keiko-contracts spoken-action
// governance functions, scores the six security dimensions, aggregates a scorecard, and derives the
// offline Go/No-Go verdict. Pure: no IO, clock, randomness, or model dispatch. The committed-only
// boundary is exercised for real — every fixture's segments pass through `selectCommittedVoiceTranscript`
// before any proposal can form, so partial / discarded / superseded text is excluded structurally.

import {
  buildSpokenActionAuditRecord,
  canonicalizeSpokenActionConfirmation,
  normalizeSpokenActionProposal,
  selectCommittedVoiceTranscript,
  voiceCanProposeAction,
  type SpokenActionAuditRecord,
  type SpokenActionConfirmationInput,
  type SpokenActionEffectClass,
  type SpokenActionOutcome,
  type SpokenActionProposal,
  type VoiceTranscriptSegment,
} from "@oscharko-dev/keiko-contracts";
import { ALL_VOICE_ACTION_FIXTURES } from "./fixtures/index.js";
import { aggregateVoiceActionQuality, scoreVoiceActionQuality } from "./scorer.js";
import {
  VOICE_ACTION_EVAL_SCHEMA_VERSION,
  type VoiceActionEvalFixture,
  type VoiceActionEvalSummary,
  type VoiceActionFixtureResult,
  type VoiceActionObservation,
  type VoiceActionProposalSummary,
  type VoiceActionScorecard,
  type VoiceActionScorecardEntry,
  type VoiceActionStalenessTrajectory,
} from "./types.js";

// Build the content-free audit record the governance layer would persist. `bindingDigest` is "" here:
// this eval never computes the downstream sha256 (that is Artifact 2's `node:crypto`); the empty digest
// is the contract-valid "no bound digest" sentinel, and the AC4 staleness proof works on the canonical
// SEED (a plain string), which is what the digest is derived from.
function buildAuditFor(
  proposal: SpokenActionProposal | undefined,
  fixture: VoiceActionEvalFixture,
  committedSegmentCount: number,
  committedChars: number,
): SpokenActionAuditRecord {
  const effectClass: SpokenActionEffectClass = proposal?.effectClass ?? "unknown";
  const outcome: SpokenActionOutcome = proposal === undefined ? "not-applicable" : "routed";
  return buildSpokenActionAuditRecord({
    effectClass,
    state: proposal?.state ?? "expired",
    confirmationRequired: proposal?.requiresConfirmation ?? false,
    confirmed: false,
    outcome,
    source: fixture.source,
    turnIndex: fixture.turnIndex,
    committedSegmentCount,
    committedChars,
    bindingDigest: "",
  });
}

// Derive the AC4 staleness trajectory by comparing the canonical confirmation seed for the committed
// projection at the fixture's turn against the seed after the fixture's declared change (a provider
// correction or a turn advance). Only the CONTENT-FREE comparison result is returned: the raw seeds
// embed committed text and never leave this function (they are compared then discarded).
function deriveStaleness(
  fixture: VoiceActionEvalFixture,
  proposal: SpokenActionProposal,
): VoiceActionStalenessTrajectory | undefined {
  const originalCanonical = canonicalizeSpokenActionConfirmation(proposal.confirmationInput);
  if (fixture.correctedSegments !== undefined) {
    const changed = projectionConfirmationSeed(
      fixture,
      fixture.correctedSegments,
      fixture.turnIndex,
    );
    return compareSeeds(originalCanonical, changed, "correction");
  }
  if (fixture.turnAdvance === true) {
    const changed = projectionConfirmationSeed(fixture, fixture.segments, fixture.turnIndex + 1);
    return compareSeeds(originalCanonical, changed, "turn-advance");
  }
  return undefined;
}

// Reduce two raw canonical seeds to the content-free booleans the scorer needs (AC4). The seeds are
// consumed here and never propagated, so no committed text reaches the observation.
function compareSeeds(
  original: string,
  changed: string | undefined,
  trigger: VoiceActionStalenessTrajectory["trigger"],
): VoiceActionStalenessTrajectory {
  return {
    seedChanged: changed !== undefined && changed !== original,
    bothSeedsPresent: original.length > 0 && changed !== undefined && changed.length > 0,
    trigger,
  };
}

// Re-run the projection -> normalize pipeline for a given segment set + turn index and return the
// canonical confirmation seed of the resulting proposal (undefined when no proposal forms).
function projectionConfirmationSeed(
  fixture: VoiceActionEvalFixture,
  segments: readonly VoiceTranscriptSegment[],
  turnIndex: number,
): string | undefined {
  const projection = selectCommittedVoiceTranscript(segments);
  const proposal = normalizeSpokenActionProposal(
    projection,
    fixture.profile,
    turnIndex,
    fixture.source,
  );
  if (proposal === undefined) {
    return undefined;
  }
  const input: SpokenActionConfirmationInput = proposal.confirmationInput;
  return canonicalizeSpokenActionConfirmation(input);
}

/**
 * Derive the deterministic observation for one fixture: the voice-gating verdict, the committed
 * projection counts, the normalized proposal (or undefined when dormant / empty / partial-only), the
 * content-free audit record, and (when the fixture declares one) the staleness trajectory. Pure data
 * derivation over the frozen contract.
 */
export function deriveVoiceActionObservation(
  fixture: VoiceActionEvalFixture,
): VoiceActionObservation {
  const gatingAllowed = voiceCanProposeAction(fixture.profile);
  const projection = selectCommittedVoiceTranscript(fixture.segments);
  const proposal = normalizeSpokenActionProposal(
    projection,
    fixture.profile,
    fixture.turnIndex,
    fixture.source,
  );
  const audit = buildAuditFor(proposal, fixture, projection.segmentCount, projection.text.length);
  const base: VoiceActionObservation = {
    gatingAllowed,
    committedSegmentCount: projection.segmentCount,
    committedChars: projection.text.length,
    proposal: proposal === undefined ? undefined : summarizeProposal(proposal),
    audit,
  };
  if (proposal === undefined) {
    return base;
  }
  const staleness = deriveStaleness(fixture, proposal);
  return staleness === undefined ? base : { ...base, staleness };
}

// Project the contract proposal down to its content-free fields. The full proposal carries the transient
// `committedText` digest seed, which must never enter the observation / scorecard (AC5).
function summarizeProposal(proposal: SpokenActionProposal): VoiceActionProposalSummary {
  return {
    effectClass: proposal.effectClass,
    requiresConfirmation: proposal.requiresConfirmation,
    state: proposal.state,
    turnIndex: proposal.turnIndex,
    committedSegmentCount: proposal.committedSegmentCount,
    committedChars: proposal.committedChars,
  };
}

function runFixture(fixture: VoiceActionEvalFixture): VoiceActionFixtureResult {
  const observation = deriveVoiceActionObservation(fixture);
  const dimensionResults = scoreVoiceActionQuality(fixture, observation);
  return {
    fixtureName: fixture.name,
    category: fixture.category,
    observation,
    dimensionResults,
    fullyPassed: dimensionResults.every((d) => d.outcome !== "fail"),
  };
}

function summarize(
  fixtureResults: readonly VoiceActionFixtureResult[],
  dimensions: readonly VoiceActionScorecardEntry[],
): VoiceActionEvalSummary {
  const allClean = dimensions.every((d) => d.failCount === 0);
  const coversNoVoiceProfile = fixtureResults.some((f) => !f.observation.gatingAllowed);
  const coversVoiceProfile = fixtureResults.some((f) => f.observation.gatingAllowed);
  return {
    totalFixtures: fixtureResults.length,
    fullyPassedFixtures: fixtureResults.filter((f) => f.fullyPassed).length,
    coversNoVoiceProfile,
    coversVoiceProfile,
    goNoGo: allClean && coversNoVoiceProfile && coversVoiceProfile ? "GO" : "NO-GO",
  };
}

function collectEffectClasses(
  fixtureResults: readonly VoiceActionFixtureResult[],
): readonly SpokenActionEffectClass[] {
  const classes = fixtureResults
    .map((f) => f.observation.proposal?.effectClass)
    .filter((value): value is SpokenActionEffectClass => value !== undefined);
  // Sort to a canonical order so the covered-class list is stable regardless of fixture ordering
  // (matches the codebase determinism convention).
  return [...new Set(classes)].sort((a, b) => a.localeCompare(b));
}

/**
 * Run the Voice Action Governance evaluation suite and return a fully aggregated scorecard. Pure and
 * deterministic. Pass an explicit fixture list to scope the run (the suite tests use the default set).
 */
export function runVoiceActionEvaluation(
  fixtures: readonly VoiceActionEvalFixture[] = ALL_VOICE_ACTION_FIXTURES,
): VoiceActionScorecard {
  const fixtureResults = fixtures.map(runFixture);
  const dimensions = aggregateVoiceActionQuality(fixtureResults.map((f) => f.dimensionResults));
  return {
    schemaVersion: VOICE_ACTION_EVAL_SCHEMA_VERSION,
    fixtureResults,
    dimensions,
    summary: summarize(fixtureResults, dimensions),
    coveredEffectClasses: collectEffectClasses(fixtureResults),
  };
}
