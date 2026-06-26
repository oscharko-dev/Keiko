// Issue #1560 (ADR-0090) — the PURE dialogue-session core. Exhaustive, mutation-robust coverage of the
// fallback matrix (D2), the event→signal mapping (D5), the effect→sink routing (D6), and the turn-loop
// helpers. No React, no I/O, no clock — every assertion is a deterministic function of its inputs.

import { describe, expect, it, vi } from "vitest";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type { DictationPhase } from "./useDictation";
import type { VoiceTurnEffect, VoiceTurnSnapshot, VoiceTurnState } from "./voice-turn-manager";
import {
  canArmListening,
  runDialogueEffects,
  shouldSpeakAnswer,
  signalForAssistantSpeechEnd,
  signalForAssistantSpeechStart,
  signalForDictationPhase,
  signalForInterrupt,
  signalForMicActivation,
  signalForProviderFailure,
  voiceDialogueModeForResolution,
  type DialogueEffectSinks,
} from "./voice-dialogue-session";

// ─── Capability fixtures ────────────────────────────────────────────────────────
const PERSONAS = ["male", "female", "neutral"] as const;

const NONE: VoiceCapabilityResolution = {
  available: false,
  profile: "none",
  capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: false, webrtcMedia: false },
  availableVoicePersonas: [],
  reason: "no-voice-provider",
};

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

const SPEECH_OUTPUT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-output",
  capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

const FULL_REALTIME_WEBRTC: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: PERSONAS,
};

// The load-bearing fallback case (D3): full-realtime deployment in a browser WITHOUT WebRTC media.
const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  transport: { websocketControl: true, webrtcMedia: false },
};

const FULL_REALTIME_NO_PERSONAS: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  availableVoicePersonas: [],
};

// ─── Fallback matrix (D2) ──────────────────────────────────────────────────────────
describe("voiceDialogueModeForResolution — fallback matrix (D2/D3, AC4)", () => {
  it("is dormant + fail-closed for an undefined (unresolved / failed) resolution", () => {
    expect(voiceDialogueModeForResolution(undefined, true)).toEqual({
      offered: false,
      capture: "none",
      speaks: false,
      canInterrupt: false,
    });
  });

  it("is dormant for the 'none' profile even with browser capture", () => {
    expect(voiceDialogueModeForResolution(NONE, true).offered).toBe(false);
  });

  it("is NOT offered for STT-only (no spoken answer)", () => {
    const mode = voiceDialogueModeForResolution(STT, true);
    expect(mode.offered).toBe(false);
    expect(mode.speaks).toBe(false);
  });

  it("is NOT offered for speech-output-only (no user capture)", () => {
    const mode = voiceDialogueModeForResolution(SPEECH_OUTPUT, true);
    expect(mode.offered).toBe(false);
    expect(mode.capture).toBe("none");
  });

  it("IS offered for full-realtime with WebRTC media", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, true)).toEqual({
      offered: true,
      capture: "dictation",
      speaks: true,
      canInterrupt: true,
    });
  });

  it("IS STILL offered for full-realtime WITHOUT WebRTC media (the STT+TTS fallback fix, D3)", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_WEBRTC, true)).toEqual({
      offered: true,
      capture: "dictation",
      speaks: true,
      canInterrupt: true,
    });
  });

  it("is NOT offered when full-realtime advertises zero personas", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_PERSONAS, true).offered).toBe(false);
  });

  it("is NOT offered when the browser cannot capture audio, even for full-realtime", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, false).offered).toBe(false);
  });
});

// ─── Event → signal mapping (D5) ────────────────────────────────────────────────────
describe("event → VoiceTurnSignal mapping (D5, content-free D10)", () => {
  it("mic activation maps to user-speech-start", () => {
    expect(signalForMicActivation()).toEqual({ kind: "user-speech-start" });
  });

  it("dictation entering preview maps to user-end-of-turn (full-realtime floor path, D4)", () => {
    expect(signalForDictationPhase("transcribing", "preview")).toEqual({
      kind: "user-end-of-turn",
    });
  });

  it("does NOT emit dictation-commit on preview (the full-realtime gate rejects it, D4)", () => {
    const signal = signalForDictationPhase("transcribing", "preview");
    expect(signal?.kind).not.toBe("dictation-commit");
  });

  it("emits no signal when already in preview (no re-fire on a stable phase)", () => {
    expect(signalForDictationPhase("preview", "preview")).toBeUndefined();
  });

  it.each<[DictationPhase, DictationPhase]>([
    ["idle", "requesting"],
    ["requesting", "recording"],
    ["recording", "transcribing"],
    ["preview", "idle"],
    ["recording", "error"],
  ])("emits no signal for the %s → %s transition", (previous, next) => {
    expect(signalForDictationPhase(previous, next)).toBeUndefined();
  });

  it("assistant speech start maps to assistant-speech-start", () => {
    expect(signalForAssistantSpeechStart()).toEqual({ kind: "assistant-speech-start" });
  });

  it("assistant speech end carries the completed reason", () => {
    expect(signalForAssistantSpeechEnd("completed")).toEqual({
      kind: "assistant-speech-end",
      how: "completed",
    });
  });

  it("assistant speech end carries the stopped reason", () => {
    expect(signalForAssistantSpeechEnd("stopped")).toEqual({
      kind: "assistant-speech-end",
      how: "stopped",
    });
  });

  it("interrupt without an offset omits atMs", () => {
    expect(signalForInterrupt(undefined)).toEqual({ kind: "user-interrupt" });
  });

  it("interrupt with an offset carries only the ms integer", () => {
    expect(signalForInterrupt(1234)).toEqual({ kind: "user-interrupt", atMs: 1234 });
  });

  it("provider failure carries the recoverable flag", () => {
    expect(signalForProviderFailure(true)).toEqual({
      kind: "provider-failure",
      recoverable: true,
    });
    expect(signalForProviderFailure(false)).toEqual({
      kind: "provider-failure",
      recoverable: false,
    });
  });
});

// ─── Effect → sink routing (D6) ─────────────────────────────────────────────────────
function makeSinks(): { sinks: DialogueEffectSinks; calls: string[] } {
  const calls: string[] = [];
  const sinks: DialogueEffectSinks = {
    stopPlayback: (atMs) => calls.push(`stopPlayback:${String(atMs)}`),
    cancelGeneration: () => calls.push("cancelGeneration"),
    preserveUserTurn: () => calls.push("preserveUserTurn"),
    beginRecovery: () => calls.push("beginRecovery"),
    emitBackchannel: () => calls.push("emitBackchannel"),
  };
  return { sinks, calls };
}

describe("runDialogueEffects — effect → sink routing (D6)", () => {
  it("routes each effect to exactly its sink, in order", () => {
    const { sinks, calls } = makeSinks();
    const effects: readonly VoiceTurnEffect[] = [
      "stop-playback",
      "cancel-speech-generation",
      "preserve-user-turn",
      "begin-recovery",
      "emit-backchannel",
    ];
    runDialogueEffects(effects, sinks, { interruptAtMs: 42 });
    expect(calls).toEqual([
      "stopPlayback:42",
      "cancelGeneration",
      "preserveUserTurn",
      "beginRecovery",
      "emitBackchannel",
    ]);
  });

  it("threads the interrupt offset into stop-playback", () => {
    const { sinks, calls } = makeSinks();
    runDialogueEffects(["stop-playback"], sinks, { interruptAtMs: 900 });
    expect(calls).toEqual(["stopPlayback:900"]);
  });

  it("passes undefined offset when no context is supplied", () => {
    const { sinks, calls } = makeSinks();
    runDialogueEffects(["stop-playback"], sinks);
    expect(calls).toEqual(["stopPlayback:undefined"]);
  });

  it("invokes nothing for an empty effect list", () => {
    const { sinks, calls } = makeSinks();
    runDialogueEffects([], sinks);
    expect(calls).toHaveLength(0);
  });

  it("invokes a sink once per repeated effect", () => {
    const { sinks } = makeSinks();
    const spy = vi.fn();
    runDialogueEffects(["cancel-speech-generation", "cancel-speech-generation"], {
      ...sinks,
      cancelGeneration: spy,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ─── Turn-loop helpers ──────────────────────────────────────────────────────────────
function snapshotWith(state: VoiceTurnState, active = true): VoiceTurnSnapshot {
  return {
    profile: "full-realtime",
    active,
    state,
    floorHolder: "none",
    turnIndex: 0,
    interruptions: 0,
    backchannels: 0,
    pendingCommit: false,
    recovering: state === "recovering",
    lastEndOfTurnAtMs: undefined,
    lastInterruptAtMs: undefined,
  };
}

describe("canArmListening", () => {
  it("arms only from an active, idle floor with idle dictation", () => {
    expect(canArmListening(snapshotWith("idle"), "idle")).toBe(true);
  });

  it("does not arm while the floor is busy", () => {
    expect(canArmListening(snapshotWith("speaking"), "idle")).toBe(false);
    expect(canArmListening(snapshotWith("listening"), "idle")).toBe(false);
    expect(canArmListening(snapshotWith("thinking"), "idle")).toBe(false);
  });

  it("does not arm while dictation is mid-flow", () => {
    expect(canArmListening(snapshotWith("idle"), "recording")).toBe(false);
    expect(canArmListening(snapshotWith("idle"), "preview")).toBe(false);
  });

  it("does not arm when the manager is inactive (disabled)", () => {
    expect(canArmListening(snapshotWith("disabled", false), "idle")).toBe(false);
  });
});

describe("shouldSpeakAnswer", () => {
  it("speaks only when the mode is offered, speaks, and an answer settled", () => {
    const mode = voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, true);
    expect(shouldSpeakAnswer(mode, true)).toBe(true);
    expect(shouldSpeakAnswer(mode, false)).toBe(false);
  });

  it("never speaks when the mode is not offered", () => {
    const mode = voiceDialogueModeForResolution(STT, true);
    expect(shouldSpeakAnswer(mode, true)).toBe(false);
  });
});
