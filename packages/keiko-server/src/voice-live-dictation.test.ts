// Unit coverage for the pure request-shape helpers in the live dictation control plane (Keiko
// Voice P3). The WebSocket upgrade/session machinery itself is exercised end to end elsewhere
// (voice-control-ws.test.ts); this file targets the small standalone validators.

import { describe, expect, it } from "vitest";
import {
  liveDictationSessionAtCap,
  liveDictationSocketExceedsCap,
  MAX_ACTIVE_LIVE_DICTATION_SESSIONS,
  MAX_OPEN_LIVE_DICTATION_SOCKETS,
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

describe("live dictation admission limits (#3190)", () => {
  it("caps only validated sessions at the sibling realtime limit", () => {
    expect(MAX_ACTIVE_LIVE_DICTATION_SESSIONS).toBe(64);
    expect(liveDictationSessionAtCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS - 1)).toBe(false);
    expect(liveDictationSessionAtCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS)).toBe(true);
  });

  it("keeps a separate, looser cap on raw sockets", () => {
    expect(MAX_OPEN_LIVE_DICTATION_SOCKETS).toBe(MAX_ACTIVE_LIVE_DICTATION_SESSIONS * 4);
    expect(liveDictationSocketExceedsCap(MAX_OPEN_LIVE_DICTATION_SOCKETS)).toBe(false);
    expect(liveDictationSocketExceedsCap(MAX_OPEN_LIVE_DICTATION_SOCKETS + 1)).toBe(true);
  });
});
