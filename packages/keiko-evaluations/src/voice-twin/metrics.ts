// Voice Digital Twin AC6 metric derivations (Epic #491, Issue #505; ADR-0110).
//
// Each metric is a pure derivation over a frozen keiko-contracts state machine, returning a small
// content-free record the scorer compares against the fixture oracle. The runtime reducers that drive
// these state machines live in keiko-ui (turn manager, transcript reducer, playback controller) and are
// OFF LIMITS here (ADR-0019 rule 3l); this suite proves the CONTRACT the reducers are bound to is
// regression-safe, while the reducers' own keiko-ui suites prove their behaviour. The five AC6 metrics:
// interruption, end-of-turn, transcript correction, provider-failure recovery, and the bounded-FIFO
// buffer model. Pure — no IO, clock, randomness.

import {
  VOICE_PLAYBACK_SETTLED_PHASES,
  VOICE_PLAYBACK_TRANSITIONS,
  VOICE_PROFILE_MEDIA_TRANSPORT,
  VOICE_TRANSCRIPT_CONSUMABLE_STATES,
  VOICE_TRANSCRIPT_SEGMENT_STATES,
  VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS,
  canTransitionVoicePlayback,
  isVoiceReplayEligible,
  selectCommittedVoiceTranscript,
  voiceMessageAllowedForProfile,
  voicePlaybackInterruptAllowedForProfile,
  voiceTranscriptCaptureAllowed,
  type VoiceControlMessageKind,
  type VoiceMediaTransport,
  type VoiceProfile,
  type VoiceTranscriptSegment,
  type VoiceTranscriptSegmentState,
} from "@oscharko-dev/keiko-contracts";
import type {
  BufferBoundednessMetricRecord,
  EndOfTurnMetricRecord,
  InterruptionMetricRecord,
  LatencyClassMetricRecord,
  ProviderFailureRecoveryMetricRecord,
  TranscriptCorrectionMetricRecord,
} from "./types.js";

// Mirrors the documented keiko-ui replay ring (200) and the keiko-server MAX_REPLAY_EVENTS bound. The
// value is restated here (not imported) because those packages are off-limits to keiko-evaluations
// (ADR-0019 rule 3l); the buffer model proves the boundedness invariant the contract's replay-eligibility
// classification implies, independent of the runtime ring's exact size.
export const VOICE_TWIN_REPLAY_CAPACITY = 200 as const;

// A fixed content-free segment builder. `text` is harness-authored filler ("x" repeated) so the committed
// projection has a non-zero character length without embedding any fixture content; it never leaves the
// metric as text (only its length / count is recorded).
function segment(
  id: string,
  seq: number,
  state: VoiceTranscriptSegmentState,
  options: { readonly supersedesId?: string } = {},
): VoiceTranscriptSegment {
  const textBearing = state === "committed" || state === "corrected" || state === "stable";
  return {
    id,
    seq,
    state,
    text: textBearing ? "xx" : "",
    source: "realtime",
    revision: 0,
    replayClass: "replayable",
    redactionClass: textBearing ? "reviewable-text" : "content-free",
    supersedesId: options.supersedesId,
  };
}

// ─── Interruption (barge-in) ─────────────────────────────────────────────────────────
export function deriveInterruptionMetric(profile: VoiceProfile): InterruptionMetricRecord {
  return {
    interruptAllowed: voicePlaybackInterruptAllowedForProfile(profile),
    interruptedPhaseReachable: canTransitionVoicePlayback("speaking", "interrupted"),
  };
}

// ─── End-of-turn (committed projection excludes uncommitted) ─────────────────────────
export function deriveEndOfTurnMetric(profile: VoiceProfile): EndOfTurnMetricRecord {
  // A fixture segment list spanning the lifecycle: one partial + one stable (uncommitted) and one segment
  // per consumable state. The committed projection must exclude the partial / stable text.
  const segments: readonly VoiceTranscriptSegment[] = [
    segment("eot-partial", 0, "partial"),
    segment("eot-stable", 1, "stable"),
    ...VOICE_TRANSCRIPT_CONSUMABLE_STATES.map((state, index) =>
      segment(`eot-consumable-${state}`, 2 + index, state),
    ),
  ];
  const projection = selectCommittedVoiceTranscript(segments);
  const projectedIds = new Set(projection.segments.map((s) => s.id));
  return {
    committedKindAllowed: voiceMessageAllowedForProfile("transcript.committed", profile),
    captureAllowed: voiceTranscriptCaptureAllowed(profile),
    committedSegmentCount: projection.segmentCount,
    excludesUncommitted: !projectedIds.has("eot-partial") && !projectedIds.has("eot-stable"),
  };
}

// ─── Transcript correction (supersede drops prior committed text) ────────────────────
export function deriveTranscriptCorrectionMetric(): TranscriptCorrectionMetricRecord {
  // A corrected segment supersedes a prior committed one. The committed projection must drop the
  // superseded segment so a provider correction REPLACES rather than duplicates the prior text.
  const segments: readonly VoiceTranscriptSegment[] = [
    segment("corr-committed", 0, "committed"),
    segment("corr-corrected", 1, "corrected", { supersedesId: "corr-committed" }),
  ];
  const projection = selectCommittedVoiceTranscript(segments);
  const projectedIds = new Set(projection.segments.map((s) => s.id));
  return {
    stableToCorrectedAllowed: VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS.stable.includes("corrected"),
    committedToCorrectedAllowed:
      VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS.committed.includes("corrected"),
    correctedIsConsumable: VOICE_TRANSCRIPT_CONSUMABLE_STATES.includes("corrected"),
    supersededTextDropped:
      !projectedIds.has("corr-committed") && projectedIds.has("corr-corrected"),
  };
}

// ─── Provider-failure recovery ───────────────────────────────────────────────────────
export function deriveProviderFailureRecoveryMetric(): ProviderFailureRecoveryMetricRecord {
  // A recovery transition out of the playback failure phase, read from the actual transition table (not
  // assumed): `failed` may re-arm `preparing`.
  const recoveryTransitionExists = VOICE_PLAYBACK_TRANSITIONS.failed.includes("preparing");
  return {
    providerErrorIsState: VOICE_TRANSCRIPT_SEGMENT_STATES.includes("provider-error"),
    // provider-error is a reviewable lifecycle fact but is NOT in the consumable set, so failed text never
    // reaches a downstream integration.
    providerErrorNotConsumable: !VOICE_TRANSCRIPT_CONSUMABLE_STATES.includes("provider-error"),
    playbackFailedIsSettled: VOICE_PLAYBACK_SETTLED_PHASES.includes("failed"),
    recoveryTransitionExists,
  };
}

// ─── Bounded-FIFO buffer model ───────────────────────────────────────────────────────
// Push the given control-message kinds through a fixed-capacity ring that ONLY admits replay-eligible
// kinds. Asserts length never exceeds capacity, ephemeral kinds never buffer, and overflow evicts the
// oldest. The runtime ring lives in keiko-ui / keiko-server (off-limits); this models the same invariant
// over the contract's `isVoiceReplayEligible` classification.
export function deriveBufferBoundednessMetric(
  kinds: readonly VoiceControlMessageKind[],
  capacity: number = VOICE_TWIN_REPLAY_CAPACITY,
): BufferBoundednessMetricRecord {
  const ring: VoiceControlMessageKind[] = [];
  let maxObservedLength = 0;
  let admittedCount = 0;
  let ephemeralBuffered = false;
  let evictedOldestOnOverflow = false;
  for (const kind of kinds) {
    if (!isVoiceReplayEligible(kind)) {
      // An ephemeral kind is never admitted; if it ever entered the ring the invariant is broken.
      ephemeralBuffered = ephemeralBuffered || ring.includes(kind);
      continue;
    }
    admittedCount += 1;
    if (ring.length >= capacity) {
      ring.shift();
      evictedOldestOnOverflow = true;
    }
    ring.push(kind);
    maxObservedLength = Math.max(maxObservedLength, ring.length);
  }
  return {
    capacity,
    maxObservedLength,
    admittedCount,
    ephemeralBuffered,
    evictedOldestOnOverflow,
  };
}

// ─── Latency posture class (Deliverable "latency") ───────────────────────────────────
// A total, deterministic map from the contract media-transport to the latency POSTURE class the transport
// implies. This is NOT a wall-clock measurement (which would need a clock + network reads and is out of the
// pure-harness boundary, covered by the keiko-ui voice-timebase suite, ADR-0103); it is the deterministic
// class the contract's transport choice fixes: `webrtc` is interactive full-duplex, `gateway-batch` is a
// single batched request/response, and `none` has no latency surface. Keyed for totality so a new media
// transport added to the contract is a compile error here, not a silent wrong class.
const LATENCY_CLASS_BY_TRANSPORT: Record<
  VoiceMediaTransport,
  LatencyClassMetricRecord["latencyClass"]
> = {
  none: "none",
  "gateway-batch": "batch",
  webrtc: "interactive-realtime",
};

export function deriveLatencyClassMetric(profile: VoiceProfile): LatencyClassMetricRecord {
  const mediaTransport = VOICE_PROFILE_MEDIA_TRANSPORT[profile];
  const latencyClass = LATENCY_CLASS_BY_TRANSPORT[mediaTransport];
  return {
    mediaTransport,
    latencyClass,
    isInteractive: latencyClass === "interactive-realtime",
  };
}
