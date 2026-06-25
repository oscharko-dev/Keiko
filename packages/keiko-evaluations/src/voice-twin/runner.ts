// Voice Digital Twin evaluation runner (Epic #491, Issue #505; ADR-0068).
//
// Derives a deterministic observation for each fixture from the frozen keiko-contracts voice tables and
// state machines — the capability cell, the egress / supply-chain audit, and exactly the AC6 metric
// records the fixture's declared dimensions require — then scores the eleven dimensions, aggregates a
// scorecard, and derives the offline Go/No-Go verdict and the matrix-coverage flags. Pure: no IO, clock,
// randomness, or model dispatch.

import {
  VOICE_CONTROL_MESSAGE_KINDS,
  type VoiceControlMessageKind,
} from "@oscharko-dev/keiko-contracts";
import { deriveCapabilityCell } from "./capability.js";
import {
  VOICE_TWIN_REPLAY_CAPACITY,
  deriveBufferBoundednessMetric,
  deriveEndOfTurnMetric,
  deriveInterruptionMetric,
  deriveLatencyClassMetric,
  deriveProviderFailureRecoveryMetric,
  deriveTranscriptCorrectionMetric,
} from "./metrics.js";
import { auditVoiceEgress, scanManifestsForDeniedMediaPackages } from "./privacy.js";
import { aggregateVoiceTwinQuality, scoreVoiceTwinQuality } from "./scorer.js";
import { ALL_VOICE_TWIN_FIXTURES } from "./fixtures/index.js";
import {
  VOICE_TWIN_EVAL_SCHEMA_VERSION,
  type VoiceTwinCapabilityCell,
  type VoiceTwinEvalSummary,
  type VoiceTwinFixture,
  type VoiceTwinFixtureResult,
  type VoiceTwinMatrixCell,
  type VoiceTwinMetricBundle,
  type VoiceTwinObservation,
  type VoiceTwinScorecard,
  type VoiceTwinScorecardEntry,
} from "./types.js";

// The control-message kind sequence the buffer-boundedness model pushes: every kind repeated enough times
// that the replay-eligible subset overflows the ring, so eviction is exercised. `transcript.partial` and
// other ephemeral kinds are interleaved to prove they never buffer.
function bufferProbeKinds(capacity: number): readonly VoiceControlMessageKind[] {
  const kinds: VoiceControlMessageKind[] = [];
  // Enough repetitions of the full kind catalog to exceed capacity with the replay-eligible subset alone.
  const rounds = capacity + 4;
  for (let round = 0; round < rounds; round += 1) {
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      kinds.push(kind);
    }
  }
  return kinds;
}

// Derive exactly the metric records the fixture's declared dimensions require, against the effective
// profile of the cell. A metric absent from the declared dimensions is omitted (exactOptionalPropertyTypes
// forbids assigning `undefined` to an optional prop, so we build the bundle incrementally).
function deriveMetrics(
  fixture: VoiceTwinFixture,
  cell: VoiceTwinCapabilityCell,
): VoiceTwinMetricBundle {
  const bundle: {
    -readonly [K in keyof VoiceTwinMetricBundle]: VoiceTwinMetricBundle[K];
  } = {};
  if (fixture.dimensions.has("interruption-metric")) {
    bundle.interruption = deriveInterruptionMetric(cell.effectiveProfile);
  }
  if (fixture.dimensions.has("end-of-turn-metric")) {
    bundle.endOfTurn = deriveEndOfTurnMetric(cell.effectiveProfile);
  }
  if (fixture.dimensions.has("transcript-correction-metric")) {
    bundle.transcriptCorrection = deriveTranscriptCorrectionMetric();
  }
  if (fixture.dimensions.has("provider-failure-recovery-metric")) {
    bundle.providerFailureRecovery = deriveProviderFailureRecoveryMetric();
  }
  if (fixture.dimensions.has("buffer-boundedness-metric")) {
    bundle.bufferBoundedness = deriveBufferBoundednessMetric(
      bufferProbeKinds(VOICE_TWIN_REPLAY_CAPACITY),
      VOICE_TWIN_REPLAY_CAPACITY,
    );
  }
  if (fixture.dimensions.has("latency-class-metric")) {
    bundle.latencyClass = deriveLatencyClassMetric(cell.effectiveProfile);
  }
  return bundle;
}

/**
 * Derive the deterministic observation for one fixture: the contract-derived capability cell, the egress
 * and supply-chain audits, and the declared AC6 metric records. Pure data derivation over the frozen
 * contract.
 */
export function deriveVoiceTwinObservation(fixture: VoiceTwinFixture): VoiceTwinObservation {
  const cell = deriveCapabilityCell(fixture.environment, fixture.advertisedProfile);
  return {
    environment: fixture.environment,
    advertisedProfile: fixture.advertisedProfile,
    cell,
    egressAudit: auditVoiceEgress(fixture.egressLedger),
    manifestScan: scanManifestsForDeniedMediaPackages(fixture.manifests),
    metrics: deriveMetrics(fixture, cell),
  };
}

function runFixture(fixture: VoiceTwinFixture): VoiceTwinFixtureResult {
  const observation = deriveVoiceTwinObservation(fixture);
  const dimensionResults = scoreVoiceTwinQuality(fixture, observation);
  return {
    fixtureName: fixture.name,
    category: fixture.category,
    environment: fixture.environment,
    effectiveProfile: observation.cell.effectiveProfile,
    observation,
    dimensionResults,
    fullyPassed: dimensionResults.every((d) => d.outcome !== "fail"),
  };
}

function collectMatrixCells(
  fixtureResults: readonly VoiceTwinFixtureResult[],
): readonly VoiceTwinMatrixCell[] {
  const seen = new Map<string, VoiceTwinMatrixCell>();
  for (const result of fixtureResults) {
    const key = `${result.environment}:${result.effectiveProfile}`;
    if (!seen.has(key)) {
      seen.set(key, {
        environment: result.environment,
        effectiveProfile: result.effectiveProfile,
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.environment === b.environment
      ? a.effectiveProfile.localeCompare(b.effectiveProfile)
      : a.environment.localeCompare(b.environment),
  );
}

function summarize(
  fixtureResults: readonly VoiceTwinFixtureResult[],
  dimensions: readonly VoiceTwinScorecardEntry[],
): VoiceTwinEvalSummary {
  const allClean = dimensions.every((d) => d.failCount === 0);
  const coversNoVoice = fixtureResults.some((f) => f.effectiveProfile === "none");
  const coversSttOnly = fixtureResults.some((f) => f.effectiveProfile === "speech-to-text");
  const coversSpeechOutput = fixtureResults.some((f) => f.effectiveProfile === "speech-output");
  const coversFullRealtime = fixtureResults.some((f) => f.effectiveProfile === "full-realtime");
  const coversAzureFoundry = fixtureResults.some((f) => f.environment === "azure-foundry");
  const coversCustomerHosted = fixtureResults.some((f) => f.environment === "customer-hosted");
  const coversPrivacyNegative = fixtureResults.some(
    (f) => f.category === "privacy" && !f.observation.egressAudit.approved,
  );
  const coverageMet =
    coversNoVoice &&
    coversSttOnly &&
    coversSpeechOutput &&
    coversFullRealtime &&
    coversAzureFoundry &&
    coversCustomerHosted &&
    coversPrivacyNegative;
  return {
    totalFixtures: fixtureResults.length,
    fullyPassedFixtures: fixtureResults.filter((f) => f.fullyPassed).length,
    coversNoVoice,
    coversSttOnly,
    coversSpeechOutput,
    coversFullRealtime,
    coversAzureFoundry,
    coversCustomerHosted,
    coversPrivacyNegative,
    goNoGo: allClean && coverageMet ? "GO" : "NO-GO",
  };
}

/**
 * Run the Voice Digital Twin evaluation suite and return a fully aggregated scorecard. Pure and
 * deterministic. Pass an explicit fixture list to scope the run (the suite tests use the default set).
 */
export function runVoiceTwinEvaluation(
  fixtures: readonly VoiceTwinFixture[] = ALL_VOICE_TWIN_FIXTURES,
): VoiceTwinScorecard {
  const fixtureResults = fixtures.map(runFixture);
  const dimensions = aggregateVoiceTwinQuality(fixtureResults.map((f) => f.dimensionResults));
  return {
    schemaVersion: VOICE_TWIN_EVAL_SCHEMA_VERSION,
    fixtureResults,
    dimensions,
    summary: summarize(fixtureResults, dimensions),
    coveredMatrixCells: collectMatrixCells(fixtureResults),
  };
}
