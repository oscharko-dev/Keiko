// Issue #1556 — streamed assistant-speech sink. The PCM byte→sample conversion (the tricky part:
// little-endian decoding + carrying a sample split across network chunks) is unit-tested directly; the
// browser sink is verified to be inert without WebAudio (jsdom), where the engine falls back to the
// buffered path. The streaming wiring itself is exercised through useAssistantSpeech with a fake sink.

import { describe, expect, it } from "vitest";
import {
  createBrowserAssistantSpeechStreamingSink,
  pcmBytesToInt16,
} from "./assistant-speech-streaming";

// Little-endian bytes for the samples [1, -1, 0x1234].
function leBytes(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

describe("pcmBytesToInt16", () => {
  it("decodes little-endian PCM16 bytes to Int16 samples", () => {
    const { samples, leftover } = pcmBytesToInt16(leBytes([1, -1, 0x1234, -32768]), undefined);
    expect(Array.from(samples)).toEqual([1, -1, 0x1234, -32768]);
    expect(leftover).toBeUndefined();
  });

  it("carries a trailing odd byte forward so a split sample is not corrupted", () => {
    const full = leBytes([0x1234, 0x55aa]); // 4 bytes
    // First chunk cuts the second sample in half (3 bytes), second chunk delivers the rest.
    const a = pcmBytesToInt16(full.slice(0, 3), undefined);
    expect(Array.from(a.samples)).toEqual([0x1234]);
    expect(a.leftover).toHaveLength(1);
    const b = pcmBytesToInt16(full.slice(3), a.leftover);
    expect(Array.from(b.samples)).toEqual([0x55aa]);
    expect(b.leftover).toBeUndefined();
  });

  it("yields no samples for a single leftover byte and keeps it", () => {
    const { samples, leftover } = pcmBytesToInt16(new Uint8Array([0x34]), undefined);
    expect(samples).toHaveLength(0);
    expect(leftover).toEqual(new Uint8Array([0x34]));
  });
});

describe("createBrowserAssistantSpeechStreamingSink", () => {
  it("returns undefined when WebAudio/AudioWorklet is unavailable (jsdom → buffered fallback)", () => {
    expect(createBrowserAssistantSpeechStreamingSink()).toBeUndefined();
  });
});
