// Public type contract for the optional Voice Digital Twin assistant speech-output playback lifecycle
// (Epic #491, Issue #501, ADR-0064). This module DEFINES the provider-neutral semantics that let Keiko
// render and control an *optional* spoken assistant response — preparing, speaking, pausing, resuming,
// interrupting (barge-in), stopping, failing, and completing — WITHOUT deploying any new text-to-speech
// model and WITHOUT making speech a precondition for using Keiko. It is pure data + pure functions only:
// nothing performs IO, crypto, clock reads, randomness, or audio processing, and no provider base URL,
// credential, or raw audio buffer is ever a field on these types. The playback STATE is content-free by
// construction — raw assistant audio is media-plane only (`VOICE_MEDIA_PLANE`, `never-persisted`,
// `raw-media`) and is never a field here (AC3/AC4).
//
// It is layered ABOVE the #496 wire protocol (voice-protocol.ts): the wire carries five coarse playback
// states (`idle`, `playing`, `paused`, `stopped`, `interrupted`) on the single `playback.state` control
// message, whereas the lifecycle here has eight PHASES that additionally distinguish "not available for
// this turn" (`unavailable`), provider preparation (`preparing`), provider failure (`failed`), and a
// natural end (`complete`). Only the phases that have a wire counterpart project onto the wire
// (`mapVoicePlaybackPhaseToWireState`); `unavailable`, `preparing`, `failed`, and `complete` are derived
// or local phases, exactly as the #500 transcript lifecycle and the #499 turn manager map a richer
// semantic set onto the same coarse wire catalog (ADR-0062, ADR-0063). The stateful reducer that drives
// these phases lives in keiko-ui (`voice-playback-state.ts`) as a synchronous deterministic engine; this
// leaf contract holds the phase catalog, the classification tables, the legal-transition table, the
// capability-gating predicates, the effect vocabulary, the validators, and the content-free turn summary
// so later voice consumers (#502 discussion intelligence, #504 recap / memory review) can read playback
// outcomes without forking the reducer.
//
// `VOICE_PLAYBACK_SCHEMA_VERSION` follows the same evolution rule as `VOICE_PROTOCOL_VERSION` /
// `VOICE_TRANSCRIPT_SCHEMA_VERSION`: a breaking change introduces a NEW literal rather than mutating "1".
// It is INDEPENDENT of the wire `VOICE_PROTOCOL_VERSION` and of `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports may appear here; sibling
// types are reached by relative path.

import type { VoiceProfile } from "./gateway.js";
import type {
  VoicePlaybackState,
  VoiceReplayClass,
  VoiceRedactionClass,
} from "./voice-protocol.js";
import { VOICE_MEDIA_PLANE, voiceMessageAllowedForProfile } from "./voice-protocol.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const VOICE_PLAYBACK_SCHEMA_VERSION = "1" as const;

export function isVoicePlaybackSchemaVersionSupported(version: unknown): boolean {
  return version === VOICE_PLAYBACK_SCHEMA_VERSION;
}

// ─── Playback phases (Deliverable: playback state machine) ───────────────────────
// `unavailable` — no spoken assistant output is active or pending for the current assistant turn. This
//                 is BOTH the permanent resting phase of a deployment without speech-output capability
//                 (AC1: the UI renders text only and no playback control) AND the disarmed resting phase
//                 of a capable deployment between turns. The capability gate, not the phase, is what
//                 distinguishes "never available" from "available but idle".
// `preparing`   — the configured speech-output provider is synthesising / buffering this turn's audio;
//                 nothing is audible yet.
// `speaking`    — assistant audio is playing.
// `paused`      — the user paused playback; audio is retained for the live turn only, never persisted.
// `interrupted` — a user barge-in stopped playback mid-utterance. The turn manager receives this state
//                 change (AC2); it is the load-bearing interruptible-speech phase.
// `canceled`    — the user stopped playback before it finished naturally.
// `failed`      — the provider failed to produce or continue audio for this turn (AC: provider-failure
//                 case). Keiko remains fully usable in text.
// `complete`    — playback finished naturally.
export type VoicePlaybackPhase =
  | "unavailable"
  | "preparing"
  | "speaking"
  | "paused"
  | "interrupted"
  | "canceled"
  | "failed"
  | "complete";

export const VOICE_PLAYBACK_PHASES: readonly VoicePlaybackPhase[] = [
  "unavailable",
  "preparing",
  "speaking",
  "paused",
  "interrupted",
  "canceled",
  "failed",
  "complete",
] as const;

// The phases in which audio is live or imminent. While active, the user-facing controls (pause / resume
// / stop / interrupt / mute) are meaningful; outside them the surface offers only replay-if-permitted
// and the always-present text fallback.
export const VOICE_PLAYBACK_ACTIVE_PHASES: readonly VoicePlaybackPhase[] = [
  "preparing",
  "speaking",
  "paused",
] as const;

// The terminal lifecycle facts of a single assistant turn's playback. These are the durable, content-free
// outcomes a turn summary, recap (#504), or discussion-intelligence pass (#502) may read.
export const VOICE_PLAYBACK_SETTLED_PHASES: readonly VoicePlaybackPhase[] = [
  "interrupted",
  "canceled",
  "failed",
  "complete",
] as const;

// ─── Provider failure taxonomy (AC: provider-failure case) ──────────────────────
// Provider-neutral failure kinds, defined independently here (leaf rule forbids importing the Model
// Gateway / BFF taxonomy) but aligned by value with the #494 BFF speech error codes and the #500
// transcript provider-error kinds so a server adapter maps `rate-limited` / `timeout` / `provider-error`
// / `unavailable` onto these without a lossy round-trip.
export type VoicePlaybackFailureKind =
  | "rate-limited"
  | "timeout"
  | "provider-error"
  | "unavailable"
  | "internal";

export const VOICE_PLAYBACK_FAILURE_KINDS: readonly VoicePlaybackFailureKind[] = [
  "rate-limited",
  "timeout",
  "provider-error",
  "unavailable",
  "internal",
] as const;

// ─── Per-phase classification tables (aligned to voice-protocol.ts) ─────────────
// Keyed by `VoicePlaybackPhase` so adding a phase without classifying it is a compile error (totality).
//
// Replay (AC5 reconnect semantics): the durable, settled lifecycle facts (`interrupted`, `canceled`,
// `failed`, `complete`) are `replayable` — a reconnect re-delivers that the assistant turn ended a
// certain way so turn accounting and recap stay consistent. The in-flight phases (`preparing`,
// `speaking`, `paused`) are `ephemeral`: a reconnect never re-delivers them and never re-plays the
// audio, mirroring `transcript.partial`. `unavailable` is `ephemeral` (dormant, never a durable fact).
export const VOICE_PLAYBACK_PHASE_REPLAY: Record<VoicePlaybackPhase, VoiceReplayClass> = {
  unavailable: "ephemeral",
  preparing: "ephemeral",
  speaking: "ephemeral",
  paused: "ephemeral",
  interrupted: "replayable",
  canceled: "replayable",
  failed: "replayable",
  complete: "replayable",
} as const;

// Redaction: EVERY playback phase is `content-free`. A playback phase is an enum literal describing
// control state; it never carries reviewable text, secret-bearing signaling, or raw audio. Raw assistant
// audio is media-plane only (`VOICE_MEDIA_PLANE`: `never-persisted`, `raw-media`) and is never a field on
// any type in this module. This table is the AC3/AC4 invariant expressed as data: no playback phase is
// ever anything but `content-free`, so a playback record can never become a channel for audio or
// credentials.
export const VOICE_PLAYBACK_PHASE_REDACTION: Record<VoicePlaybackPhase, VoiceRedactionClass> = {
  unavailable: "content-free",
  preparing: "content-free",
  speaking: "content-free",
  paused: "content-free",
  interrupted: "content-free",
  canceled: "content-free",
  failed: "content-free",
  complete: "content-free",
} as const;

// The media-plane descriptor that governs the raw assistant audio this lifecycle controls. Re-exported
// from the #496 protocol so the playback contract and the wire agree that audio is never-persisted,
// raw-media, media-plane only — the typed expression of AC4 ("raw assistant audio is not stored by
// default"). It is intentionally the SAME object the protocol pins; this module adds no new audio path.
export const VOICE_PLAYBACK_AUDIO_PLANE = VOICE_MEDIA_PLANE;

// ─── Legal transition table (Deliverable: reducer / state-machine rules) ────────
// The set of phases reachable from a given phase by a state-CHANGING transition. Mute is intentionally
// ABSENT: muting silences output without changing the phase (it is an orthogonal boolean), exactly as a
// backchannel never changes the turn manager's state. Keyed by phase for totality.
//
// `unavailable` → `preparing` arms a new turn; the capability gate (`voicePlaybackAllowedForProfile`)
// rejects that transition for a profile without speech output, so a no-capability deployment is pinned in
// `unavailable` permanently (AC1). Every settled phase can be re-armed to `preparing` (a fresh turn or a
// permitted replay). `preparing` may reach `complete` directly for an empty / instantly-finished
// utterance. `interrupted` / `canceled` / `failed` / `complete` are otherwise terminal for the turn.
export const VOICE_PLAYBACK_TRANSITIONS: Record<VoicePlaybackPhase, readonly VoicePlaybackPhase[]> =
  {
    unavailable: ["preparing"],
    preparing: ["speaking", "complete", "canceled", "failed"],
    speaking: ["paused", "interrupted", "canceled", "failed", "complete"],
    paused: ["speaking", "interrupted", "canceled", "complete"],
    interrupted: ["preparing"],
    canceled: ["preparing"],
    failed: ["preparing"],
    complete: ["preparing"],
  } as const;

// ─── Type guards & lookups ───────────────────────────────────────────────────────
export function isVoicePlaybackPhase(value: unknown): value is VoicePlaybackPhase {
  return typeof value === "string" && (VOICE_PLAYBACK_PHASES as readonly string[]).includes(value);
}

export function isVoicePlaybackFailureKind(value: unknown): value is VoicePlaybackFailureKind {
  return (
    typeof value === "string" && (VOICE_PLAYBACK_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

export function voicePlaybackPhaseReplayClass(phase: VoicePlaybackPhase): VoiceReplayClass {
  return VOICE_PLAYBACK_PHASE_REPLAY[phase];
}

export function voicePlaybackPhaseRedactionClass(phase: VoicePlaybackPhase): VoiceRedactionClass {
  return VOICE_PLAYBACK_PHASE_REDACTION[phase];
}

// Whether audio is live or imminent in this phase (the user-facing transport controls are meaningful).
export function isActiveVoicePlaybackPhase(phase: VoicePlaybackPhase): boolean {
  return (VOICE_PLAYBACK_ACTIVE_PHASES as readonly string[]).includes(phase);
}

// Whether this phase is a terminal lifecycle fact of the turn's playback (AC5 / recap consumption).
export function isSettledVoicePlaybackPhase(phase: VoicePlaybackPhase): boolean {
  return (VOICE_PLAYBACK_SETTLED_PHASES as readonly string[]).includes(phase);
}

// Whether `to` is reachable from `from` by a legal state-changing transition.
export function canTransitionVoicePlayback(
  from: VoicePlaybackPhase,
  to: VoicePlaybackPhase,
): boolean {
  return VOICE_PLAYBACK_TRANSITIONS[from].includes(to);
}

// Exhaustiveness guard: a `default` / fall-through that reaches this fails to type-check if a new
// `VoicePlaybackPhase` is added without handling, mirroring `assertNeverVoiceTranscriptSegmentState`.
export function assertNeverVoicePlaybackPhase(phase: never): never {
  throw new Error(`unhandled voice playback phase: ${JSON.stringify(phase)}`);
}

// ─── Phase ↔ wire-state mapping ──────────────────────────────────────────────────
// The coarse wire `VoicePlaybackState` (`playback.state`, voice-protocol.ts) a phase projects onto.
// `unavailable` has no wire state (dormant — there is nothing to report on the wire) and returns
// `undefined`. `preparing` and `complete` both map to `idle` (nothing audible); `canceled` and `failed`
// both map to `stopped` (playback halted). A strict 1:1 phase↔wire map is impossible by design — the
// same lesson the #499 turn manager and #500 transcript lifecycle record.
export function mapVoicePlaybackPhaseToWireState(
  phase: VoicePlaybackPhase,
): VoicePlaybackState | undefined {
  switch (phase) {
    case "unavailable":
      return undefined;
    case "preparing":
      return "idle";
    case "speaking":
      return "playing";
    case "paused":
      return "paused";
    case "interrupted":
      return "interrupted";
    case "canceled":
      return "stopped";
    case "failed":
      return "stopped";
    case "complete":
      return "idle";
    default:
      return assertNeverVoicePlaybackPhase(phase);
  }
}

// ─── Effect vocabulary (Deliverable: interrupt / stop / mute / text-fallback) ────
// Content-free directives the keiko-ui reducer EMITS but never executes. The vocabulary is media-floor
// and turn-notification only: no effect grants workflow authority, triggers a model call, commits a
// workspace patch, or writes to any store. `request-synthesis` / `start-output` / `stop-output` etc.
// are realised by the existing Model Gateway egress + media plane seams (#496/#497), never a new path.
// `notify-turn-*` are the AC2 integration: the consuming hook maps them onto the #499 turn manager's
// signal set so the turn manager receives the assistant-speech and interruption state changes.
export type VoicePlaybackEffect =
  | "request-synthesis"
  | "start-output"
  | "pause-output"
  | "resume-output"
  | "stop-output"
  | "mute-output"
  | "unmute-output"
  | "notify-turn-speech-start"
  | "notify-turn-speech-completed"
  | "notify-turn-speech-stopped"
  | "notify-turn-interrupt";

export const VOICE_PLAYBACK_EFFECTS: readonly VoicePlaybackEffect[] = [
  "request-synthesis",
  "start-output",
  "pause-output",
  "resume-output",
  "stop-output",
  "mute-output",
  "unmute-output",
  "notify-turn-speech-start",
  "notify-turn-speech-completed",
  "notify-turn-speech-stopped",
  "notify-turn-interrupt",
] as const;

export function isVoicePlaybackEffect(value: unknown): value is VoicePlaybackEffect {
  return typeof value === "string" && (VOICE_PLAYBACK_EFFECTS as readonly string[]).includes(value);
}

// ─── Capability-gating predicates (AC1/AC2) — derived from the contract ─────────
// The single source of truth for capability gating is `voiceMessageAllowedForProfile`; these predicates
// derive the playback-relevant capabilities from it rather than re-encoding the profile table. A profile
// permits assistant speech output exactly when it permits the `playback.state` control message, and
// permits interruption (barge-in) exactly when it permits `control.interrupt`. By the #496 profile table
// `none` and `speech-to-text` permit neither (playback is dormant / `unavailable`), while `speech-output`
// and `full-realtime` permit both. This is why "the current known deployed voice capability is STT-only"
// renders no playback affordance (AC1) without any special case here.
export function voicePlaybackAllowedForProfile(profile: VoiceProfile): boolean {
  return voiceMessageAllowedForProfile("playback.state", profile);
}

export function voicePlaybackInterruptAllowedForProfile(profile: VoiceProfile): boolean {
  return voiceMessageAllowedForProfile("control.interrupt", profile);
}

// The phase a freshly constructed controller starts in for a profile: `unavailable` always, because no
// turn has produced audio yet. For a non-capable profile this is also the permanent phase (the gate
// rejects every arming transition); for a capable profile it is the disarmed resting phase from which a
// new turn arms `preparing`.
export function initialVoicePlaybackPhase(_profile: VoiceProfile): VoicePlaybackPhase {
  return "unavailable";
}

// ─── Content-free turn summary (Deliverable: integration boundary for #502/#504) ──
// A content-free roll-up of a single assistant turn's playback that recap / discussion intelligence may
// consume: the terminal phase, whether it completed without interruption, and counts only — never any
// audio, text, credential, or provider detail. This is the only playback representation that may enter an
// evidence manifest, and it does so without passing through the redact-at-persist seam because it is
// content-free by construction.
export interface VoicePlaybackTurnSummary {
  readonly schemaVersion: typeof VOICE_PLAYBACK_SCHEMA_VERSION;
  readonly phase: VoicePlaybackPhase;
  readonly available: boolean;
  readonly spoke: boolean;
  readonly completed: boolean;
  readonly interrupted: boolean;
  readonly failed: boolean;
  readonly interruptions: number;
  readonly replays: number;
  readonly failureKind?: VoicePlaybackFailureKind | undefined;
}

// Build the content-free summary for a turn from its final phase and content-free counters. `spoke` is
// true once the turn ever produced audible output (it reached at least `speaking`), which the caller
// tracks; `completed` / `interrupted` / `failed` are derived from the terminal phase so they cannot
// disagree with it.
export function summarizeVoicePlaybackTurn(input: {
  readonly phase: VoicePlaybackPhase;
  readonly available: boolean;
  readonly spoke: boolean;
  readonly interruptions: number;
  readonly replays: number;
  readonly failureKind?: VoicePlaybackFailureKind | undefined;
}): VoicePlaybackTurnSummary {
  return {
    schemaVersion: VOICE_PLAYBACK_SCHEMA_VERSION,
    phase: input.phase,
    available: input.available,
    spoke: input.spoke,
    completed: input.phase === "complete",
    interrupted: input.phase === "interrupted",
    failed: input.phase === "failed",
    interruptions: input.interruptions,
    replays: input.replays,
    failureKind: input.phase === "failed" ? input.failureKind : undefined,
  };
}
