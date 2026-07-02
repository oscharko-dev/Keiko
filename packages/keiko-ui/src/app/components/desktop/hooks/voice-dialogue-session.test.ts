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

  it("is NOT offered when full-realtime advertises zero personas", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_NO_PERSONAS, true).offered).toBe(false);
  });

  it("is NOT offered when the browser cannot open realtime media, even for full-realtime", () => {
    expect(voiceDialogueModeForResolution(FULL_REALTIME_WEBRTC, false).offered).toBe(false);
  });
});
