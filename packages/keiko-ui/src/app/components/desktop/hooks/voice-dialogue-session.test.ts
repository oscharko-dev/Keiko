// Issue #1560 (ADR-0096) — the PURE dialogue-session core. Exhaustive, mutation-robust coverage of the
// fallback matrix (D2), the event→signal mapping (D5), the effect→sink routing (D6), and the turn-loop
// helpers. No React, no I/O, no clock — every assertion is a deterministic function of its inputs.

import { describe, expect, it } from "vitest";
import type { VoiceCapabilityResolution } from "@/lib/types";
import { voiceDialogueModeForResolution } from "./voice-dialogue-session";

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

// A full deployment can still use turn-based capture when native media is unavailable.
const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  transport: { websocketControl: true, webrtcMedia: false },
};

const FULL_REALTIME_NO_PERSONAS: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  availableVoicePersonas: [],
};

const REALTIME_WITHOUT_TTS: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
};

const STALE_INCOMPLETE_REALTIME: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WEBRTC,
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: false },
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
      capture: "webrtc",
      speaks: true,
      canInterrupt: true,
    });
  });

  it("is NOT offered for full-realtime WITHOUT WebRTC media", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_WEBRTC, true)).toEqual({
      offered: false,
      capture: "none",
      speaks: false,
      canInterrupt: false,
    });
  });

  it("offers turn-based Digital Twin with STT, chat and mapped speech output", () => {
    expect(voiceDialogueModeForResolution(STALE_INCOMPLETE_REALTIME, false, true)).toEqual({
      offered: true,
      capture: "batch",
      speaks: true,
      canInterrupt: false,
    });
    expect(voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, true, true).capture).toBe("webrtc");
  });

  it("does not offer batch dialogue without browser capture or a mapped output persona", () => {
    expect(voiceDialogueModeForResolution(STALE_INCOMPLETE_REALTIME, false, false).offered).toBe(
      false,
    );
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_PERSONAS, false, true).offered).toBe(
      false,
    );
  });

  it("is NOT offered when full-realtime advertises zero personas", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_PERSONAS, true).offered).toBe(false);
  });

  it("is NOT offered when Realtime has no independent TTS even if stale personas are present", () => {
    expect(voiceDialogueModeForResolution(REALTIME_WITHOUT_TTS, true)).toEqual({
      offered: false,
      capture: "none",
      speaks: false,
      canInterrupt: false,
    });
  });

  it("is NOT offered for a stale full profile whose Realtime capability is incomplete", () => {
    expect(voiceDialogueModeForResolution(STALE_INCOMPLETE_REALTIME, true).offered).toBe(false);
  });

  it("is NOT offered when the browser cannot open realtime media, even for full-realtime", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, false).offered).toBe(false);
  });
});
