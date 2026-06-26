// Issue #501, Epic #491 (ADR-0064) — the assistant speech-output playback controller. It is the
// deterministic, content-free reducer that drives the OPTIONAL spoken assistant response through the
// eight-phase lifecycle defined by the contract (`voice-playback.ts`): unavailable, preparing, speaking,
// paused, interrupted, canceled, failed, complete. It owns NO transport, NO clock, NO audio: time enters
// through the injectable `VoiceClock` seam reused from `voice-timebase.ts` (the convention ADR-0061
// established), audio is realised by the existing Model Gateway egress + WebRTC media plane seams
// (#496/#497) which this module only ever *names* through content-free effects, and every command arrives
// already mapped from a provider control message or a local UI control by the consuming hook.
//
// Capability gating is delegated wholesale to the contract's `voicePlaybackAllowedForProfile` /
// `voicePlaybackInterruptAllowedForProfile` (AC1): `none` and `speech-to-text` permit no playback, so the
// controller is dormant in `unavailable` and rejects every command — which is exactly why the currently
// deployed STT-only capability renders no playback affordance and Keiko answers in text (AC1). Only
// `speech-output` and `full-realtime` arm the lifecycle.
//
// Load-bearing for AC2 ("assistant speech can be interrupted and the turn manager receives the state
// change"): an `interrupt` command stops output and emits the `notify-turn-interrupt` effect, which the
// consuming hook forwards to the #499 turn manager via `forwardVoicePlaybackToTurnManager`, so the turn
// manager transitions to `interrupted` and counts the barge-in. Load-bearing for AC3/AC4: the controller
// never holds, logs, persists, or passes a raw audio buffer, transcript, credential, SDP, or URL — only
// derived, content-free enum literals, integers, and millisecond deltas leave it. The effect vocabulary
// is media-and-turn-notification only by construction: no effect grants workflow authority, triggers a
// model call, or writes to any store.

import {
  type VoicePlaybackEffect,
  type VoicePlaybackFailureKind,
  type VoicePlaybackPhase,
  type VoicePlaybackState,
  initialVoicePlaybackPhase,
  isActiveVoicePlaybackPhase,
  isSettledVoicePlaybackPhase,
  mapVoicePlaybackPhaseToWireState,
  voicePlaybackAllowedForProfile,
  voicePlaybackInterruptAllowedForProfile,
} from "@oscharko-dev/keiko-contracts";
import type { VoiceProfile } from "@/lib/types";
import { type VoiceClock, createBrowserVoiceClock } from "./voice-timebase";
import type { VoiceTurnManagerEngine, VoiceTurnSignal } from "./voice-turn-manager";

// Re-export the clock seam so consumers construct the controller from the same primitive as the timing
// engine and turn manager without importing a third sibling module. The contract's playback vocabulary
// types are re-exported too, so a consumer reaches the whole playback surface from this one module.
export { createBrowserVoiceClock };
export type { VoiceClock };
export type {
  VoicePlaybackPhase,
  VoicePlaybackFailureKind,
  VoicePlaybackEffect,
} from "@oscharko-dev/keiko-contracts";

// ─── Command union (Deliverable: interrupt / stop / mute / text-fallback behavior) ──
// A semantic command union the caller maps from provider control messages (prepare / play-started /
// complete / fail) and local UI controls (pause / resume / interrupt / stop / replay / set-muted). This
// decouples the reducer from the wire encoding, exactly as the #499 turn manager's signal union does.
export type VoicePlaybackCommand =
  | { readonly kind: "prepare" }
  | { readonly kind: "play-started" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "interrupt"; readonly atMs?: number | undefined }
  | { readonly kind: "stop" }
  | { readonly kind: "fail"; readonly failure: VoicePlaybackFailureKind }
  | { readonly kind: "complete" }
  | { readonly kind: "replay" }
  | { readonly kind: "set-muted"; readonly muted: boolean };

export type VoicePlaybackCommandKind = VoicePlaybackCommand["kind"];

// ─── Apply outcome (mirrors the turn manager) ───────────────────────────────────
// `transitioned` — the command changed phase, counters, or the mute flag, and/or emitted effects;
// `no-op` — valid for the profile but with no meaningful effect in the current phase; `not-allowed-for-
// profile` — rejected by the capability gate (the only outcome a dormant controller ever produces).
export type VoicePlaybackApplyOutcome = "transitioned" | "no-op" | "not-allowed-for-profile";

// ─── Read-only snapshot ─────────────────────────────────────────────────────────
export interface VoicePlaybackSnapshot {
  readonly profile: VoiceProfile;
  readonly available: boolean;
  readonly phase: VoicePlaybackPhase;
  readonly active: boolean;
  readonly settled: boolean;
  readonly speaking: boolean;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly replayAllowed: boolean;
  // Whether the current turn ever produced audible output (reached `speaking`). Reset when a new turn is
  // armed. Lets a consumer distinguish a silent turn from one that spoke without inspecting any audio.
  readonly spoke: boolean;
  readonly interruptions: number;
  readonly replays: number;
  readonly wireState: VoicePlaybackState | undefined;
  readonly failureKind: VoicePlaybackFailureKind | undefined;
  // The client-perceived media offset (ms) of the most recent interrupt, carried verbatim from the
  // command so it can be forwarded to the turn manager. Content-free integer.
  readonly lastInterruptAtMs: number | undefined;
}

export interface VoicePlaybackApplyResult {
  readonly outcome: VoicePlaybackApplyOutcome;
  readonly effects: readonly VoicePlaybackEffect[];
  readonly snapshot: VoicePlaybackSnapshot;
}

// ─── Content-free observer (AC3/AC4) — every field enum / integer / ms ───────────
export interface VoicePlaybackTransitionEvent {
  readonly from: VoicePlaybackPhase;
  readonly to: VoicePlaybackPhase;
  readonly trigger: VoicePlaybackCommandKind;
  readonly wireState: VoicePlaybackState | undefined;
  readonly latencyMs: number;
}

export interface VoicePlaybackInterruptEvent {
  readonly phase: VoicePlaybackPhase;
  readonly atMs: number | undefined;
  readonly interruptions: number;
}

export interface VoicePlaybackEffectEvent {
  readonly effect: VoicePlaybackEffect;
  readonly phase: VoicePlaybackPhase;
}

export interface VoicePlaybackObserver {
  onTransition?(event: VoicePlaybackTransitionEvent): void;
  onInterrupt?(event: VoicePlaybackInterruptEvent): void;
  onEffect?(event: VoicePlaybackEffectEvent): void;
}

// ─── Construction ───────────────────────────────────────────────────────────────
export interface VoicePlaybackControllerOptions {
  readonly profile: VoiceProfile;
  // "replay if permitted": replay is a policy-gated affordance, off by default. When false, a `replay`
  // command is rejected (`not-allowed-for-profile`) even for a playback-capable profile.
  readonly replayAllowed?: boolean | undefined;
  readonly clock?: VoiceClock | undefined;
  readonly observer?: VoicePlaybackObserver | undefined;
}

export interface VoicePlaybackController {
  dispatch(command: VoicePlaybackCommand): VoicePlaybackApplyResult;
  snapshot(): VoicePlaybackSnapshot;
  reset(): void;
}

// Command admission keyed by command kind: a total table makes an unclassified command a compile error.
// Each entry is a predicate over the derived capabilities. `set-muted` and the lifecycle commands require
// playback capability; `interrupt` requires interrupt capability; `replay` additionally requires the
// replay-permitted policy flag.
interface VoicePlaybackCapabilities {
  readonly playbackAllowed: boolean;
  readonly interruptAllowed: boolean;
  readonly replayAllowed: boolean;
}

const COMMAND_ADMISSION: Record<
  VoicePlaybackCommandKind,
  (caps: VoicePlaybackCapabilities) => boolean
> = {
  prepare: (caps) => caps.playbackAllowed,
  "play-started": (caps) => caps.playbackAllowed,
  pause: (caps) => caps.playbackAllowed,
  resume: (caps) => caps.playbackAllowed,
  interrupt: (caps) => caps.interruptAllowed,
  stop: (caps) => caps.playbackAllowed,
  fail: (caps) => caps.playbackAllowed,
  complete: (caps) => caps.playbackAllowed,
  replay: (caps) => caps.playbackAllowed && caps.replayAllowed,
  "set-muted": (caps) => caps.playbackAllowed,
};

interface VoicePlaybackWorkingState {
  phase: VoicePlaybackPhase;
  muted: boolean;
  spoke: boolean;
  interruptions: number;
  replays: number;
  failureKind: VoicePlaybackFailureKind | undefined;
  lastInterruptAtMs: number | undefined;
  lastTransitionAtMs: number | undefined;
}

function freshState(profile: VoiceProfile): VoicePlaybackWorkingState {
  return {
    phase: initialVoicePlaybackPhase(profile),
    muted: false,
    spoke: false,
    interruptions: 0,
    replays: 0,
    failureKind: undefined,
    lastInterruptAtMs: undefined,
    lastTransitionAtMs: undefined,
  };
}

export function createVoicePlaybackController(
  options: VoicePlaybackControllerOptions,
): VoicePlaybackController {
  const { profile } = options;
  const clock = options.clock ?? createBrowserVoiceClock();
  const observer = options.observer;
  const caps: VoicePlaybackCapabilities = {
    playbackAllowed: voicePlaybackAllowedForProfile(profile),
    interruptAllowed: voicePlaybackInterruptAllowedForProfile(profile),
    replayAllowed: options.replayAllowed === true,
  };
  let state = freshState(profile);

  function snapshot(): VoicePlaybackSnapshot {
    return {
      profile,
      available: caps.playbackAllowed,
      phase: state.phase,
      active: isActiveVoicePlaybackPhase(state.phase),
      settled: isSettledVoicePlaybackPhase(state.phase),
      speaking: state.phase === "speaking",
      paused: state.phase === "paused",
      muted: state.muted,
      replayAllowed: caps.replayAllowed,
      spoke: state.spoke,
      interruptions: state.interruptions,
      replays: state.replays,
      wireState: mapVoicePlaybackPhaseToWireState(state.phase),
      failureKind: state.failureKind,
      lastInterruptAtMs: state.lastInterruptAtMs,
    };
  }

  // Record a single phase change and fire `onTransition` with a content-free event. `latencyMs` is the
  // clock delta since the previous transition (0 for the first), mirroring the turn manager.
  function transitionTo(
    next: VoicePlaybackPhase,
    trigger: VoicePlaybackCommandKind,
    nowMs: number,
  ): void {
    const from = state.phase;
    const latencyMs = state.lastTransitionAtMs === undefined ? 0 : nowMs - state.lastTransitionAtMs;
    state.phase = next;
    state.lastTransitionAtMs = nowMs;
    observer?.onTransition?.({
      from,
      to: next,
      trigger,
      wireState: mapVoicePlaybackPhaseToWireState(next),
      latencyMs,
    });
  }

  function emitEffects(effects: readonly VoicePlaybackEffect[]): void {
    for (const effect of effects) {
      observer?.onEffect?.({ effect, phase: state.phase });
    }
  }

  // ─── Per-command handlers. Each returns the effects it emitted after performing its transition and
  // counter updates. A no-op handler returns the empty effect list and performs no transition. ───

  function handlePrepare(nowMs: number): readonly VoicePlaybackEffect[] {
    // Arm a fresh turn from the dormant or any settled phase; clear per-turn counters that describe the
    // previous turn. A prepare while already active (preparing/speaking/paused) is a no-op.
    if (state.phase === "unavailable" || isSettledVoicePlaybackPhase(state.phase)) {
      state.spoke = false;
      state.failureKind = undefined;
      transitionTo("preparing", "prepare", nowMs);
      emitEffects(["request-synthesis"]);
      return ["request-synthesis"];
    }
    return [];
  }

  function handlePlayStarted(nowMs: number): readonly VoicePlaybackEffect[] {
    if (state.phase !== "preparing") {
      return [];
    }
    state.spoke = true;
    transitionTo("speaking", "play-started", nowMs);
    const effects: readonly VoicePlaybackEffect[] = ["start-output", "notify-turn-speech-start"];
    emitEffects(effects);
    return effects;
  }

  function handlePause(nowMs: number): readonly VoicePlaybackEffect[] {
    if (state.phase !== "speaking") {
      return [];
    }
    transitionTo("paused", "pause", nowMs);
    emitEffects(["pause-output"]);
    return ["pause-output"];
  }

  function handleResume(nowMs: number): readonly VoicePlaybackEffect[] {
    if (state.phase !== "paused") {
      return [];
    }
    transitionTo("speaking", "resume", nowMs);
    emitEffects(["resume-output"]);
    return ["resume-output"];
  }

  function handleInterrupt(
    atMs: number | undefined,
    nowMs: number,
  ): readonly VoicePlaybackEffect[] {
    // A barge-in only interrupts audio that is live or paused; interrupting when nothing is playing is a
    // no-op (there is no floor to take). AC2: emit `notify-turn-interrupt` so the turn manager receives
    // the state change, and stop the output.
    if (state.phase !== "speaking" && state.phase !== "paused") {
      return [];
    }
    // Defense in depth: `atMs` is a content-free media offset, but a buggy caller could pass a non-finite
    // number. Normalise it to `undefined` so neither the observer nor the forwarded turn-manager signal
    // ever carries NaN/Infinity.
    const safeAtMs = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : undefined;
    state.interruptions += 1;
    state.lastInterruptAtMs = safeAtMs;
    transitionTo("interrupted", "interrupt", nowMs);
    const effects: readonly VoicePlaybackEffect[] = ["stop-output", "notify-turn-interrupt"];
    emitEffects(effects);
    observer?.onInterrupt?.({
      phase: state.phase,
      atMs: safeAtMs,
      interruptions: state.interruptions,
    });
    return effects;
  }

  function handleStop(nowMs: number): readonly VoicePlaybackEffect[] {
    if (!isActiveVoicePlaybackPhase(state.phase)) {
      return [];
    }
    transitionTo("canceled", "stop", nowMs);
    const effects: readonly VoicePlaybackEffect[] = ["stop-output", "notify-turn-speech-stopped"];
    emitEffects(effects);
    return effects;
  }

  function handleFail(
    failure: VoicePlaybackFailureKind,
    nowMs: number,
  ): readonly VoicePlaybackEffect[] {
    // The provider can fail only before or during audible output; a settled or dormant phase ignores it.
    // `paused` is intentionally excluded (the contract table has no `paused → failed` edge): a paused
    // utterance is locally buffered, so the user resolves it with stop/resume/interrupt rather than the
    // controller fabricating a failure transition the table forbids.
    if (state.phase !== "preparing" && state.phase !== "speaking") {
      return [];
    }
    state.failureKind = failure;
    transitionTo("failed", "fail", nowMs);
    const effects: readonly VoicePlaybackEffect[] = ["stop-output", "notify-turn-speech-stopped"];
    emitEffects(effects);
    return effects;
  }

  function handleComplete(nowMs: number): readonly VoicePlaybackEffect[] {
    if (!isActiveVoicePlaybackPhase(state.phase)) {
      return [];
    }
    transitionTo("complete", "complete", nowMs);
    emitEffects(["notify-turn-speech-completed"]);
    return ["notify-turn-speech-completed"];
  }

  function handleReplay(nowMs: number): readonly VoicePlaybackEffect[] {
    // Replay re-arms a settled turn (admission already required the replay-permitted policy flag).
    if (!isSettledVoicePlaybackPhase(state.phase)) {
      return [];
    }
    state.replays += 1;
    state.spoke = false;
    state.failureKind = undefined;
    transitionTo("preparing", "replay", nowMs);
    emitEffects(["request-synthesis"]);
    return ["request-synthesis"];
  }

  function handleSetMuted(muted: boolean): readonly VoicePlaybackEffect[] {
    // Mute is orthogonal to the phase: it silences output without a transition. Only a CHANGE emits an
    // effect, so a redundant set is a no-op.
    if (state.muted === muted) {
      return [];
    }
    state.muted = muted;
    const effect: VoicePlaybackEffect = muted ? "mute-output" : "unmute-output";
    emitEffects([effect]);
    return [effect];
  }

  function dispatchCommand(
    command: VoicePlaybackCommand,
    nowMs: number,
  ): readonly VoicePlaybackEffect[] {
    switch (command.kind) {
      case "prepare":
        return handlePrepare(nowMs);
      case "play-started":
        return handlePlayStarted(nowMs);
      case "pause":
        return handlePause(nowMs);
      case "resume":
        return handleResume(nowMs);
      case "interrupt":
        return handleInterrupt(command.atMs, nowMs);
      case "stop":
        return handleStop(nowMs);
      case "fail":
        return handleFail(command.failure, nowMs);
      case "complete":
        return handleComplete(nowMs);
      case "replay":
        return handleReplay(nowMs);
      case "set-muted":
        return handleSetMuted(command.muted);
    }
  }

  function dispatch(command: VoicePlaybackCommand): VoicePlaybackApplyResult {
    // A profile without playback capability is dormant: every command is rejected before any clock read
    // or observer call, so a no-capability deployment is content-free and silent (AC1).
    if (!caps.playbackAllowed || !COMMAND_ADMISSION[command.kind](caps)) {
      return { outcome: "not-allowed-for-profile", effects: [], snapshot: snapshot() };
    }
    const phaseBefore = state.phase;
    const mutedBefore = state.muted;
    const nowMs = clock.now();
    const effects = dispatchCommand(command, nowMs);
    const changed =
      state.phase !== phaseBefore || state.muted !== mutedBefore || effects.length > 0;
    return {
      outcome: changed ? "transitioned" : "no-op",
      effects,
      snapshot: snapshot(),
    };
  }

  function reset(): void {
    state = freshState(profile);
  }

  return { dispatch, snapshot, reset };
}

// ─── AC2 integration: playback effect → turn-manager signal ─────────────────────
// The pure mapping from a content-free playback effect to the #499 turn manager signal it should drive.
// Media effects (`start-output`, `stop-output`, mute, …) map to `undefined`: they belong to the media
// layer, not the turn manager. The `notify-turn-*` effects map onto the turn manager's signal set so the
// turn manager receives the assistant-speech and interruption state changes (AC2). `atMs` is the optional
// barge-in media offset carried from the interrupt command.
export function voicePlaybackEffectToTurnSignal(
  effect: VoicePlaybackEffect,
  atMs?: number | undefined,
): VoiceTurnSignal | undefined {
  switch (effect) {
    case "notify-turn-speech-start":
      return { kind: "assistant-speech-start" };
    case "notify-turn-speech-completed":
      return { kind: "assistant-speech-end", how: "completed" };
    case "notify-turn-speech-stopped":
      return { kind: "assistant-speech-end", how: "stopped" };
    case "notify-turn-interrupt":
      return { kind: "user-interrupt", atMs };
    default:
      return undefined;
  }
}

// Forward the turn-relevant effects of a playback apply result to the turn manager, so "the turn manager
// receives the state change" (AC2) is a single deterministic call the consuming hook makes after every
// dispatch. The interrupt's media offset is taken from the snapshot, which carries the command's `atMs`.
export function forwardVoicePlaybackToTurnManager(
  result: VoicePlaybackApplyResult,
  turnManager: VoiceTurnManagerEngine,
): void {
  for (const effect of result.effects) {
    const signal = voicePlaybackEffectToTurnSignal(effect, result.snapshot.lastInterruptAtMs);
    if (signal !== undefined) {
      turnManager.apply(signal);
    }
  }
}
