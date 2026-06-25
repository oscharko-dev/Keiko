// Issue #495 — the non-blocking voice-capability probe. Verifies the hook resolves the capability,
// shares a single module-cached fetch across mounts (so the 3 composer slots never triple-probe),
// and fails safe to "no voice affordance" on a transport error.

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVoiceCapabilityCacheForTests,
  supportsDictation,
  supportsSpeechOutput,
  useVoiceCapability,
} from "./useVoiceCapability";
import * as api from "@/lib/api";
import type { VoiceCapabilityResolution } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchVoiceCapability: vi.fn() };
});

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  providerLocality: "azure-foundry",
};

const NONE: VoiceCapabilityResolution = {
  available: false,
  profile: "none",
  capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: false, webrtcMedia: false },
  reason: "no-voice-provider",
};

beforeEach(() => {
  clearVoiceCapabilityCacheForTests();
  vi.mocked(api.fetchVoiceCapability).mockReset();
});

describe("useVoiceCapability", () => {
  it("starts undefined and resolves to the capability (non-blocking probe)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    const { result } = renderHook(() => useVoiceCapability());
    // Composer renders immediately: the hook returns undefined before the probe resolves.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual(STT));
    expect(supportsDictation(result.current)).toBe(true);
  });

  it("shares one fetch across multiple mounts (module-cached single flight)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    const a = renderHook(() => useVoiceCapability());
    const b = renderHook(() => useVoiceCapability());
    const c = renderHook(() => useVoiceCapability());
    await waitFor(() => {
      expect(a.result.current).toEqual(STT);
      expect(b.result.current).toEqual(STT);
      expect(c.result.current).toEqual(STT);
    });
    expect(api.fetchVoiceCapability).toHaveBeenCalledTimes(1);
  });

  it("fails safe to undefined when the probe rejects (no broken affordance)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useVoiceCapability());
    // Give the rejected promise a chance to settle; the hook must stay undefined.
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBeUndefined();
    expect(supportsDictation(result.current)).toBe(false);
  });
});

describe("supportsDictation", () => {
  it("is true only when available and speechToText", () => {
    expect(supportsDictation(STT)).toBe(true);
  });

  it("is false for an unavailable resolution", () => {
    expect(supportsDictation(NONE)).toBe(false);
  });

  it("is false for an unresolved (undefined) probe", () => {
    expect(supportsDictation(undefined)).toBe(false);
  });

  it("is false when available but speech-to-text is not advertised", () => {
    expect(
      supportsDictation({
        ...STT,
        profile: "speech-output",
        capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
      }),
    ).toBe(false);
  });
});

const SPEECH_OUTPUT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-output",
  capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  providerLocality: "azure-foundry",
};

const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  providerLocality: "azure-foundry",
};

describe("supportsSpeechOutput", () => {
  it("is true for the speech-output profile advertising speech output", () => {
    expect(supportsSpeechOutput(SPEECH_OUTPUT)).toBe(true);
  });

  it("is true for full-realtime (which also speaks)", () => {
    expect(supportsSpeechOutput(FULL_REALTIME)).toBe(true);
  });

  it("is false for STT-only — dictation does not imply the assistant can speak (AC1)", () => {
    expect(supportsSpeechOutput(STT)).toBe(false);
  });

  it("is false for a no-voice deployment", () => {
    expect(supportsSpeechOutput(NONE)).toBe(false);
  });

  it("is false for an unresolved (undefined) probe", () => {
    expect(supportsSpeechOutput(undefined)).toBe(false);
  });

  it("is false when the profile claims speech-output but the flag is not advertised", () => {
    expect(
      supportsSpeechOutput({
        ...SPEECH_OUTPUT,
        capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
      }),
    ).toBe(false);
  });

  it("is false when the speechOutput flag is set but the profile has not elected playback", () => {
    expect(
      supportsSpeechOutput({
        ...STT,
        capabilities: { speechToText: true, speechOutput: true, realtimeVoice: false },
      }),
    ).toBe(false);
  });
});
