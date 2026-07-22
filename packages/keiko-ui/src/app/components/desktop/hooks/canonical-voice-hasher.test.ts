import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalVoiceHasherIsReady,
  canonicalVoiceSha256Hex,
  clearCanonicalVoiceHasherForTests,
  prepareCanonicalVoiceHasher,
} from "./canonical-voice-hasher";

afterEach(() => {
  clearCanonicalVoiceHasherForTests();
});

describe("canonical voice hasher", () => {
  it("fails closed before the SHA-256 runtime has been prepared", () => {
    expect(canonicalVoiceHasherIsReady()).toBe(false);
    expect(() => canonicalVoiceSha256Hex("private transcript")).toThrow(
      "Canonical voice hashing is unavailable.",
    );
  });

  it("coalesces concurrent preparation and keeps hashing synchronous afterward", async () => {
    const sha256Hex = vi.fn(() => "digest");
    const loader = vi.fn(async () => ({ sha256Hex }));

    const first = prepareCanonicalVoiceHasher(loader);
    const second = prepareCanonicalVoiceHasher(loader);
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(loader).toHaveBeenCalledOnce();
    expect(canonicalVoiceSha256Hex("transcript")).toBe("digest");
    expect(sha256Hex).toHaveBeenCalledWith("transcript");
  });

  it("loads the cryptographic runtime and returns the standard SHA-256 digest", async () => {
    await prepareCanonicalVoiceHasher();

    expect(canonicalVoiceSha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("remains unprepared and retryable after a redacted load failure", async () => {
    const unavailable = vi.fn(() => Promise.reject(new Error("sensitive loader detail")));

    await expect(prepareCanonicalVoiceHasher(unavailable)).rejects.toThrow(
      "Canonical voice hashing is unavailable.",
    );
    expect(canonicalVoiceHasherIsReady()).toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();

    await prepareCanonicalVoiceHasher(async () => ({ sha256Hex: () => "recovered" }));
    expect(canonicalVoiceSha256Hex("transcript")).toBe("recovered");
  });
});
