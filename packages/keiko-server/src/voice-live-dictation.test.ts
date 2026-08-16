// Unit coverage for the pure request-shape helpers in the live dictation control plane (Keiko
// Voice P3). The WebSocket upgrade/session machinery itself is exercised end to end elsewhere
// (voice-control-ws.test.ts); this file targets the small standalone validators.

import { describe, expect, it } from "vitest";
import {
  liveDictationSessionExceedsCap,
  MAX_ACTIVE_LIVE_DICTATION_SESSIONS,
  resolveRequestedTranscriptionLanguage,
} from "./voice-live-dictation.js";

describe("resolveRequestedTranscriptionLanguage", () => {
  it("returns undefined when no language was requested", () => {
    expect(resolveRequestedTranscriptionLanguage(undefined)).toBeUndefined();
  });

  it("returns the validated hint when present and well-formed", () => {
    expect(resolveRequestedTranscriptionLanguage("en-US")).toBe("en-US");
  });

  it("returns null when a language was requested but is malformed", () => {
    expect(resolveRequestedTranscriptionLanguage("1")).toBeNull();
  });

  it("returns null when a language was requested but is not a string", () => {
    expect(resolveRequestedTranscriptionLanguage(42)).toBeNull();
  });
});

describe("liveDictationSessionExceedsCap (KEIKO-0342)", () => {
  it("mirrors the sibling voice-realtime cap and rejects only after the cap+1th admission", () => {
    // The admission check runs after the new socket is already in wss.clients, so the
    // predicate returns true only when the observed count STRICTLY exceeds the cap.
    // Matching voice-realtime.ts's MAX_ACTIVE_SESSIONS (64) is the shape the finding
    // called out; a future divergence would trip this pin.
    expect(MAX_ACTIVE_LIVE_DICTATION_SESSIONS).toBe(64);
    expect(liveDictationSessionExceedsCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS - 1)).toBe(false);
    expect(liveDictationSessionExceedsCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS)).toBe(false);
    expect(liveDictationSessionExceedsCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS + 1)).toBe(true);
  });
});
