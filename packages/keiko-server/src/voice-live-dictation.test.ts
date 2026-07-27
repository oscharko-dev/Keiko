// Unit coverage for the pure request-shape helpers in the live dictation control plane (Keiko
// Voice P3). The WebSocket upgrade/session machinery itself is exercised end to end elsewhere
// (voice-control-ws.test.ts); this file targets the small standalone validators.

import { describe, expect, it } from "vitest";
import { resolveRequestedTranscriptionLanguage } from "./voice-live-dictation.js";

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
