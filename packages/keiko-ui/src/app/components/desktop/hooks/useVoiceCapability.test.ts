// Issue #495 — the non-blocking voice-capability probe. Verifies the hook resolves the capability,
// shares a single module-cached fetch across mounts (so the 3 composer slots never triple-probe),
// and fails safe to "no voice affordance" on a transport error.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVoiceCapabilityCacheForTests,
  supportsDictation,
  supportsSpeechOutput,
  useVoiceCapability,
} from "./useVoiceCapability";
import * as api from "@/lib/api";
import type { VoiceCapabilityResolution } from "@/lib/types";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

const NONE: VoiceCapabilityResolution = {
  available: false,
  profile: "none",
  capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: false, webrtcMedia: false },
  availableVoicePersonas: [],
  reason: "no-voice-provider",
};

beforeEach(() => {
  clearVoiceCapabilityCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceCapability", () => {
  it("starts undefined and resolves to the capability (non-blocking probe)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ voice: STT })));
    const { result } = renderHook(() => useVoiceCapability());
    // Composer renders immediately: the hook returns undefined before the probe resolves.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual(STT));
    expect(supportsDictation(result.current)).toBe(true);
  });

  it("shares one fetch across multiple mounts (module-cached single flight)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ voice: STT }));
    vi.stubGlobal("fetch", fetchMock);
    const a = renderHook(() => useVoiceCapability());
    const b = renderHook(() => useVoiceCapability());
    const c = renderHook(() => useVoiceCapability());
    await waitFor(() => {
      expect(a.result.current).toEqual(STT);
      expect(b.result.current).toEqual(STT);
      expect(c.result.current).toEqual(STT);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails safe to undefined when the probe rejects (no broken affordance)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { result } = renderHook(() => useVoiceCapability());
    // Give the rejected promise a chance to settle; the hook must stay undefined.
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBeUndefined();
    expect(supportsDictation(result.current)).toBe(false);
  });

  it("refreshes a mounted capability probe after gateway setup changes voice roles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ voice: STT }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          testedModelId: "chat",
          testedModelIds: ["chat"],
          providerCount: 1,
          models: [],
          config: { schemaVersion: "1", providers: [] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ voice: FULL_REALTIME }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVoiceCapability());
    await waitFor(() => expect(result.current).toEqual(STT));

    await act(async () => {
      await api.setupGateway({ deploymentNames: ["chat"] });
    });

    await waitFor(() => expect(result.current).toEqual(FULL_REALTIME));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("isolates invalidation listeners and snapshots the current subscriber cohort", async () => {
    const setupResponse = {
      ok: true,
      testedModelId: "chat",
      testedModelIds: ["chat"],
      providerCount: 1,
      models: [],
      config: { schemaVersion: "1", providers: [] },
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(setupResponse))),
    );
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const lateListener = vi.fn();
    const remainingListener = vi.fn();
    let unsubscribeThrowing = (): void => undefined;
    let unsubscribeLate = (): void => undefined;
    const throwingListener = vi.fn(() => {
      unsubscribeThrowing();
      unsubscribeLate = api.subscribeVoiceCapabilityInvalidation(lateListener);
      throw new Error("customer-content-must-not-escape");
    });
    unsubscribeThrowing = api.subscribeVoiceCapabilityInvalidation(throwingListener);
    const unsubscribeRemaining = api.subscribeVoiceCapabilityInvalidation(remainingListener);

    try {
      await expect(api.setupGateway({ deploymentNames: ["chat"] })).resolves.toEqual(setupResponse);
      expect(throwingListener).toHaveBeenCalledOnce();
      expect(remainingListener).toHaveBeenCalledOnce();
      expect(lateListener).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();
      const reported = reportError.mock.calls[0]?.[0];
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe("Voice capability invalidation listener failed.");
      expect((reported as Error).message).not.toContain("customer-content-must-not-escape");

      await expect(api.setupGateway({ deploymentNames: ["chat"] })).resolves.toEqual(setupResponse);
      expect(remainingListener).toHaveBeenCalledTimes(2);
      expect(lateListener).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      unsubscribeThrowing();
      unsubscribeRemaining();
      unsubscribeLate();
    }
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
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

const REALTIME_WITHOUT_TTS: VoiceCapabilityResolution = {
  ...FULL_REALTIME,
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
};

describe("supportsSpeechOutput", () => {
  it("is true for the speech-output profile advertising speech output", () => {
    expect(supportsSpeechOutput(SPEECH_OUTPUT)).toBe(true);
  });

  it("is true for full-realtime (which also speaks)", () => {
    expect(supportsSpeechOutput(FULL_REALTIME)).toBe(true);
  });

  it("is false for Realtime without an explicit speech-output provider", () => {
    expect(supportsSpeechOutput(REALTIME_WITHOUT_TTS)).toBe(false);
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
