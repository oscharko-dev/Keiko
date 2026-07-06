// Issue #1559, Epic #1556 — pure, React-free derivation of the single label the dialog-mode UI shows.
//
// The chat already owns three orthogonal voice snapshots: the realtime connection phase
// (`useRealtimeVoice`), the conversational floor (`voice-turn-manager`), and the playback mute
// preference (`useVoicePlayback`). The dialog-mode surface must collapse those into ONE deterministic
// session label so the live-region status never contradicts the controls. This module is the single
// source of that collapse: it is pure (no React, no clock, no I/O), so the precedence is exhaustively
// pinnable in tests and mutation-robust.
//
// In realtime dialogue `muted` means the microphone is not being sent to the provider. Surface that as
// a session state so the UI never claims the dialogue is ready/listening while Keiko cannot hear the
// user. Non-dialogue assistant playback still owns its separate VoicePlayback mute label.

import type { RealtimeVoicePhase } from "./useRealtimeVoice";
import type { VoiceTurnState } from "./voice-turn-manager";
import type { VoicePlaybackPhase } from "./voice-playback-state";

// The eight user-facing dialog-session states. Distinct from the lower-level turn states: 'yielding',
// 'recovering', and 'disabled' are internal turn-manager states that map onto these via the precedence
// below (recovering ⇒ connecting; yielding/disabled ⇒ idle), so the UI never surfaces a raw turn state.
export type VoiceDialogState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "interrupted" | "error";

export type VoiceAuraState =
  | "ready"
  | "preparing" // initial connect in progress
  | "reconnecting" // a live session dropped and is recovering
  | "listening"
  | "thinking"
  | "checking-sources" // grounded retrieval in flight
  | "speaking"
  | "muted"
  | "interrupted"
  | "error";

export type VoiceAuraIntensity = "low" | "medium" | "high";

export interface VoiceDialogStateInputs {
  readonly realtimePhase: RealtimeVoicePhase;
  readonly turnState: VoiceTurnState;
  readonly muted: boolean;
}

export interface VoiceAuraStateInputs {
  readonly voiceDialogActive: boolean;
  readonly voiceDialogAvailable: boolean;
  readonly voiceDialogState: VoiceDialogState;
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly sending: boolean;
  readonly sendStatus: string;
  readonly hasSessionError: boolean;
  // A live session dropped and is recovering (distinct from the initial connect, which the collapsed
  // dialog state also reports as 'connecting'). Surfaced as 'reconnecting' so the user knows the link
  // is being restored rather than thinking the assistant went quiet.
  readonly reconnecting?: boolean | undefined;
  // A grounded retrieval is in flight for the current turn. Surfaced as 'checking-sources' so the user
  // knows Keiko is consulting connected sources rather than merely formulating an answer.
  readonly retrieving?: boolean | undefined;
}

export interface VoiceAuraStateSnapshot {
  readonly active: boolean;
  readonly state: VoiceAuraState;
  readonly intensity: VoiceAuraIntensity;
}

// Derive the dialog-session label. The ordering is load-bearing and pinned in tests:
//   1. a transport error dominates everything (the session is not usable);
//   2. an in-progress connection (requesting/negotiating, or a turn-manager recovery) reads 'connecting';
//   3. a barge-in / interruption is surfaced before the steady floor states;
//   4. a connected muted microphone reads 'muted' before any steady floor state;
//   5. an assistant speaking turn reads 'speaking';
//   6. then the remaining steady floor states (thinking, listening);
//   6. everything else (idle, yielding, disabled, connected-but-no-floor) is 'idle'.
export function deriveVoiceDialogState(inputs: VoiceDialogStateInputs): VoiceDialogState {
  const { realtimePhase, turnState, muted } = inputs;
  if (realtimePhase === "error") {
    return "error";
  }
  if (
    realtimePhase === "requesting" ||
    realtimePhase === "negotiating" ||
    turnState === "recovering"
  ) {
    return "connecting";
  }
  if (turnState === "interrupted") {
    return "interrupted";
  }
  if (realtimePhase === "connected" && muted) {
    return "muted";
  }
  if (turnState === "speaking") {
    return "speaking";
  }
  if (turnState === "thinking") {
    return "thinking";
  }
  if (turnState === "listening") {
    return "listening";
  }
  return "idle";
}

export function deriveVoiceAuraState(inputs: VoiceAuraStateInputs): VoiceAuraStateSnapshot {
  if (!inputs.voiceDialogActive) {
    return { active: false, state: "ready", intensity: "low" };
  }
  if (
    !inputs.voiceDialogAvailable ||
    inputs.hasSessionError ||
    inputs.voiceDialogState === "error"
  ) {
    return { active: true, state: "error", intensity: "high" };
  }
  if (inputs.voiceDialogState === "interrupted") {
    return { active: true, state: "interrupted", intensity: "high" };
  }
  // A recovery in progress dominates the steady states: the user must know the link dropped and is being
  // restored. Ranked above muted/speaking because it is a transport condition affecting the whole session.
  if (inputs.reconnecting === true) {
    return { active: true, state: "reconnecting", intensity: "high" };
  }
  if (inputs.voiceDialogState === "muted") {
    return { active: true, state: "muted", intensity: "medium" };
  }
  if (inputs.speaking || inputs.voiceDialogState === "speaking") {
    return { active: true, state: "speaking", intensity: "high" };
  }
  // Grounded retrieval in flight — surfaced before generic "thinking" so the user knows Keiko is
  // consulting sources, not just formulating a reply.
  if (inputs.retrieving === true) {
    return { active: true, state: "checking-sources", intensity: "high" };
  }
  const modelBusy =
    inputs.sending ||
    inputs.sendStatus === "queued" ||
    inputs.sendStatus === "contacting" ||
    inputs.sendStatus === "streaming";
  if (inputs.voiceDialogState === "thinking" || modelBusy) {
    return { active: true, state: "thinking", intensity: modelBusy ? "high" : "medium" };
  }
  if (inputs.listening || inputs.voiceDialogState === "listening") {
    return { active: true, state: "listening", intensity: "medium" };
  }
  // Initial connect — a dedicated 'preparing' aura (not 'ready') so an empty-but-connecting session is
  // never mistaken for a live, listening one.
  if (inputs.voiceDialogState === "connecting") {
    return { active: true, state: "preparing", intensity: "medium" };
  }
  return { active: true, state: "ready", intensity: "low" };
}

// Assistive-text headline per aura state (professional English). A total record makes adding an aura
// state without a headline a compile error. Drives the throttled dialog live region so the spoken
// session's status is announced without contradicting the controls.
const AURA_STATE_HEADLINE: Record<VoiceAuraState, string> = {
  ready: "Voice dialogue is ready.",
  preparing: "Preparing the voice dialogue…",
  reconnecting: "Reconnecting the voice dialogue…",
  listening: "Listening to you.",
  thinking: "The assistant is thinking.",
  "checking-sources": "Checking connected sources…",
  speaking: "The assistant is speaking.",
  muted: "Voice dialogue microphone is muted.",
  interrupted: "Voice dialogue interrupted.",
  error: "Voice dialogue could not continue. You can keep chatting in text.",
};

export function voiceAuraStateHeadline(state: VoiceAuraState): string {
  return AURA_STATE_HEADLINE[state];
}

// Assistive-text headline per state (professional English). A total record makes adding a state without
// a headline a compile error. The strings are scoped to spoken dialogue and never imply text chat is
// blocked — text input stays available throughout (AC1).
const DIALOG_STATE_HEADLINE: Record<VoiceDialogState, string> = {
  idle: "Voice dialogue is ready.",
  connecting: "Connecting the voice dialogue…",
  listening: "Listening to you.",
  thinking: "The assistant is thinking.",
  speaking: "The assistant is speaking.",
  muted: "Voice dialogue microphone is muted.",
  interrupted: "Voice dialogue interrupted.",
  error: "Voice dialogue could not continue. You can keep chatting in text.",
};

export function voiceDialogStateHeadline(state: VoiceDialogState): string {
  return DIALOG_STATE_HEADLINE[state];
}

// True while the session is actively conversing, so the status strip shows a live dot. Kept here so the
// presentational component derives its dot from the same single source as the headline.
export function voiceDialogStateIsLive(state: VoiceDialogState): boolean {
  return state === "listening" || state === "speaking" || state === "muted";
}

// Map the assistant playback phase onto a turn-manager floor state, so the dialog-mode UI derives its
// label from the playback snapshot the chat already owns without standing up a second turn manager.
// Only the assistant-floor phases are meaningful here: 'preparing' is the assistant thinking before it
// speaks, 'speaking'/'paused' hold the floor, 'interrupted' is a barge-in, and every settled or
// unavailable phase yields the floor back to 'idle'. User-listening is not observable from playback
// alone, so it is never synthesized here (a future live turn manager would supply it directly).
export function playbackPhaseToTurnState(phase: VoicePlaybackPhase): VoiceTurnState {
  switch (phase) {
    case "preparing":
      return "thinking";
    case "speaking":
    case "paused":
      return "speaking";
    case "interrupted":
      return "interrupted";
    case "unavailable":
    case "canceled":
    case "complete":
    case "failed":
      return "idle";
  }
}
