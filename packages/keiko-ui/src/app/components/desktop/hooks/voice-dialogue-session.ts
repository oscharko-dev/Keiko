// Issue #1560, Epic #1556 (ADR-0096) — the PURE, React-free, I/O-free core of the voice dialogue
// session controller. It owns three deterministic concerns the thin hook composes (D1):
//
//   1. The fallback-matrix predicate `voiceDialogueModeForResolution` (D2): is spoken dialogue offered
//      for this resolution, and — if so — what does the session do (capture / speak / barge-in)? Total
//      over the VoiceProfile ladder, fail-closed for `undefined` / `none` / unsupported browser capture.
//   2. The mapping from real component events onto the existing `VoiceTurnSignal` union (D5). Events
//      carry NO content: only enum kinds and millisecond deltas ever reach the turn manager (D10).
//   3. The routing from emitted `VoiceTurnEffect` directives onto a typed sink contract the hook binds
//      to the live components (D6). `runDialogueEffects` is a pure dispatcher with no side effects of
//      its own — it only invokes the caller-supplied sinks.
//
// This module stands up NO second state machine: the conversational truth is the one live
// `createVoiceTurnManager` instance the hook drives. The helpers here are deterministic functions over
// observed inputs, exhaustively unit-testable without a React environment.

import type { VoiceProfile } from "@/lib/types";
import type { VoiceCapabilityResolution } from "@/lib/types";
import { supportsDictation, supportsSpeechOutput } from "./useVoiceCapability";
import type { DictationPhase } from "./useDictation";
import type { VoiceTurnEffect, VoiceTurnSignal, VoiceTurnSnapshot } from "./voice-turn-manager";

// ─── Fallback matrix (D2) ────────────────────────────────────────────────────────
// The capture strategy the offered session uses. `"none"` is the fail-closed default for every
// not-offered case; `"dictation"` is the single deployed user-capture path (the STT-batch route).
export type VoiceDialogueCapture = "none" | "dictation";

// The total description the matrix returns for a resolution. `offered` gates the dialogue switch; the
// remaining fields describe what an offered session can do. Every field is deterministically derived,
// so the whole object is one pure function of the inputs.
export interface VoiceDialogueMode {
  readonly offered: boolean;
  readonly capture: VoiceDialogueCapture;
  readonly speaks: boolean;
  readonly canInterrupt: boolean;
}

const DIALOGUE_DORMANT: VoiceDialogueMode = {
  offered: false,
  capture: "none",
  speaks: false,
  canInterrupt: false,
};

// Dialogue is offered IFF the deployment can both capture user speech (dictation) and speak the answer
// (speech output), AND the browser can capture audio, AND at least one persona is advertised. That
// conjunction is true only for the `full-realtime` profile (ADR-0096 D2) — identical whether or not the
// browser has WebRTC media, which is exactly the STT+TTS fallback the issue fixes (D3). `undefined`,
// `none`, and every partial profile short-circuit to the dormant, fail-closed result.
export function voiceDialogueModeForResolution(
  resolution: VoiceCapabilityResolution | undefined,
  browserCaptureSupported: boolean,
): VoiceDialogueMode {
  const personaCount = resolution?.availableVoicePersonas?.length ?? 0;
  const offered =
    supportsDictation(resolution) &&
    supportsSpeechOutput(resolution) &&
    browserCaptureSupported &&
    personaCount > 0;
  if (!offered) {
    return DIALOGUE_DORMANT;
  }
  return { offered: true, capture: "dictation", speaks: true, canInterrupt: true };
}

// ─── Event → VoiceTurnSignal mapping (D5) ─────────────────────────────────────────
// The hook observes real component lifecycle and asks the core which content-free signal (if any) to
// apply to the live turn manager. Each mapper is a pure function returning a signal or `undefined`
// (no signal for this observation). They never carry transcript text, audio, or SDP (D10).

// User activated the dialogue mic. Always a `user-speech-start`: the turn manager itself synthesizes a
// barge-in (interrupt + listen) when the activation lands while the assistant is speaking (ADR-0062).
export function signalForMicActivation(): VoiceTurnSignal {
  return { kind: "user-speech-start" };
}

// The dictation capture reached `preview` (recording stopped, transcript settled). In the dialogue
// profile (always `full-realtime`, D4) this is the user END-OF-TURN on the floor-control path
// (`listening → thinking`); it must NOT be a `dictation-commit`, which the full-realtime admission gate
// rejects (`usesManualCommit` is false), stranding the turn in `listening`.
export function signalForDictationPhase(
  previous: DictationPhase,
  next: DictationPhase,
): VoiceTurnSignal | undefined {
  if (next === "preview" && previous !== "preview") {
    return { kind: "user-end-of-turn" };
  }
  // A dictation provider failure (transcribe error, device loss, permission denial) drives the floor
  // OFF `listening` so the turn does not strand. The dictation layer has already released the mic track,
  // so this leaks nothing; it is treated as recoverable so the user can retry by speaking again (Scope:
  // "handle provider error without leaking resources"; AC4). `signalForProviderFailure` is the owner of
  // this mapping (D5).
  if (next === "error" && previous !== "error") {
    return signalForProviderFailure(true);
  }
  return undefined;
}

// Assistant speech playback began. Drives `thinking → speaking`.
export function signalForAssistantSpeechStart(): VoiceTurnSignal {
  return { kind: "assistant-speech-start" };
}

// Assistant speech playback settled. `completed` yields the floor cooperatively; `stopped` marks a
// mid-turn interruption end. The hook supplies the reason from the playback phase it observed.
export function signalForAssistantSpeechEnd(how: "completed" | "stopped"): VoiceTurnSignal {
  return { kind: "assistant-speech-end", how };
}

// A user-driven barge-in (an explicit interrupt control while the assistant holds the floor). Carries
// only the optional client-perceived media offset in ms — never any content.
export function signalForInterrupt(atMs: number | undefined): VoiceTurnSignal {
  return atMs === undefined ? { kind: "user-interrupt" } : { kind: "user-interrupt", atMs };
}

// A provider failure (STT / TTS / chat). `recoverable` routes to `recovering` (+ begin-recovery) vs
// the terminal `disabled`; text chat stays usable either way (AC4).
export function signalForProviderFailure(recoverable: boolean): VoiceTurnSignal {
  return { kind: "provider-failure", recoverable };
}

// ─── Effect → sink routing (D6) ───────────────────────────────────────────────────
// The turn manager EMITS content-free effect directives but never executes them (ADR-0062 D7). The
// hook binds one sink function per effect to the live components; `runDialogueEffects` is a pure
// dispatcher that routes each emitted effect to its sink. It performs no side effect of its own and is
// invoked by the hook in a React-safe callback, never synchronously inside a turn-manager observer
// (avoids re-entrant `apply`, D6).
export interface DialogueEffectSinks {
  readonly stopPlayback: (atMs: number | undefined) => void;
  readonly cancelGeneration: () => void;
  readonly preserveUserTurn: () => void;
  readonly beginRecovery: () => void;
  readonly emitBackchannel: () => void;
}

// The barge-in offset the `stop-playback` effect carries to `playback.interrupt(atMs)`. The turn
// manager's effect vocabulary is content-free (no atMs on the effect), so the hook threads the
// interrupt offset it already holds (from the originating `user-interrupt` signal) through this carrier.
export interface DialogueEffectContext {
  readonly interruptAtMs: number | undefined;
}

function routeEffect(
  effect: VoiceTurnEffect,
  sinks: DialogueEffectSinks,
  context: DialogueEffectContext,
): void {
  switch (effect) {
    case "stop-playback":
      sinks.stopPlayback(context.interruptAtMs);
      return;
    case "cancel-speech-generation":
      sinks.cancelGeneration();
      return;
    case "preserve-user-turn":
      sinks.preserveUserTurn();
      return;
    case "begin-recovery":
      sinks.beginRecovery();
      return;
    case "emit-backchannel":
      sinks.emitBackchannel();
      return;
  }
}

export function runDialogueEffects(
  effects: readonly VoiceTurnEffect[],
  sinks: DialogueEffectSinks,
  context: DialogueEffectContext = { interruptAtMs: undefined },
): void {
  for (const effect of effects) {
    routeEffect(effect, sinks, context);
  }
}

// ─── Turn-loop next-action helper ──────────────────────────────────────────────────
// Whether listening may be re-armed for the next user turn. The session re-arms only from a resting
// floor: an `idle` turn state with no dictation flow in progress. Pure and deterministic so the hook's
// re-arm decision is unit-testable in isolation.
export function canArmListening(
  snapshot: VoiceTurnSnapshot,
  dictationPhase: DictationPhase,
): boolean {
  return snapshot.active && snapshot.state === "idle" && dictationPhase === "idle";
}

// Whether a settled assistant message is eligible to be spoken as the current turn's answer. Used by
// the hook to gate `useAssistantSpeech`; pure so the gate is pinnable.
export function shouldSpeakAnswer(mode: VoiceDialogueMode, hasSettledAnswer: boolean): boolean {
  return mode.offered && mode.speaks && hasSettledAnswer;
}

// ─── Profile adapter re-export ──────────────────────────────────────────────────────
// The resolved profile drives the live turn manager. Re-exported so the hook constructs the manager
// from the same primitive without importing two sibling modules.
export type { VoiceProfile };
