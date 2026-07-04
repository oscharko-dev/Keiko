// Voice Digital Twin scorer (Epic #491, Issue #505; ADR-0110).
//
// Pure per-dimension scoring + suite aggregation across the eleven capstone dimensions. Each dimension is a
// pure function over the fixture + its derived observation. A dimension a fixture does not declare is
// `not-applicable` and excluded from aggregation. Each dimension combines a STRUCTURAL gate (the contract
// fact the cell / metric must satisfy) with the fixture oracle, so weakening a capability table, leaking a
// forbidden message kind into the STT profile, dropping the loopback control plane, letting an unapproved
// egress through, or breaking a metric flips the corresponding dimension to FAIL. Rationales are
// harness-authored and content-free (counts, closed-vocabulary labels, numbers).

import {
  VOICE_CONTROL_TRANSPORTS,
  type VoiceControlMessageKind,
  type VoiceMediaTransport,
} from "@oscharko-dev/keiko-contracts";
import { VOICE_TWIN_REPLAY_CAPACITY } from "./metrics.js";
import {
  VOICE_TWIN_DIMENSIONS,
  type LatencyClassMetricRecord,
  type VoiceTwinDimension,
  type VoiceTwinDimensionResult,
  type VoiceTwinFixture,
  type VoiceTwinObservation,
  type VoiceTwinScorecardEntry,
} from "./types.js";

// The control-message kinds STT-only must NEVER permit (AC3): WebRTC media signalling, media-track state,
// playback, and barge-in interruption all belong to the full-realtime / speech-output paths.
const STT_FORBIDDEN_KINDS: readonly VoiceControlMessageKind[] = [
  "signal.sdp.offer",
  "signal.sdp.answer",
  "signal.ice.candidate",
  "media.track.state",
  "playback.state",
  "control.interrupt",
];

// The kinds full-realtime MUST permit (AC4): WebRTC SDP signalling and media-track state.
const REALTIME_REQUIRED_KINDS: readonly VoiceControlMessageKind[] = [
  "signal.sdp.offer",
  "signal.sdp.answer",
  "media.track.state",
];

interface Check {
  readonly label: string;
  readonly ok: boolean;
}

function gate(dimension: VoiceTwinDimension, checks: readonly Check[]): VoiceTwinDimensionResult {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return {
      dimension,
      outcome: "pass",
      rationale: `${String(checks.length)}/${String(checks.length)} structural checks met.`,
    };
  }
  return {
    dimension,
    outcome: "fail",
    rationale: `failed: ${failed.map((c) => c.label).join("; ")}.`,
  };
}

// ─── Capability-matrix consistency ───────────────────────────────────────────────────
function scoreCapabilityMatrix(
  fixture: VoiceTwinFixture,
  obs: VoiceTwinObservation,
): VoiceTwinDimensionResult {
  const cell = obs.cell;
  return gate("capability-matrix-consistency", [
    {
      label: "effective profile matches the oracle expectation",
      ok: cell.effectiveProfile === fixture.oracle.expectedEffectiveProfile,
    },
    {
      label: "control plane is loopback",
      ok: cell.controlPlaneIsLoopback,
    },
    {
      // `none` egresses nowhere; any active capability egresses only to the configured model endpoint.
      label: "egress class matches the effective profile",
      ok:
        cell.effectiveProfile === "none"
          ? cell.egressClass === "none"
          : cell.egressClass === "configured-model-endpoint",
    },
  ]);
}

// ─── No-voice dormancy (AC1 / AC2) ───────────────────────────────────────────────────
function scoreNoVoiceDormancy(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const cell = obs.cell;
  return gate("no-voice-dormancy", [
    { label: "effective profile is none", ok: cell.effectiveProfile === "none" },
    { label: "no allowed control message kinds", ok: cell.allowedKinds.length === 0 },
    { label: "media transport is none", ok: cell.mediaTransport === "none" },
    { label: "negotiation is disabled", ok: cell.negotiation === "disabled" },
    { label: "egress class is none", ok: cell.egressClass === "none" },
  ]);
}

// ─── STT affordance bounding (AC3) ───────────────────────────────────────────────────
function scoreSttAffordanceBounding(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const cell = obs.cell;
  const allowed = cell.allowedKinds;
  const excludesForbidden = STT_FORBIDDEN_KINDS.every((kind) => !allowed.includes(kind));
  return gate("stt-affordance-bounding", [
    {
      label: "effective profile is speech-to-text",
      ok: cell.effectiveProfile === "speech-to-text",
    },
    { label: "transcript dictation kinds permitted", ok: allowed.includes("transcript.committed") },
    { label: "WebRTC / media / playback / interrupt kinds excluded", ok: excludesForbidden },
    {
      label: "media transport is gateway-batch not webrtc",
      ok: cell.mediaTransport === "gateway-batch",
    },
    { label: "negotiation is disabled", ok: cell.negotiation === "disabled" },
  ]);
}

// ─── Transport plane separation (AC4) ────────────────────────────────────────────────
function scoreTransportPlaneSeparation(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const cell = obs.cell;
  const allowed = cell.allowedKinds;
  const includesRealtimeKinds = REALTIME_REQUIRED_KINDS.every((kind) => allowed.includes(kind));
  return gate("transport-plane-separation", [
    { label: "effective profile is full-realtime", ok: cell.effectiveProfile === "full-realtime" },
    { label: "media transport is webrtc", ok: cell.mediaTransport === "webrtc" },
    { label: "negotiation is proxied-sdp", ok: cell.negotiation === "proxied-sdp" },
    { label: "SDP / media-track signalling kinds present", ok: includesRealtimeKinds },
    {
      label: "control plane is loopback (loopback-websocket available)",
      ok: cell.controlPlaneIsLoopback && VOICE_CONTROL_TRANSPORTS.includes("loopback-websocket"),
    },
  ]);
}

// ─── External-destination privacy (AC5) ──────────────────────────────────────────────
function scoreExternalDestinationPrivacy(
  fixture: VoiceTwinFixture,
  obs: VoiceTwinObservation,
): VoiceTwinDimensionResult {
  return gate("external-destination-privacy", [
    {
      // The dimension PASSES when the auditor's verdict matches the fixture oracle: a positive fixture
      // audits approved, a privacy-negative fixture is correctly caught (approved=false).
      label: "egress audit verdict matches oracle expectation",
      ok: obs.egressAudit.approved === fixture.oracle.expectedEgressApproved,
    },
    {
      label: "manifest scan verdict matches oracle expectation",
      ok: obs.manifestScan.clean === fixture.oracle.expectedManifestsClean,
    },
    {
      // An approved-expected fixture must carry zero unapproved destinations; a negative one must carry at
      // least one (so the teeth are exercised, not merely asserted).
      label: "unapproved-destination count agrees with the verdict",
      ok: fixture.oracle.expectedEgressApproved
        ? obs.egressAudit.unapprovedCount === 0
        : obs.egressAudit.unapprovedCount > 0,
    },
  ]);
}

// ─── AC6 metric dimensions ───────────────────────────────────────────────────────────
function scoreInterruptionMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.interruption;
  if (metric === undefined) {
    return missingMetric("interruption-metric");
  }
  return gate("interruption-metric", [
    { label: "interrupt allowed for the capable profile", ok: metric.interruptAllowed },
    { label: "speaking -> interrupted is reachable", ok: metric.interruptedPhaseReachable },
  ]);
}

function scoreEndOfTurnMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.endOfTurn;
  if (metric === undefined) {
    return missingMetric("end-of-turn-metric");
  }
  return gate("end-of-turn-metric", [
    { label: "transcript.committed permitted for the profile", ok: metric.committedKindAllowed },
    { label: "transcript capture permitted for the profile", ok: metric.captureAllowed },
    { label: "committed projection is non-empty", ok: metric.committedSegmentCount > 0 },
    { label: "committed projection excludes partial / stable", ok: metric.excludesUncommitted },
  ]);
}

function scoreTranscriptCorrectionMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.transcriptCorrection;
  if (metric === undefined) {
    return missingMetric("transcript-correction-metric");
  }
  return gate("transcript-correction-metric", [
    { label: "stable -> corrected transition allowed", ok: metric.stableToCorrectedAllowed },
    { label: "committed -> corrected transition allowed", ok: metric.committedToCorrectedAllowed },
    { label: "corrected is a consumable state", ok: metric.correctedIsConsumable },
    {
      label: "superseded committed text dropped from projection",
      ok: metric.supersededTextDropped,
    },
  ]);
}

function scoreProviderFailureRecoveryMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.providerFailureRecovery;
  if (metric === undefined) {
    return missingMetric("provider-failure-recovery-metric");
  }
  return gate("provider-failure-recovery-metric", [
    { label: "provider-error is a transcript state", ok: metric.providerErrorIsState },
    { label: "provider-error is not consumable", ok: metric.providerErrorNotConsumable },
    { label: "playback failed is a settled phase", ok: metric.playbackFailedIsSettled },
    { label: "a recovery transition exists out of failure", ok: metric.recoveryTransitionExists },
  ]);
}

function scoreBufferBoundednessMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.bufferBoundedness;
  if (metric === undefined) {
    return missingMetric("buffer-boundedness-metric");
  }
  return gate("buffer-boundedness-metric", [
    {
      label: "capacity equals the documented ring size",
      ok: metric.capacity === VOICE_TWIN_REPLAY_CAPACITY,
    },
    {
      // Under overflow the ring fills EXACTLY to capacity (not merely ≤): a self-referential ≤capacity
      // check would pass even at a trivial capacity that never evicted, so we require equality whenever
      // eviction occurred and ≤capacity only in the no-overflow case.
      label: "ring fills exactly to capacity under overflow",
      ok: metric.evictedOldestOnOverflow
        ? metric.maxObservedLength === metric.capacity
        : metric.maxObservedLength <= metric.capacity,
    },
    { label: "no ephemeral kind ever buffered", ok: !metric.ephemeralBuffered },
    { label: "overflow evicts the oldest entry", ok: metric.evictedOldestOnOverflow },
    { label: "at least one replay-eligible kind admitted", ok: metric.admittedCount > 0 },
  ]);
}

// The latency POSTURE class each media transport must map to. A total map so a new transport added to the
// contract is a compile error here, keeping the scorer's expectation in lock-step with the derivation.
const EXPECTED_LATENCY_CLASS: Record<
  VoiceMediaTransport,
  LatencyClassMetricRecord["latencyClass"]
> = {
  none: "none",
  "gateway-batch": "batch",
  webrtc: "interactive-realtime",
};

function scoreLatencyClassMetric(obs: VoiceTwinObservation): VoiceTwinDimensionResult {
  const metric = obs.metrics.latencyClass;
  if (metric === undefined) {
    return missingMetric("latency-class-metric");
  }
  const expectedClass = EXPECTED_LATENCY_CLASS[metric.mediaTransport];
  return gate("latency-class-metric", [
    {
      label: "latency class matches the media-transport mapping",
      ok: metric.latencyClass === expectedClass,
    },
    {
      // A `webrtc` (full-realtime) transport is interactive; every batch / none transport is not.
      label: "isInteractive agrees with an interactive-realtime class",
      ok: metric.isInteractive === (metric.latencyClass === "interactive-realtime"),
    },
    {
      label: "webrtc is interactive while batch / none are not",
      ok: metric.mediaTransport === "webrtc" ? metric.isInteractive : !metric.isInteractive,
    },
  ]);
}

function missingMetric(dimension: VoiceTwinDimension): VoiceTwinDimensionResult {
  return {
    dimension,
    outcome: "fail",
    rationale: `failed: ${dimension} declared but no metric record was derived.`,
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────────────
// The metric dimensions (the five AC6 metrics plus the latency-posture class) are dispatched separately so
// neither dispatcher exceeds the cyclomatic complexity ceiling. `undefined` means the dimension is not a
// metric dimension.
function scoreMetricDimension(
  dimension: VoiceTwinDimension,
  obs: VoiceTwinObservation,
): VoiceTwinDimensionResult | undefined {
  switch (dimension) {
    case "interruption-metric":
      return scoreInterruptionMetric(obs);
    case "end-of-turn-metric":
      return scoreEndOfTurnMetric(obs);
    case "transcript-correction-metric":
      return scoreTranscriptCorrectionMetric(obs);
    case "provider-failure-recovery-metric":
      return scoreProviderFailureRecoveryMetric(obs);
    case "buffer-boundedness-metric":
      return scoreBufferBoundednessMetric(obs);
    case "latency-class-metric":
      return scoreLatencyClassMetric(obs);
    default:
      return undefined;
  }
}

function scoreDimension(
  dimension: VoiceTwinDimension,
  fixture: VoiceTwinFixture,
  obs: VoiceTwinObservation,
): VoiceTwinDimensionResult {
  switch (dimension) {
    case "capability-matrix-consistency":
      return scoreCapabilityMatrix(fixture, obs);
    case "no-voice-dormancy":
      return scoreNoVoiceDormancy(obs);
    case "stt-affordance-bounding":
      return scoreSttAffordanceBounding(obs);
    case "transport-plane-separation":
      return scoreTransportPlaneSeparation(obs);
    case "external-destination-privacy":
      return scoreExternalDestinationPrivacy(fixture, obs);
    default:
      return scoreMetricDimension(dimension, obs) ?? missingMetric(dimension);
  }
}

/**
 * Score one fixture's observation across all eleven dimensions. A dimension the fixture does not declare is
 * `not-applicable`. Pure.
 */
export function scoreVoiceTwinQuality(
  fixture: VoiceTwinFixture,
  obs: VoiceTwinObservation,
): readonly VoiceTwinDimensionResult[] {
  return VOICE_TWIN_DIMENSIONS.map((dimension) =>
    fixture.dimensions.has(dimension)
      ? scoreDimension(dimension, fixture, obs)
      : {
          dimension,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
  );
}

// ─── Suite aggregation ─────────────────────────────────────────────────────────────────
function aggregateDimension(
  dimension: VoiceTwinDimension,
  results: readonly (readonly VoiceTwinDimensionResult[])[],
): VoiceTwinScorecardEntry {
  let passCount = 0;
  let failCount = 0;
  let notApplicableCount = 0;
  for (const dims of results) {
    const outcome = dims.find((d) => d.dimension === dimension)?.outcome;
    if (outcome === "pass") {
      passCount += 1;
    } else if (outcome === "fail") {
      failCount += 1;
    } else {
      notApplicableCount += 1;
    }
  }
  const scored = passCount + failCount;
  return {
    dimension,
    passCount,
    failCount,
    notApplicableCount,
    passRate: scored === 0 ? null : passCount / scored,
  };
}

export function aggregateVoiceTwinQuality(
  results: readonly (readonly VoiceTwinDimensionResult[])[],
): readonly VoiceTwinScorecardEntry[] {
  return VOICE_TWIN_DIMENSIONS.map((dimension) => aggregateDimension(dimension, results));
}
