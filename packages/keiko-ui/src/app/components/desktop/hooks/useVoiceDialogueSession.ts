// Issue #1560, Epic #1556 (ADR-0096) — the THIN React hook that orchestrates a colleague-like spoken
// dialogue turn loop (D1). It composes the surfaces three siblings already shipped and drives ONE live
// `createVoiceTurnManager` as the single conversational truth (D4); it stands up no second state machine.
//
// Composition:
//   - its OWN `useDictation` instance whose committed-transcript insert sends through the EXISTING chat
//     lifecycle (`sendMessage({ text })`, Issue #1561) — the only seam to chat (AC2, D11); the committed
//     transcript is handed in directly so the spoken turn carries the same context (attachments,
//     grounding scope, local knowledge, memory) a typed turn does, and never strands on a stale draft;
//   - `useAssistantSpeech` given the live `turnManager`, so assistant-speech / interrupt signals reach
//     the same instance automatically (it forwards them via the playback binding);
//   - the pure `voice-dialogue-session` core for the fallback matrix, the user-side event→signal
//     mapping, and the effect→sink routing.
//
// The user side of the loop is driven here: mic activation → `user-speech-start` (the manager
// synthesizes barge-in when the assistant holds the floor); the dictation `preview` → `user-end-of-turn`
// on the full-realtime floor path (NOT `dictation-commit`, D4). Effects emitted by those `apply` calls
// are executed React-safely against typed sinks (D6), never synchronously inside a turn-manager observer.
//
// Master cleanup (D9) is one idempotent teardown run on leave, stop, unmount, and capability loss: it
// cancels dictation, stops playback, closes + resets the turn manager, and clears controller state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type {
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
  VoiceSpeechResult,
} from "@/lib/api";
import { useDictation } from "./useDictation";
import { useAssistantSpeech, type AssistantSpeechAudioElement } from "./useAssistantSpeech";
import { dictationCaptureSupported, type DictationRecorder } from "./dictation-recorder";
import {
  createBrowserVoiceActivityDetector,
  type VoiceActivityDetector,
} from "./voice-activity-detector";
import {
  createVoiceTurnManager,
  resolutionToVoiceProfile,
  type VoiceTurnManagerEngine,
  type VoiceTurnSnapshot,
} from "./voice-turn-manager";
import { deriveVoiceDialogState, type VoiceDialogState } from "./voice-dialog-state";
import {
  runDialogueEffects,
  shouldSpeakAnswer,
  signalForDictationPhase,
  signalForInterrupt,
  signalForMicActivation,
  voiceDialogueModeForResolution,
  type DialogueEffectSinks,
} from "./voice-dialogue-session";

// The chat seam the controller needs — the committed-text send path plus the in-flight-cancel barge-in
// hook. A structural subset of `ChatSessionApi` so the hook is testable without a full chat session.
export interface DialogueChatSession {
  readonly sendStatus: string;
  readonly sending: boolean;
  // Issue #1561 — the committed spoken transcript is sent through the chat path via `text` so the spoken
  // turn carries the identical context (attachments → documentContext, repository / local-knowledge
  // grounding scope, memory) a typed turn would. `setDraft` is intentionally NOT part of this seam: a
  // setDraft(text)+sendMessage() pair in one tick sends a stale (empty) draft, dropping the spoken turn.
  readonly sendMessage: (options?: { readonly text?: string }) => Promise<void>;
  readonly cancelSend: () => void;
}

export interface UseVoiceDialogueSessionOptions {
  readonly capability: VoiceCapabilityResolution | undefined;
  readonly active: boolean;
  readonly persona: VoicePersona | undefined;
  readonly session: DialogueChatSession;
  // The latest COMPLETE assistant message (text + id), or undefined while none has settled. Only this
  // text is ever spoken, so the spoken answer matches the transcript (AC2).
  readonly answerText: string | undefined;
  readonly answerId: string | undefined;
  // Called when the controller fully leaves the session (master cleanup), so the host can drop dialog
  // intent. Idempotent on the caller side.
  readonly onLeave: () => void;
  // Test seams forwarded to the composed dictation / speech hooks. Production uses the browser recorder,
  // the BFF clients, `new Audio()`, and the URL object-store.
  readonly createRecorder?: (() => DictationRecorder) | undefined;
  // Optional voice-activity detector override (tests inject a fake firing scripted events). Production
  // uses the WebAudio detector so a trailing silence ends the user's turn hands-free.
  readonly vad?: VoiceActivityDetector | undefined;
  readonly transcribe?:
    | ((input: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>)
    | undefined;
  readonly synthesize?:
    | ((text: string, signal: AbortSignal) => Promise<VoiceSpeechResult>)
    | undefined;
  readonly createAudio?: (() => AssistantSpeechAudioElement) | undefined;
  readonly createObjectUrl?: ((blob: Blob) => string) | undefined;
  readonly revokeObjectUrl?: ((url: string) => void) | undefined;
}

export interface VoiceDialogueSession {
  readonly dialogueAvailable: boolean;
  readonly state: VoiceDialogState;
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly canInterrupt: boolean;
  readonly muted: boolean;
  readonly onListen: () => void;
  readonly onInterrupt: () => void;
  readonly onStop: () => void;
  readonly toggleMute: () => void;
  readonly turnSnapshot: VoiceTurnSnapshot;
}

// True while the chat request is in flight, derived from the structural session subset.
function isChatInFlight(session: DialogueChatSession): boolean {
  return session.sending;
}

export function useVoiceDialogueSession(
  options: UseVoiceDialogueSessionOptions,
): VoiceDialogueSession {
  const { capability, active, persona, session, answerText, answerId, onLeave } = options;
  const { createRecorder, transcribe, synthesize, createAudio, createObjectUrl, revokeObjectUrl } =
    options;

  const captureSupported = dictationCaptureSupported();
  const mode = useMemo(
    () => voiceDialogueModeForResolution(capability, captureSupported),
    [capability, captureSupported],
  );
  const dialogueAvailable = mode.offered;
  const profile = resolutionToVoiceProfile(capability);

  // One live turn manager — the single conversational truth (D4). Rebuilt only when the profile
  // changes (a deployment switch), which a fresh reducer correctly represents.
  const turnManagerRef = useRef<VoiceTurnManagerEngine | undefined>(undefined);
  const managerProfileRef = useRef<string | undefined>(undefined);
  if (turnManagerRef.current === undefined || managerProfileRef.current !== profile) {
    turnManagerRef.current = createVoiceTurnManager({ profile });
    managerProfileRef.current = profile;
  }
  const turnManager = turnManagerRef.current;

  const [turnSnapshot, setTurnSnapshot] = useState<VoiceTurnSnapshot>(() => turnManager.snapshot());
  // Keep the latest session in a ref so the stable effect sinks read current values without re-binding.
  const sessionRef = useRef<DialogueChatSession>(session);
  sessionRef.current = session;

  // The playback binding receives the live turn manager, so assistant-speech-start / speech-end /
  // interrupt signals are applied to the SAME instance automatically (it forwards them). Only the latest
  // settled answer is synthesized, and only while dialogue is active and offered (AC2).
  const speakEnabled = active && shouldSpeakAnswer(mode, answerText !== undefined);
  const playback = useAssistantSpeech({
    profile,
    enabled: speakEnabled,
    text: speakEnabled ? answerText : undefined,
    messageId: speakEnabled ? answerId : undefined,
    persona,
    turnManager,
    synthesize,
    createAudio,
    createObjectUrl,
    revokeObjectUrl,
  });
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  // The typed effect sinks bound to the live components (D6). `stop-playback` interrupts playback at the
  // carried offset; `cancel-speech-generation` cancels an in-flight chat request (barge-in). The
  // remaining effects are inert in this STT+TTS path (no live control plane / recovery UI here).
  const sinks = useMemo<DialogueEffectSinks>(
    () => ({
      stopPlayback: (atMs) => playbackRef.current.interrupt(atMs),
      cancelGeneration: () => {
        if (isChatInFlight(sessionRef.current)) {
          sessionRef.current.cancelSend();
        }
      },
      preserveUserTurn: () => undefined,
      beginRecovery: () => undefined,
      emitBackchannel: () => undefined,
    }),
    [],
  );

  // Apply a user-side signal to the live manager, sync the snapshot, and execute the emitted effects
  // React-safely (outside any observer, D6). The interrupt offset is threaded so a barge-in stop-playback
  // hits the right media position.
  const applyUserSignal = useCallback(
    (signal: Parameters<VoiceTurnManagerEngine["apply"]>[0], interruptAtMs?: number): void => {
      const result = turnManager.apply(signal);
      setTurnSnapshot(result.snapshot);
      runDialogueEffects(result.effects, sinks, { interruptAtMs });
    },
    [turnManager, sinks],
  );

  // Committed transcript → chat (AC2): only non-empty trimmed text, via the EXISTING lifecycle. Never a
  // second prompt or route; no spoken-action auto-execution (D10/D11).
  const sendCommittedTranscript = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Issue #1561 — hand the committed transcript directly to the chat send so it flows through the same
    // context-bearing path as a typed message (attachments, grounding scope, local knowledge, memory).
    // Passing `text` avoids the stale-draft race a setDraft(text)+sendMessage() pair would hit (the send
    // would read an empty draft from its closure and drop the turn).
    void sessionRef.current.sendMessage({ text: trimmed });
  }, []);

  // The voice-activity detector that makes the turn hands-free: production uses the WebAudio detector,
  // tests inject a fake. Stable across renders so the dictation hook never re-binds it.
  const vad = useMemo(() => options.vad ?? createBrowserVoiceActivityDetector(), [options.vad]);

  const dictation = useDictation({
    onInsert: sendCommittedTranscript,
    createRecorder,
    transcribe,
    vad,
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  // Map the dictation phase transition onto a turn signal (preview → user-end-of-turn, D4; error →
  // provider-failure) and, ONLY for the committed end-of-turn, insert the transcript into chat. Tracking
  // the previous phase makes the transition edge-triggered, so a stable phase never re-fires; the
  // failure edge must not call insert() (there is no committed transcript to send).
  const prevPhaseRef = useRef(dictation.phase);
  useEffect(() => {
    const previous = prevPhaseRef.current;
    const next = dictation.phase;
    prevPhaseRef.current = next;
    if (!active) {
      return;
    }
    const signal = signalForDictationPhase(previous, next);
    if (signal !== undefined) {
      applyUserSignal(signal);
      if (signal.kind === "user-end-of-turn") {
        dictationRef.current.insert();
      }
    }
  }, [dictation.phase, active, applyUserSignal]);

  // The playback binding applies assistant-speech-start / speech-end / interrupt signals to the SAME
  // live manager directly (it forwards them, D4). Those mutations bypass `applyUserSignal`, so the
  // snapshot is re-synced whenever the playback phase changes — this is the read seam that surfaces the
  // assistant-driven floor transitions (speaking / yielding / idle) and re-arms the next user turn.
  useEffect(() => {
    setTurnSnapshot(turnManager.snapshot());
  }, [playback.snapshot.phase, turnManager]);

  // ─── Master cleanup (D9) — one idempotent teardown ──────────────────────────────
  const teardown = useCallback((): void => {
    dictationRef.current.cancel();
    playbackRef.current.stop();
    turnManager.apply({ kind: "session-closed" });
    turnManager.reset();
    setTurnSnapshot(turnManager.snapshot());
    prevPhaseRef.current = "idle";
  }, [turnManager]);

  // Leave on capability loss mid-session (AC3/AC4): a deployment that flips !available tears the session
  // down and notifies the host, so no control is stranded active.
  useEffect(() => {
    if (active && !dialogueAvailable) {
      teardown();
      onLeave();
    }
  }, [active, dialogueAvailable, teardown, onLeave]);

  // Release everything on unmount (D9).
  useEffect(() => teardown, [teardown]);

  // The dialogue mic is a toggle: while capturing (recording), a second activation ENDS the user turn
  // by stopping capture (→ transcribe → preview → user-end-of-turn → send); otherwise it begins a new
  // listening turn. A mid-speech activation is a barge-in: the manager synthesizes interrupt + listen
  // from the `user-speech-start` signal (ADR-0062), and the emitted effects stop playback + cancel
  // generation (D6).
  const onListen = useCallback((): void => {
    if (!active || !dialogueAvailable) {
      return;
    }
    const phase = dictationRef.current.phase;
    // A capture start or transcription is already in flight: ignore the re-tap. useDictation's
    // single-session guard only arms AFTER start() resolves, so a second start() during the `requesting`
    // permission window would open a second getUserMedia stream and leak the first track.
    if (phase === "requesting" || phase === "transcribing") {
      return;
    }
    // Recording: a second activation ENDS the user turn (→ transcribe → preview → user-end-of-turn → send).
    if (phase === "recording") {
      dictationRef.current.stop();
      return;
    }
    // idle / preview / error: begin a new listening turn. A mid-speech activation is a barge-in — the
    // manager synthesizes interrupt + listen from `user-speech-start` (ADR-0062) and the emitted effects
    // stop playback + cancel generation (D6).
    applyUserSignal(signalForMicActivation(), playbackRef.current.snapshot.lastInterruptAtMs);
    dictationRef.current.start();
  }, [active, dialogueAvailable, applyUserSignal]);

  const onInterrupt = useCallback((): void => {
    const atMs = playbackRef.current.snapshot.lastInterruptAtMs;
    applyUserSignal(signalForInterrupt(atMs), atMs);
  }, [applyUserSignal]);

  const onStop = useCallback((): void => {
    teardown();
    onLeave();
  }, [teardown, onLeave]);

  const state = deriveVoiceDialogState({
    realtimePhase: "idle",
    turnState: turnSnapshot.state,
    muted: playback.snapshot.muted,
  });

  return {
    dialogueAvailable,
    state,
    listening: turnSnapshot.state === "listening",
    speaking: turnSnapshot.state === "speaking",
    canInterrupt: mode.canInterrupt && turnSnapshot.floorHolder === "assistant",
    muted: playback.snapshot.muted,
    onListen,
    onInterrupt,
    onStop,
    toggleMute: playback.toggleMute,
    turnSnapshot,
  };
}
