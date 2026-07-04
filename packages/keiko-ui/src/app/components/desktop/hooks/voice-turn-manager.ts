// Issue #499, Epic #491 (ADR-0104) — the Voice turn manager. It is the deterministic, content-free
// semantic layer that sits ABOVE the #498 timing engine's ordered control stream and BELOW the UI
// hook that drives rendering. Where the timing engine decides ordering, buffering, and replay, the
// turn manager decides who holds the conversational floor, when a turn has ended, how a barge-in must
// alter both playback and the next-turn state, and what the difference is between "end-of-turn
// detected" and "user confirms dictation commit" in speech-to-text mode. It owns NO transport, NO
// clock, NO audio: time enters through the injectable `VoiceClock` seam reused from `voice-timebase.ts`
// (the convention ADR-0103 established), and every signal arrives already mapped from a decoded
// control message or a local UI event by the consuming hook.
//
// Capability gating is delegated wholesale to the contract's `voiceMessageAllowedForProfile` (AC1/AC2/
// AC3): `none` is dormant and silent; `speech-to-text` admits only the dictation subset and reaches a
// restricted set of states with no live floor control; `speech-output` admits playback and interrupts
// but no user-speech capture (an asymmetric floor); `full-realtime` admits everything. Critically, the
// gating predicates derive the correct SEMANTIC mapping from the contract, not a strict 1:1 wire map:
// speech-to-text dictation capture rides `transcript.*` over the gateway-batch media transport, not the
// WebRTC `media.track.state` track, so user capture is admitted for STT through `transcript.committed`.
//
// Load-bearing for the privacy contract (AC4): it never logs, never persists, and never passes a
// transcript, raw audio, or SDP/ICE string to its observer — only derived, content-free integers,
// millisecond deltas, and signal-kind / state enum literals leave. The effect vocabulary is media-floor
// only by construction (AC5): no effect grants workflow authority, triggers a model call, or writes to
// any store; spoken intent continues to flow through the existing WorkflowHandoff chain, which this
// module has no path to reach.

import type { VoiceProfile } from "@/lib/types";
import { voiceMessageAllowedForProfile } from "@oscharko-dev/keiko-contracts";
import {
  type VoiceClock,
  createBrowserVoiceClock,
  resolutionToVoiceProfile,
} from "./voice-timebase";

// Re-export the clock seam and the capability adapter so consumers of the turn manager construct it
// from the same primitives as the timing engine without importing two sibling modules.
export { createBrowserVoiceClock, resolutionToVoiceProfile };
export type { VoiceClock };

// ─── Turn states (D3) ───────────────────────────────────────────────────────────
// Eight states. `disabled` is terminal (profile=none, permission denied, or non-recoverable failure);
// `recovering` is the distinct, non-terminal recoverable-failure state. Speech-to-text reaches only
// idle / listening / recovering / disabled (its floor-bearing signals are rejected by the profile
// gate), which is how it "does not pretend full floor control" (AC2).
export type VoiceTurnState =
  | "disabled"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "yielding"
  | "recovering";

// ─── Floor holder (D3) — derived from state, never stored ───────────────────────
export type VoiceFloorHolder = "none" | "user" | "assistant";

// A total table keyed by `VoiceTurnState`: adding a state without classifying its floor holder is a
// compile error (totality). The snapshot derives the floor from this at read time, which eliminates
// state/floor divergence (D9).
const FLOOR_HOLDER: Record<VoiceTurnState, VoiceFloorHolder> = {
  disabled: "none",
  idle: "none",
  listening: "user",
  thinking: "assistant",
  speaking: "assistant",
  interrupted: "none",
  yielding: "none",
  recovering: "none",
};

// ─── Input signal union (D4) ────────────────────────────────────────────────────
// A semantic signal union the caller maps from wire control messages and local UI events. This
// decouples the manager from the wire encoding. `assistant-speech-end` distinguishes a cooperative
// `completed` end from a `stopped` (mid-barge-in) end; `user-interrupt` carries the optional
// client-perceived media offset `atMs`.
export type VoiceTurnSignal =
  | { readonly kind: "user-speech-start" }
  | { readonly kind: "user-end-of-turn" }
  | { readonly kind: "dictation-commit" }
  | { readonly kind: "dictation-discard" }
  | { readonly kind: "assistant-speech-start" }
  | { readonly kind: "assistant-speech-end"; readonly how: "completed" | "stopped" }
  | { readonly kind: "user-interrupt"; readonly atMs?: number | undefined }
  | { readonly kind: "backchannel" }
  | { readonly kind: "provider-failure"; readonly recoverable: boolean }
  | { readonly kind: "permission-denied" }
  | { readonly kind: "recovered" }
  | { readonly kind: "session-closed" };

export type VoiceTurnSignalKind = VoiceTurnSignal["kind"];

// ─── Effects (D7) — content-free directives the manager EMITS but never executes ──
// The effect vocabulary is media-floor only. No effect grants workflow authority, triggers a model
// call, commits a workspace patch, or writes to any store; this satisfies AC5 by construction.
export type VoiceTurnEffect =
  | "stop-playback"
  | "cancel-speech-generation"
  | "preserve-user-turn"
  | "emit-backchannel"
  | "begin-recovery";

// ─── Apply outcome (D2) ─────────────────────────────────────────────────────────
// `transitioned` — the signal changed state and/or counters; `no-op` — valid for the profile but with
// no meaningful effect in the current state; `not-allowed-for-profile` — rejected by the capability
// gate (and the only outcome ever produced by a dormant `none`-profile manager).
export type VoiceTurnApplyOutcome = "transitioned" | "no-op" | "not-allowed-for-profile";

// ─── Read-only snapshot (D9) ────────────────────────────────────────────────────
export interface VoiceTurnSnapshot {
  readonly profile: VoiceProfile;
  readonly active: boolean;
  readonly state: VoiceTurnState;
  readonly floorHolder: VoiceFloorHolder;
  readonly turnIndex: number;
  readonly interruptions: number;
  readonly backchannels: number;
  readonly pendingCommit: boolean;
  readonly recovering: boolean;
  readonly lastEndOfTurnAtMs: number | undefined;
  readonly lastInterruptAtMs: number | undefined;
}

export interface VoiceTurnApplyResult {
  readonly outcome: VoiceTurnApplyOutcome;
  readonly effects: readonly VoiceTurnEffect[];
  readonly snapshot: VoiceTurnSnapshot;
}

// ─── Content-free observer (D8, AC4) — every field enum / integer / ms ───────────
export interface VoiceTurnTransitionEvent {
  readonly from: VoiceTurnState;
  readonly to: VoiceTurnState;
  readonly trigger: VoiceTurnSignalKind;
  readonly floorHolder: VoiceFloorHolder;
  readonly turnIndex: number;
  readonly latencyMs: number;
}

export interface VoiceTurnInterruptEvent {
  readonly state: VoiceTurnState;
  readonly atMs: number | undefined;
  readonly interruptions: number;
}

export interface VoiceTurnBackchannelEvent {
  readonly state: VoiceTurnState;
  readonly backchannels: number;
}

export interface VoiceTurnEffectEvent {
  readonly effect: VoiceTurnEffect;
  readonly state: VoiceTurnState;
  readonly turnIndex: number;
}

export interface VoiceTurnManagerObserver {
  onTransition?(event: VoiceTurnTransitionEvent): void;
  onInterrupt?(event: VoiceTurnInterruptEvent): void;
  onBackchannel?(event: VoiceTurnBackchannelEvent): void;
  onEffect?(event: VoiceTurnEffectEvent): void;
}

// ─── Construction (D2) ──────────────────────────────────────────────────────────
export interface VoiceTurnManagerOptions {
  readonly profile: VoiceProfile;
  readonly clock?: VoiceClock;
  readonly observer?: VoiceTurnManagerObserver | undefined;
}

export interface VoiceTurnManagerEngine {
  apply(signal: VoiceTurnSignal): VoiceTurnApplyResult;
  snapshot(): VoiceTurnSnapshot;
  reset(): void;
}

// ─── Capability predicates (D5) — derived from the contract, single source of truth ──
// Each predicate is `voiceMessageAllowedForProfile` for the wire kind whose presence implies the
// capability. `floorControl` keys on `media.track.state` (full-realtime only); `usesManualCommit`
// is STT's "explicit review/commit gate" — transcript capture WITHOUT a live media track; user voice
// can be captured either via the WebRTC media track (full-realtime) or via gateway-batch transcripts
// (speech-to-text), which is the refinement that makes the AC2 commit-vs-detect distinction possible.
interface VoiceProfileCapabilities {
  readonly mediaAllowed: boolean;
  readonly playbackAllowed: boolean;
  readonly interruptAllowed: boolean;
  readonly transcriptAllowed: boolean;
  readonly floorControl: boolean;
  readonly usesManualCommit: boolean;
  readonly canCaptureUserVoice: boolean;
}

function capabilitiesFor(profile: VoiceProfile): VoiceProfileCapabilities {
  const mediaAllowed = voiceMessageAllowedForProfile("media.track.state", profile);
  const playbackAllowed = voiceMessageAllowedForProfile("playback.state", profile);
  const interruptAllowed = voiceMessageAllowedForProfile("control.interrupt", profile);
  const transcriptAllowed = voiceMessageAllowedForProfile("transcript.committed", profile);
  return {
    mediaAllowed,
    playbackAllowed,
    interruptAllowed,
    transcriptAllowed,
    floorControl: mediaAllowed,
    usesManualCommit: transcriptAllowed && !mediaAllowed,
    canCaptureUserVoice: mediaAllowed || transcriptAllowed,
  };
}

// Signal admission keyed by signal kind: a total table makes an unclassified signal a compile error.
// Each entry is a predicate over the derived capabilities; lifecycle signals (provider-failure,
// permission-denied, recovered, session-closed) are profile-independent and admitted whenever the
// manager is active (i.e. profile !== "none").
const SIGNAL_ADMISSION: Record<VoiceTurnSignalKind, (caps: VoiceProfileCapabilities) => boolean> = {
  "user-speech-start": (caps) => caps.canCaptureUserVoice,
  "user-end-of-turn": (caps) => caps.canCaptureUserVoice,
  "dictation-commit": (caps) => caps.usesManualCommit,
  "dictation-discard": (caps) => caps.usesManualCommit,
  "assistant-speech-start": (caps) => caps.playbackAllowed,
  "assistant-speech-end": (caps) => caps.playbackAllowed,
  "user-interrupt": (caps) => caps.interruptAllowed,
  backchannel: (caps) => caps.floorControl && caps.playbackAllowed,
  "provider-failure": () => true,
  "permission-denied": () => true,
  recovered: () => true,
  "session-closed": () => true,
};

// ─── Mutable working state ──────────────────────────────────────────────────────
// Isolated so `reset()` is a single re-initialization, mirroring the timing engine's `freshState`.
interface VoiceTurnWorkingState {
  state: VoiceTurnState;
  turnIndex: number;
  interruptions: number;
  backchannels: number;
  pendingCommit: boolean;
  lastEndOfTurnAtMs: number | undefined;
  lastInterruptAtMs: number | undefined;
  lastTransitionAtMs: number | undefined;
}

function freshState(profile: VoiceProfile): VoiceTurnWorkingState {
  return {
    state: profile === "none" ? "disabled" : "idle",
    turnIndex: 0,
    interruptions: 0,
    backchannels: 0,
    pendingCommit: false,
    lastEndOfTurnAtMs: undefined,
    lastInterruptAtMs: undefined,
    lastTransitionAtMs: undefined,
  };
}

export function createVoiceTurnManager(options: VoiceTurnManagerOptions): VoiceTurnManagerEngine {
  const { profile } = options;
  const clock = options.clock ?? createBrowserVoiceClock();
  const observer = options.observer;
  const caps = capabilitiesFor(profile);
  let state = freshState(profile);

  function snapshot(): VoiceTurnSnapshot {
    return {
      profile,
      active: state.state !== "disabled",
      state: state.state,
      floorHolder: FLOOR_HOLDER[state.state],
      turnIndex: state.turnIndex,
      interruptions: state.interruptions,
      backchannels: state.backchannels,
      pendingCommit: state.pendingCommit,
      recovering: state.state === "recovering",
      lastEndOfTurnAtMs: state.lastEndOfTurnAtMs,
      lastInterruptAtMs: state.lastInterruptAtMs,
    };
  }

  // Record a single state change and fire `onTransition` with a content-free event. `latencyMs` is the
  // clock delta since the previous transition (0 for the first). The clock is read by the caller and
  // passed in so a synthesized two-step `apply` shares one clock reading per step.
  function transitionTo(next: VoiceTurnState, trigger: VoiceTurnSignalKind, nowMs: number): void {
    const from = state.state;
    const latencyMs = state.lastTransitionAtMs === undefined ? 0 : nowMs - state.lastTransitionAtMs;
    state.state = next;
    state.lastTransitionAtMs = nowMs;
    observer?.onTransition?.({
      from,
      to: next,
      trigger,
      floorHolder: FLOOR_HOLDER[next],
      turnIndex: state.turnIndex,
      latencyMs,
    });
  }

  // Emit the effect list for a transition, firing `onEffect` per directive. The manager never executes
  // an effect; it only records and reports it.
  function emitEffects(effects: readonly VoiceTurnEffect[]): void {
    for (const effect of effects) {
      observer?.onEffect?.({ effect, state: state.state, turnIndex: state.turnIndex });
    }
  }

  // ─── Floor-bearing signal handlers (full-realtime + the speech-output / STT subsets) ───
  // Each handler returns the effects it emitted (after performing its transition + counter updates) so
  // the dispatcher can build the result. A `no-op` handler returns the empty effect list and performs
  // no transition.

  function handleUserSpeechStart(nowMs: number): readonly VoiceTurnEffect[] {
    // Overlap synthesis (Note A): barge-in while speaking is two sequential reducer steps in one
    // apply — synthesize `user-interrupt { atMs: clock.now() }` (with the AC3 preserve-user-turn
    // reinforcement) then `user-speech-start`. The observer fires twice.
    if (state.state === "speaking") {
      const effects = handleUserInterrupt(nowMs, nowMs, true);
      transitionTo("listening", "user-speech-start", nowMs);
      return effects;
    }
    if (state.state === "thinking") {
      transitionTo("listening", "user-speech-start", nowMs);
      emitEffects(["preserve-user-turn"]);
      return ["preserve-user-turn"];
    }
    if (state.state === "listening") {
      return [];
    }
    transitionTo("listening", "user-speech-start", nowMs);
    return [];
  }

  function handleUserEndOfTurn(nowMs: number): readonly VoiceTurnEffect[] {
    if (state.state !== "listening") {
      return [];
    }
    state.lastEndOfTurnAtMs = nowMs;
    if (caps.floorControl) {
      state.turnIndex += 1;
      state.pendingCommit = false;
      transitionTo("thinking", "user-end-of-turn", nowMs);
      return [];
    }
    // Speech-to-text: end-of-turn is DETECTED, not yet sent. Mark the pending-commit window and return
    // to idle without advancing `turnIndex`; the explicit `dictation-commit` advances the turn (AC2).
    state.pendingCommit = true;
    transitionTo("idle", "user-end-of-turn", nowMs);
    return [];
  }

  function handleDictationCommit(nowMs: number): readonly VoiceTurnEffect[] {
    if (!(state.state === "idle" && state.pendingCommit)) {
      return [];
    }
    state.turnIndex += 1;
    state.pendingCommit = false;
    state.lastEndOfTurnAtMs = nowMs;
    transitionTo("idle", "dictation-commit", nowMs);
    return [];
  }

  function handleDictationDiscard(nowMs: number): readonly VoiceTurnEffect[] {
    if (!(state.state === "idle" && state.pendingCommit)) {
      return [];
    }
    state.pendingCommit = false;
    transitionTo("idle", "dictation-discard", nowMs);
    return [];
  }

  function handleAssistantSpeechStart(nowMs: number): readonly VoiceTurnEffect[] {
    if (state.state === "speaking") {
      return [];
    }
    if (state.state === "thinking" || state.state === "idle" || state.state === "interrupted") {
      transitionTo("speaking", "assistant-speech-start", nowMs);
    }
    return [];
  }

  function handleAssistantSpeechEnd(
    how: "completed" | "stopped",
    nowMs: number,
  ): readonly VoiceTurnEffect[] {
    if (how === "completed") {
      if (state.state === "speaking") {
        transitionTo("yielding", "assistant-speech-end", nowMs);
      } else if (state.state === "thinking") {
        transitionTo("idle", "assistant-speech-end", nowMs);
      }
      return [];
    }
    if (state.state === "speaking") {
      transitionTo("interrupted", "assistant-speech-end", nowMs);
    } else if (state.state === "thinking") {
      transitionTo("idle", "assistant-speech-end", nowMs);
    }
    return [];
  }

  // `synthesized` carries the AC3 preserve-user-turn reinforcement that distinguishes a barge-in from a
  // standalone interrupt. `atMs` is the signal's optional offset; `nowMs` stamps the interrupt time.
  function handleUserInterrupt(
    atMs: number | undefined,
    nowMs: number,
    synthesized: boolean,
  ): readonly VoiceTurnEffect[] {
    // No floor is held by the assistant in idle / listening (user holds it) or recovering (reconnect in
    // progress, floor unoccupied), so there is nothing to interrupt — a spurious interrupt is a no-op.
    if (state.state === "idle" || state.state === "listening" || state.state === "recovering") {
      return [];
    }
    state.lastInterruptAtMs = nowMs;
    if (state.state === "yielding") {
      state.interruptions += 1;
      transitionTo("idle", "user-interrupt", nowMs);
      observer?.onInterrupt?.({ state: state.state, atMs, interruptions: state.interruptions });
      return [];
    }
    const effects = interruptEffects(synthesized);
    state.interruptions += 1;
    transitionTo("interrupted", "user-interrupt", nowMs);
    emitEffects(effects);
    observer?.onInterrupt?.({ state: state.state, atMs, interruptions: state.interruptions });
    return effects;
  }

  // The effect set for an interrupt that stops or cancels assistant speech. `speaking` (or a
  // synthesized barge-in) emits the full set including the AC3 `preserve-user-turn`; `thinking` cancels
  // in-flight generation; `interrupted` re-interrupts a not-yet-stopped provider with `stop-playback`.
  function interruptEffects(synthesized: boolean): readonly VoiceTurnEffect[] {
    if (state.state === "speaking" || synthesized) {
      return ["stop-playback", "cancel-speech-generation", "preserve-user-turn"];
    }
    if (state.state === "thinking") {
      return ["cancel-speech-generation"];
    }
    return ["stop-playback"];
  }

  // Backchannel never changes state or floor (D6): it acknowledges hearing without commitment. It is
  // admitted only for `full-realtime`, and `apply` guarantees an active state at dispatch time, so the
  // current state is always one of the active states here.
  function handleBackchannel(): readonly VoiceTurnEffect[] {
    state.backchannels += 1;
    emitEffects(["emit-backchannel"]);
    observer?.onBackchannel?.({ state: state.state, backchannels: state.backchannels });
    return ["emit-backchannel"];
  }

  function handleProviderFailure(recoverable: boolean, nowMs: number): readonly VoiceTurnEffect[] {
    if (recoverable) {
      transitionTo("recovering", "provider-failure", nowMs);
      emitEffects(["begin-recovery"]);
      return ["begin-recovery"];
    }
    transitionTo("disabled", "provider-failure", nowMs);
    return [];
  }

  function handleRecovered(nowMs: number): readonly VoiceTurnEffect[] {
    if (state.state === "recovering") {
      transitionTo("idle", "recovered", nowMs);
    }
    return [];
  }

  // Dispatch an admitted signal to its handler. The clock is read once per `apply` step and passed in.
  function dispatch(signal: VoiceTurnSignal, nowMs: number): readonly VoiceTurnEffect[] {
    switch (signal.kind) {
      case "user-speech-start":
        return handleUserSpeechStart(nowMs);
      case "user-end-of-turn":
        return handleUserEndOfTurn(nowMs);
      case "dictation-commit":
        return handleDictationCommit(nowMs);
      case "dictation-discard":
        return handleDictationDiscard(nowMs);
      case "assistant-speech-start":
        return handleAssistantSpeechStart(nowMs);
      case "assistant-speech-end":
        return handleAssistantSpeechEnd(signal.how, nowMs);
      case "user-interrupt":
        return handleUserInterrupt(signal.atMs, nowMs, false);
      case "backchannel":
        return handleBackchannel();
      case "provider-failure":
        return handleProviderFailure(signal.recoverable, nowMs);
      case "permission-denied":
        transitionTo("disabled", "permission-denied", nowMs);
        return [];
      case "recovered":
        return handleRecovered(nowMs);
      case "session-closed":
        transitionTo("disabled", "session-closed", nowMs);
        return [];
    }
  }

  function apply(signal: VoiceTurnSignal): VoiceTurnApplyResult {
    // Dormant (`none`) profile and any already-`disabled` manager short-circuit before any clock read
    // or observer call (AC1): a dormant manager is content-free and silent.
    if (profile === "none" || state.state === "disabled") {
      return { outcome: "not-allowed-for-profile", effects: [], snapshot: snapshot() };
    }
    if (!SIGNAL_ADMISSION[signal.kind](caps)) {
      return { outcome: "not-allowed-for-profile", effects: [], snapshot: snapshot() };
    }
    const stateBefore = state.state;
    const turnBefore = state.turnIndex;
    const pendingBefore = state.pendingCommit;
    const nowMs = clock.now();
    const effects = dispatch(signal, nowMs);
    const changed =
      state.state !== stateBefore ||
      state.turnIndex !== turnBefore ||
      state.pendingCommit !== pendingBefore ||
      effects.length > 0;
    return {
      outcome: changed ? "transitioned" : "no-op",
      effects,
      snapshot: snapshot(),
    };
  }

  function reset(): void {
    state = freshState(profile);
  }

  return { apply, snapshot, reset };
}
