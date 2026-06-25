// Voice Session Recap evaluation runner (Epic #491, Issue #504; ADR-0067).
//
// Derives a deterministic observation for each fixture from the frozen keiko-contracts recap functions and
// the content-free candidate model, scores the seven recap dimensions, aggregates a scorecard, and derives
// the offline Go/No-Go verdict. Pure: no IO, clock, randomness, or model dispatch. The committed-only
// boundary is exercised for real — every user span's segments pass through `selectCommittedVoiceTranscript`
// before any candidate can form, so partial / discarded / superseded text is excluded structurally (AC2).
// Assistant turns are counted but their text is never passed to the candidate model (AC5).

import {
  buildVoiceSessionRecapAuditRecord,
  selectCommittedVoiceTranscript,
  summarizeVoiceSessionRecap,
  summarizeVoiceTranscript,
  voiceRecapAllowed,
  type VoiceSessionRecapAuditRecord,
  type VoiceSessionRecapEvidenceSummary,
  type VoiceTranscriptEvidenceSummary,
  type VoiceTranscriptSegment,
} from "@oscharko-dev/keiko-contracts";
import { deriveCandidateOutcome } from "./candidate-model.js";
import { ALL_VOICE_RECAP_FIXTURES } from "./fixtures/index.js";
import { aggregateVoiceRecapQuality, scoreVoiceRecapQuality } from "./scorer.js";
import {
  VOICE_RECAP_EVAL_SCHEMA_VERSION,
  type VoiceRecapCandidateOutcome,
  type VoiceRecapEvalFixture,
  type VoiceRecapEvalSummary,
  type VoiceRecapFixtureResult,
  type VoiceRecapObservation,
  type VoiceRecapScorecard,
  type VoiceRecapScorecardEntry,
} from "./types.js";

// The fully content-free observation for a dormant deployment: no candidates, an empty transcript roll-up,
// and a content-free audit record stamped with the (denied) profile. The recap short-circuits at the
// capability predicate before reading any transcript or proposing any candidate (AC1).
function dormantObservation(fixture: VoiceRecapEvalFixture): VoiceRecapObservation {
  const transcript = summarizeVoiceTranscript([]);
  return buildObservation(fixture, false, [], 0, 0, transcript, fixture.assistantSpans.length);
}

// Flatten a fixture's user spans into the committed segments the candidate model consumes. Each span is
// projected independently so per-span char / segment counts stay content-free and disjoint.
function deriveCandidateOutcomes(
  fixture: VoiceRecapEvalFixture,
): readonly VoiceRecapCandidateOutcome[] {
  const outcomes: VoiceRecapCandidateOutcome[] = [];
  for (const span of fixture.userSpans) {
    const projection = selectCommittedVoiceTranscript(span.segments);
    const outcome = deriveCandidateOutcome(projection);
    if (outcome !== undefined) {
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

// Concatenate every user span's committed segments into one segment list so the whole-session transcript
// roll-up reuses `summarizeVoiceTranscript` exactly as the server does.
function allCommittedSegments(fixture: VoiceRecapEvalFixture): readonly VoiceTranscriptSegment[] {
  return fixture.userSpans.flatMap(
    (span) => selectCommittedVoiceTranscript(span.segments).segments,
  );
}

function buildAuditRecord(
  fixture: VoiceRecapEvalFixture,
  transcript: VoiceTranscriptEvidenceSummary,
  evidence: VoiceSessionRecapEvidenceSummary,
): VoiceSessionRecapAuditRecord {
  return buildVoiceSessionRecapAuditRecord({
    profile: fixture.profile,
    committedSegmentCount: transcript.segmentCount,
    committedChars: transcript.committedChars,
    candidatesExtracted: evidence.candidatesExtracted,
    candidatesRejected: evidence.candidatesRejected,
    candidatesProposed: evidence.candidatesProposed,
    triggeredByUser: true,
    // The eval never reads a clock; the content-free duration is a fixed sentinel (a count field, not text).
    durationMs: 0,
  });
}

// Assemble the observation from the derived candidate outcomes and the contract roll-up helpers. Shared by
// the dormant and active paths so the audit / evidence shape is identical in both.
function buildObservation(
  fixture: VoiceRecapEvalFixture,
  recapAllowed: boolean,
  outcomes: readonly VoiceRecapCandidateOutcome[],
  committedSegmentCount: number,
  committedChars: number,
  transcript: VoiceTranscriptEvidenceSummary,
  assistantTurnCount: number,
): VoiceRecapObservation {
  const candidatesProposed = outcomes.filter((o) => o.verdict === "proposed").length;
  const candidatesRejected = outcomes.filter((o) => o.verdict === "rejected").length;
  const evidence = summarizeVoiceSessionRecap(transcript, {
    candidatesExtracted: outcomes.length,
    candidatesProposed,
    candidatesRejected,
  });
  return {
    recapAllowed,
    committedSegmentCount,
    committedChars,
    assistantTurnCount,
    candidateOutcomes: outcomes,
    candidatesProposed,
    candidatesRejected,
    evidence,
    audit: buildAuditRecord(fixture, transcript, evidence),
  };
}

/**
 * Derive the deterministic observation for one fixture: the recap-gating verdict, the committed projection
 * counts, the content-free candidate outcomes, the transcript roll-up, the recap evidence summary, and the
 * content-free audit record. A denied profile short-circuits to a dormant observation (AC1). Pure data
 * derivation over the frozen contract.
 */
export function deriveVoiceRecapObservation(fixture: VoiceRecapEvalFixture): VoiceRecapObservation {
  if (!voiceRecapAllowed(fixture.profile)) {
    return dormantObservation(fixture);
  }
  const committed = allCommittedSegments(fixture);
  const transcript = summarizeVoiceTranscript(committed);
  const outcomes = deriveCandidateOutcomes(fixture);
  return buildObservation(
    fixture,
    true,
    outcomes,
    transcript.segmentCount,
    transcript.committedChars,
    transcript,
    fixture.assistantSpans.length,
  );
}

function runFixture(fixture: VoiceRecapEvalFixture): VoiceRecapFixtureResult {
  const observation = deriveVoiceRecapObservation(fixture);
  const dimensionResults = scoreVoiceRecapQuality(fixture, observation);
  return {
    fixtureName: fixture.name,
    category: fixture.category,
    observation,
    dimensionResults,
    fullyPassed: dimensionResults.every((d) => d.outcome !== "fail"),
  };
}

function summarize(
  fixtureResults: readonly VoiceRecapFixtureResult[],
  dimensions: readonly VoiceRecapScorecardEntry[],
): VoiceRecapEvalSummary {
  const allClean = dimensions.every((d) => d.failCount === 0);
  const coversNoVoiceProfile = fixtureResults.some((f) => !f.observation.recapAllowed);
  const coversVoiceProfile = fixtureResults.some((f) => f.observation.recapAllowed);
  return {
    totalFixtures: fixtureResults.length,
    fullyPassedFixtures: fixtureResults.filter((f) => f.fullyPassed).length,
    coversNoVoiceProfile,
    coversVoiceProfile,
    goNoGo: allClean && coversNoVoiceProfile && coversVoiceProfile ? "GO" : "NO-GO",
  };
}

function collectCandidateStatuses(
  fixtureResults: readonly VoiceRecapFixtureResult[],
): VoiceRecapScorecard["coveredCandidateStatuses"] {
  const statuses = fixtureResults
    .flatMap((f) => f.observation.candidateOutcomes)
    .map((o) => o.status)
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  // Sort to a canonical order so the covered-status list is stable regardless of fixture ordering
  // (matches the codebase determinism convention).
  return [...new Set(statuses)].sort();
}

/**
 * Run the Voice Session Recap evaluation suite and return a fully aggregated scorecard. Pure and
 * deterministic. Pass an explicit fixture list to scope the run (the suite tests use the default set).
 */
export function runVoiceRecapEvaluation(
  fixtures: readonly VoiceRecapEvalFixture[] = ALL_VOICE_RECAP_FIXTURES,
): VoiceRecapScorecard {
  const fixtureResults = fixtures.map(runFixture);
  const dimensions = aggregateVoiceRecapQuality(fixtureResults.map((f) => f.dimensionResults));
  return {
    schemaVersion: VOICE_RECAP_EVAL_SCHEMA_VERSION,
    fixtureResults,
    dimensions,
    summary: summarize(fixtureResults, dimensions),
    coveredCandidateStatuses: collectCandidateStatuses(fixtureResults),
  };
}
