// Issue #1559 — mutation-robust coverage of the useVoiceDialogMode hook.
// Tests drive through all four capability profiles, the empty-personas edge case, localStorage
// persistence / stale-validation, SSR safety, and the enter / leave / selectPersona behaviours.
// No real React rendering is needed (all hook-only via renderHook).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceDialogMode } from "./useVoiceDialogMode";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";

// ─── Capability fixtures ────────────────────────────────────────────────────────
const PERSONAS: readonly VoicePersona[] = ["male", "female", "neutral"];

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
  availableVoicePersonas: [],
};

const SPEECH_OUTPUT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-output",
  capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

const FULL_REALTIME_EMPTY_PERSONAS: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: [],
};

const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: PERSONAS,
};

// Issue #1560 (ADR-0096 D3) — the STT+TTS fallback: a full-realtime deployment in a browser WITHOUT
// WebRTC media. Dialogue must STILL be offered (it runs over the STT+TTS turn loop). This is the defect
// the generalized availability gate fixes.
const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  ...FULL_REALTIME,
  transport: { websocketControl: true, webrtcMedia: false },
};

const STORAGE_KEY = "keiko.voice.dialog.persona";

beforeEach(() => {
  localStorage.clear();
  // The generalized availability gate (D3) requires a capture-capable browser; jsdom lacks both, so
  // stub them. The fallback availability is then a pure function of the resolution.
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

// ─── Availability gating ────────────────────────────────────────────────────────

describe("useVoiceDialogMode — availability gating", () => {
  it("is unavailable when capability is undefined (unresolved / failed probe)", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: undefined }));
    expect(result.current.available).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it("is unavailable for the 'none' profile", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: NONE }));
    expect(result.current.available).toBe(false);
  });

  it("is unavailable for the 'speech-to-text' (STT-only) profile", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: STT }));
    expect(result.current.available).toBe(false);
  });

  it("is unavailable for a 'speech-output' deployment (no user speech capture)", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: SPEECH_OUTPUT }));
    expect(result.current.available).toBe(false);
  });

  it("is unavailable when full-realtime has NO advertised personas", () => {
    const { result } = renderHook(() =>
      useVoiceDialogMode({ capability: FULL_REALTIME_EMPTY_PERSONAS }),
    );
    expect(result.current.available).toBe(false);
    expect(result.current.availablePersonas).toHaveLength(0);
  });

  it("is available when full-realtime has at least one persona AND browser capture (with WebRTC)", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.available).toBe(true);
    expect(result.current.availablePersonas).toEqual(PERSONAS);
  });

  it("is STILL available for full-realtime WITHOUT WebRTC media (the STT+TTS fallback fix, D3)", () => {
    const { result } = renderHook(() =>
      useVoiceDialogMode({ capability: FULL_REALTIME_NO_WEBRTC }),
    );
    expect(result.current.available).toBe(true);
  });

  it("is unavailable when the browser cannot capture audio, even for full-realtime", () => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.available).toBe(false);
  });
});

// ─── Persona defaults ────────────────────────────────────────────────────────────

describe("useVoiceDialogMode — persona default and persistence", () => {
  it("defaults to the first offered persona when no stored preference exists", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.persona).toBe("male");
  });

  it("restores a valid stored persona on mount", () => {
    localStorage.setItem(STORAGE_KEY, "neutral");
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.persona).toBe("neutral");
  });

  it("selectPersona updates the selection and writes to localStorage", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    act(() => result.current.selectPersona("female"));
    expect(result.current.persona).toBe("female");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("female");
  });

  it("selectPersona is a no-op for a persona not in the offered list", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    act(() => result.current.selectPersona("female"));
    act(() => result.current.selectPersona("not-a-persona" as VoicePersona));
    expect(result.current.persona).toBe("female");
  });
});

// ─── Stale / invalid stored persona ────────────────────────────────────────────

describe("useVoiceDialogMode — stale / invalid persona validation", () => {
  it("falls back to the first persona when the stored value is not a valid enum member", () => {
    localStorage.setItem(STORAGE_KEY, "INVALID");
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.persona).toBe("male");
  });

  it("falls back when the stored persona is no longer offered by the deployment", () => {
    // Store "neutral" but offer only male/female.
    localStorage.setItem(STORAGE_KEY, "neutral");
    const SUBSET: VoiceCapabilityResolution = {
      ...FULL_REALTIME,
      availableVoicePersonas: ["male", "female"],
    };
    const { result } = renderHook(() => useVoiceDialogMode({ capability: SUBSET }));
    expect(result.current.persona).toBe("male");
  });

  it("snaps the persona when availablePersonas changes to a list that excludes the current selection", () => {
    localStorage.setItem(STORAGE_KEY, "neutral");
    const { result, rerender } = renderHook(
      ({ cap }: { cap: VoiceCapabilityResolution }) => useVoiceDialogMode({ capability: cap }),
      { initialProps: { cap: FULL_REALTIME } },
    );
    expect(result.current.persona).toBe("neutral");

    const SUBSET: VoiceCapabilityResolution = {
      ...FULL_REALTIME,
      availableVoicePersonas: ["male", "female"],
    };
    rerender({ cap: SUBSET });
    // "neutral" was removed; should snap to first offered.
    expect(result.current.persona).toBe("male");
  });
});

// ─── SSR / no-window safety ────────────────────────────────────────────────────

describe("useVoiceDialogMode — SSR safety", () => {
  it("does not throw when localStorage is absent (SSR simulation)", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    try {
      // Simulate a sandboxed or server context where localStorage throws.
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("localStorage not available");
        },
      });
      expect(() =>
        renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME })),
      ).not.toThrow();
    } finally {
      if (orig) {
        Object.defineProperty(window, "localStorage", orig);
      }
    }
  });
});

// ─── Enter / leave ────────────────────────────────────────────────────────────────

describe("useVoiceDialogMode — enter / leave", () => {
  it("enter sets active to true when available", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    expect(result.current.active).toBe(false);
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
  });

  it("enter is a no-op when unavailable", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: NONE }));
    act(() => result.current.enter());
    expect(result.current.active).toBe(false);
  });

  it("leave resets active even when available", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: FULL_REALTIME }));
    act(() => result.current.enter());
    act(() => result.current.leave());
    expect(result.current.active).toBe(false);
  });

  it("forces active=false when the deployment becomes unavailable while the session is active", () => {
    const { result, rerender } = renderHook(
      ({ cap }: { cap: VoiceCapabilityResolution }) => useVoiceDialogMode({ capability: cap }),
      { initialProps: { cap: FULL_REALTIME } },
    );
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);

    // Deployment flips to none (e.g., provider deregistered mid-session).
    rerender({ cap: NONE });
    expect(result.current.active).toBe(false);
    expect(result.current.available).toBe(false);
  });

  it("active is always false when available is false", () => {
    const { result } = renderHook(() => useVoiceDialogMode({ capability: STT }));
    // Entering is a no-op; the returned active must be the `active && available` guard.
    act(() => {
      // Force-set internal state directly is not possible; just verify the returned value.
    });
    expect(result.current.active).toBe(false);
  });
});
