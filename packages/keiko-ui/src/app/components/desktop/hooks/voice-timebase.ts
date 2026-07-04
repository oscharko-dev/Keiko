// Issue #498, Epic #491 (ADR-0103) — the Voice timing engine (timebase). It is the deterministic,
// content-free core that turns an out-of-order, jittery stream of #496 voice control messages into an
// ordered, bounded, replayable timeline the UI can render and a reconnect can catch up against. It
// owns NO transport, NO clock, NO audio: time enters through the injectable `VoiceClock` seam (D2) and
// every message arrives already validated by the #497 transport. Load-bearing for the privacy contract
// (AC6): it never logs, never persists, and never passes a `message`, transcript text, raw audio, or
// SDP/ICE string to its metrics observer — only derived, content-free integers/enums leave.
//
// Capability gating is delegated wholesale to the contract's `voiceMessageAllowedForProfile` (AC1/AC2/
// AC3): `none` is dormant and silent; `speech-to-text` admits only the dictation subset; `full-realtime`
// admits everything. Buffering eligibility is delegated to `isVoiceReplayEligible` — ephemeral signaling
// and partial transcripts are applied to the live view but never enter the replay ring (AC4/AC5).
// Ordering is by sequence number: only a strictly-forward `seq` applies; duplicates and late arrivals
// are content-free no-ops (AC5).

import type { VoiceProfile, VoiceCapabilityResolution } from "@/lib/types";
import {
  type VoiceControlMessage,
  type VoiceControlMessageKind,
  type VoiceRedactionClass,
  type VoiceMediaTrackState,
  type VoicePlaybackState,
  voiceMessageAllowedForProfile,
  isVoiceReplayEligible,
  voiceControlMessageRedactionClass,
} from "@oscharko-dev/keiko-contracts";

// ─── Clock seam (D2) ───────────────────────────────────────────────────────────
// Monotonic milliseconds. Production uses `performance.now()`; tests inject a scripted, deterministic
// clock so no real wall/monotonic clock ever leaks into the engine or its tests.
export interface VoiceClock {
  now(): number;
}

export function createBrowserVoiceClock(): VoiceClock {
  return { now: (): number => performance.now() };
}

// ─── Capacity / threshold constants (D4/D5) ────────────────────────────────────
// The replay ring is the bounded reconnect system-of-record; the partial log is a tiny ephemeral timing
// window; backpressure goes "elevated" at 80% of replay capacity (the partial log is never counted).
export const VOICE_TIMEBASE_REPLAY_CAPACITY = 200;
export const VOICE_TIMEBASE_PARTIAL_CAPACITY = 32;
export const VOICE_TIMEBASE_BACKPRESSURE_HIGH = 160;

// ─── Engine phases (state machine) ─────────────────────────────────────────────
export type VoiceTimebasePhase =
  "dormant" | "idle" | "capturing" | "transcribing" | "responding" | "interrupted" | "closed";

// ─── Backpressure signal (D5) — advisory only; the engine never blocks or queues ──
export type VoiceBackpressureLevel = "none" | "elevated" | "saturated";

// ─── Ingest outcome (D7) ───────────────────────────────────────────────────────
// Buffering is decided by `isVoiceReplayEligible(kind)`, not by a distinct outcome: an "applied"
// replay-eligible message is buffered; an "ignored-ephemeral" one is applied to the live view only.
export type VoiceIngestOutcome =
  "applied" | "duplicate" | "out-of-order" | "not-allowed-for-profile" | "ignored-ephemeral";

// A control message stamped with the monotonic clock. `message` is retained for catch-up re-delivery
// to the transport; the engine NEVER hands it to the observer or any log.
export interface VoiceTimedRecord {
  readonly seq: number;
  readonly kind: VoiceControlMessageKind;
  readonly receivedAtMs: number;
  readonly redaction: VoiceRedactionClass;
  readonly message: VoiceControlMessage;
}

// ─── Read-only snapshot the UI consumer renders (D3) ───────────────────────────
export interface VoiceTimebaseSnapshot {
  readonly profile: VoiceProfile;
  readonly active: boolean;
  readonly phase: VoiceTimebasePhase;
  readonly highestAppliedSeq: number;
  readonly captureState: VoiceMediaTrackState | undefined;
  readonly playbackState: VoicePlaybackState | undefined;
  readonly lastPartialReceivedAtMs: number | undefined;
  readonly lastCommittedSeq: number | undefined;
  readonly replayDepth: number;
  readonly overflowCount: number;
  readonly backpressure: VoiceBackpressureLevel;
}

export interface VoiceIngestResult {
  readonly outcome: VoiceIngestOutcome;
  readonly snapshot: VoiceTimebaseSnapshot;
}

// ─── Catch-up (D6) ─────────────────────────────────────────────────────────────
export interface VoiceCatchUpRequest {
  readonly sinceSeq: number;
}

export interface VoiceCatchUpResult {
  /**
   * The buffered replay-eligible records with `seq > sinceSeq`, in seq order. Each
   * `VoiceTimedRecord.message` carries its ORIGINAL payload — committed / discarded transcripts are
   * `reviewable-text`. A consumer re-delivering these on reconnect MUST route them through the
   * transport's existing strip / redact-at-persist seam before any log or evidence write; the engine
   * itself never logs or persists them.
   */
  readonly events: readonly VoiceTimedRecord[];
  readonly truncated: boolean;
}

// ─── Metrics observer (D9, AC6) — every field content-free ─────────────────────
export interface VoiceTimebaseMetricEvent {
  readonly kind: VoiceControlMessageKind;
  readonly seq: number;
  readonly redaction: VoiceRedactionClass;
  readonly outcome: VoiceIngestOutcome;
  /**
   * Inter-ingest interval since the previous APPLIED ingest, in ms (0 for the first applied event).
   * For non-applied outcomes (`duplicate`, `out-of-order`, `not-allowed-for-profile`, and an
   * `ignored-ephemeral` re-counted no-op) it measures the time since the last successful ingest — it
   * is NOT a per-message round-trip latency.
   */
  readonly latencyMs: number;
  readonly replayDepth: number;
  readonly overflowCount: number;
  readonly backpressure: VoiceBackpressureLevel;
}

export interface VoiceTimebaseOverflowEvent {
  readonly evictedSeq: number;
  readonly overflowCount: number;
  readonly replayDepth: number;
}

export interface VoiceTimebaseMetricsObserver {
  onIngest?(event: VoiceTimebaseMetricEvent): void;
  onOverflow?(event: VoiceTimebaseOverflowEvent): void;
  onBackpressureChange?(level: VoiceBackpressureLevel): void;
}

// ─── Construction (D8) ─────────────────────────────────────────────────────────
export interface VoiceTimebaseOptions {
  readonly profile: VoiceProfile;
  readonly clock?: VoiceClock;
  readonly observer?: VoiceTimebaseMetricsObserver | undefined;
}

export interface VoiceTimebaseEngine {
  ingest(message: VoiceControlMessage): VoiceIngestResult;
  catchUp(request: VoiceCatchUpRequest): VoiceCatchUpResult;
  snapshot(): VoiceTimebaseSnapshot;
  reset(): void;
}

// ─── Capability-gating input adapter (AC1) ─────────────────────────────────────
// Reuse the resolution rather than re-encode it: an absent or unavailable resolution is `none`, which
// makes the engine dormant and silent.
export function resolutionToVoiceProfile(
  resolution: VoiceCapabilityResolution | undefined,
): VoiceProfile {
  return resolution && resolution.available ? resolution.profile : "none";
}

// ─── Phase transition tables ───────────────────────────────────────────────────
// Media-track and playback sub-state both drive the phase; `Record`s keyed by the contract enum make
// totality a compile error and keep the transition branch-free. `undefined` here means "leave unchanged".
const MEDIA_TRACK_PHASE: Record<VoiceMediaTrackState, VoiceTimebasePhase | undefined> = {
  live: "capturing",
  ended: "idle",
  muted: undefined,
  negotiating: undefined,
};

const PLAYBACK_PHASE: Record<VoicePlaybackState, VoiceTimebasePhase> = {
  playing: "responding",
  paused: "responding",
  idle: "idle",
  stopped: "idle",
  interrupted: "interrupted",
};

function initialPhase(profile: VoiceProfile): VoiceTimebasePhase {
  return profile === "none" ? "dormant" : "idle";
}

// The engine's mutable working state, isolated so `reset()` is a single re-initialization.
interface VoiceTimebaseState {
  phase: VoiceTimebasePhase;
  highestAppliedSeq: number;
  captureState: VoiceMediaTrackState | undefined;
  playbackState: VoicePlaybackState | undefined;
  lastPartialReceivedAtMs: number | undefined;
  lastCommittedSeq: number | undefined;
  overflowCount: number;
  backpressure: VoiceBackpressureLevel;
  lastAppliedAtMs: number | undefined;
  // The seq of the most recent record an overflow eviction removed from the replay ring, or undefined
  // if none has been evicted. This is the precise, contiguity-independent catch-up truncation signal:
  // seq numbers are non-contiguous (ephemeral kinds consume seq but never enter the ring), so a
  // "smallest retained seq" heuristic gives false positives — an actual eviction does not.
  lastEvictedSeq: number | undefined;
  replayRing: VoiceTimedRecord[];
  partialLog: VoiceTimedRecord[];
}

function freshState(profile: VoiceProfile): VoiceTimebaseState {
  return {
    phase: initialPhase(profile),
    highestAppliedSeq: -1,
    captureState: undefined,
    playbackState: undefined,
    lastPartialReceivedAtMs: undefined,
    lastCommittedSeq: undefined,
    overflowCount: 0,
    backpressure: "none",
    lastAppliedAtMs: undefined,
    lastEvictedSeq: undefined,
    replayRing: [],
    partialLog: [],
  };
}

// The phase each kind drives to; `"keep"` leaves the phase unchanged. `media.track.state` and
// `playback.state` carry their own sub-state tables (in `applyKindEffects`) so they map to `"keep"`.
// Keying by `VoiceControlMessageKind` makes an unclassified kind a compile error (totality) and keeps
// the lookup branch-free — the pattern ADR-0103 prefers over a long switch (cf. the contract's table).
const KIND_PHASE: Record<VoiceControlMessageKind, VoiceTimebasePhase | "keep"> = {
  "session.created": "idle",
  "session.closed": "closed",
  "transcript.partial": "transcribing",
  "transcript.committed": "transcribing",
  "transcript.discarded": "transcribing",
  "control.interrupt": "interrupted",
  "session.create": "keep",
  "session.close": "keep",
  "capability.offer": "keep",
  "capability.select": "keep",
  "signal.sdp.offer": "keep",
  "signal.sdp.answer": "keep",
  "signal.ice.candidate": "keep",
  "media.track.state": "keep",
  "control.cancel": "keep",
  "playback.state": "keep",
  "policy.decision": "keep",
  error: "keep",
};

// Compute the next backpressure level (D5). Order matters: any eviction pins "saturated" for the rest
// of the session, since `overflowCount` is monotonic (AC4).
function backpressureFor(replayDepth: number, overflowCount: number): VoiceBackpressureLevel {
  if (overflowCount > 0) {
    return "saturated";
  }
  return replayDepth >= VOICE_TIMEBASE_BACKPRESSURE_HIGH ? "elevated" : "none";
}

export function createVoiceTimebaseEngine(options: VoiceTimebaseOptions): VoiceTimebaseEngine {
  const { profile } = options;
  const clock = options.clock ?? createBrowserVoiceClock();
  const observer = options.observer;
  let state = freshState(profile);

  function snapshot(): VoiceTimebaseSnapshot {
    return {
      profile,
      active: state.phase !== "dormant",
      phase: state.phase,
      highestAppliedSeq: state.highestAppliedSeq,
      captureState: state.captureState,
      playbackState: state.playbackState,
      lastPartialReceivedAtMs: state.lastPartialReceivedAtMs,
      lastCommittedSeq: state.lastCommittedSeq,
      replayDepth: state.replayRing.length,
      overflowCount: state.overflowCount,
      backpressure: state.backpressure,
    };
  }

  // Apply the per-kind live-view side effects (capture/playback sub-state, transcript anchors) and
  // drive the phase. Aside from the contained mutation of `state` fields this is a pure dispatch.
  function applyKindEffects(message: VoiceControlMessage, receivedAtMs: number): void {
    if (message.kind === "media.track.state") {
      state.captureState = message.state;
      const phase = MEDIA_TRACK_PHASE[message.state];
      if (phase !== undefined) {
        state.phase = phase;
      }
      return;
    }
    if (message.kind === "playback.state") {
      state.playbackState = message.state;
      state.phase = PLAYBACK_PHASE[message.state];
      return;
    }
    if (message.kind === "transcript.partial") {
      state.lastPartialReceivedAtMs = receivedAtMs;
    }
    if (message.kind === "transcript.committed") {
      state.lastCommittedSeq = message.seq;
    }
    const phase = KIND_PHASE[message.kind];
    if (phase !== "keep") {
      state.phase = phase;
    }
  }

  // Push an applied replay-eligible record, evicting + counting overflow when the ring is full (AC4).
  // Partial transcripts go to the bounded ephemeral partial log instead, never the replay ring.
  function buffer(record: VoiceTimedRecord): void {
    if (record.kind === "transcript.partial") {
      state.partialLog.push(record);
      if (state.partialLog.length > VOICE_TIMEBASE_PARTIAL_CAPACITY) {
        state.partialLog.shift();
      }
      return;
    }
    if (!isVoiceReplayEligible(record.kind)) {
      return;
    }
    state.replayRing.push(record);
    if (state.replayRing.length > VOICE_TIMEBASE_REPLAY_CAPACITY) {
      const evicted = state.replayRing.shift();
      state.overflowCount += 1;
      if (evicted !== undefined) {
        state.lastEvictedSeq = evicted.seq;
        observer?.onOverflow?.({
          evictedSeq: evicted.seq,
          overflowCount: state.overflowCount,
          replayDepth: state.replayRing.length,
        });
      }
    }
  }

  // Recompute backpressure and fire the observer only on a level transition (D5).
  function refreshBackpressure(): void {
    const next = backpressureFor(state.replayRing.length, state.overflowCount);
    if (next !== state.backpressure) {
      state.backpressure = next;
      observer?.onBackpressureChange?.(next);
    }
  }

  function emitIngest(
    message: VoiceControlMessage,
    outcome: VoiceIngestOutcome,
    redaction: VoiceRedactionClass,
    latencyMs: number,
  ): void {
    if (observer?.onIngest === undefined) {
      return;
    }
    observer.onIngest({
      kind: message.kind,
      seq: message.seq,
      redaction,
      outcome,
      latencyMs,
      replayDepth: state.replayRing.length,
      overflowCount: state.overflowCount,
      backpressure: state.backpressure,
    });
  }

  // Classify an ingest BEFORE applying side effects: gate by profile, then by sequence ordering. Only a
  // strictly-forward seq is "applied" (or "ignored-ephemeral" if not replay-eligible).
  function classify(message: VoiceControlMessage): VoiceIngestOutcome {
    if (!voiceMessageAllowedForProfile(message.kind, profile)) {
      return "not-allowed-for-profile";
    }
    if (message.seq === state.highestAppliedSeq) {
      return "duplicate";
    }
    if (message.seq < state.highestAppliedSeq) {
      return "out-of-order";
    }
    return isVoiceReplayEligible(message.kind) ? "applied" : "ignored-ephemeral";
  }

  function ingest(message: VoiceControlMessage): VoiceIngestResult {
    // Dormant (`none`) profile emits no metrics beyond construction (AC1): gate before any observer call.
    if (profile === "none") {
      return { outcome: "not-allowed-for-profile", snapshot: snapshot() };
    }
    const receivedAtMs = clock.now();
    const redaction = voiceControlMessageRedactionClass(message.kind);
    const outcome = classify(message);
    // Measured against the PREVIOUS applied ingest; read before the branch below advances lastAppliedAtMs.
    const latencyMs =
      state.lastAppliedAtMs === undefined ? 0 : receivedAtMs - state.lastAppliedAtMs;

    if (outcome === "applied" || outcome === "ignored-ephemeral") {
      state.highestAppliedSeq = message.seq;
      applyKindEffects(message, receivedAtMs);
      buffer({ seq: message.seq, kind: message.kind, receivedAtMs, redaction, message });
      refreshBackpressure();
      state.lastAppliedAtMs = receivedAtMs;
    }

    emitIngest(message, outcome, redaction, latencyMs);
    return { outcome, snapshot: snapshot() };
  }

  function catchUp(request: VoiceCatchUpRequest): VoiceCatchUpResult {
    const events = state.replayRing.filter((record) => record.seq > request.sinceSeq);
    // `truncated` means an actual eviction removed a replay-eligible record at or above the client's
    // anchor — precise regardless of seq contiguity, unlike a smallest-retained-seq heuristic which
    // sees ephemeral seq gaps as spurious loss.
    const truncated = state.lastEvictedSeq !== undefined && state.lastEvictedSeq > request.sinceSeq;
    return { events, truncated };
  }

  function reset(): void {
    state = freshState(profile);
  }

  return { ingest, catchUp, snapshot, reset };
}
