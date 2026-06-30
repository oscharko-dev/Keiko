// Issue #1556 — streamed assistant-speech sink. The PCM byte→sample conversion (the tricky part:
// little-endian decoding + carrying a sample split across network chunks) is unit-tested directly; the
// browser sink is verified to be inert without WebAudio (jsdom), where the engine falls back to the
// buffered path. The streaming wiring itself is exercised through useAssistantSpeech with a fake sink.

import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when WebAudio/AudioWorklet is unavailable (jsdom → buffered fallback)", () => {
    expect(createBrowserAssistantSpeechStreamingSink()).toBeUndefined();
  });

  it("closes the AudioContext on dispose and creates fresh WebAudio resources after disposal", async () => {
    const contexts: { close: ReturnType<typeof vi.fn>; suspend: ReturnType<typeof vi.fn> }[] = [];
    const nodes: {
      disconnect: ReturnType<typeof vi.fn>;
      port: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    }[] = [];

    vi.stubGlobal(
      "AudioContext",
      class {
        readonly audioWorklet = { addModule: vi.fn(async () => {}) };
        readonly destination = {};
        readonly close = vi.fn(async () => {});
        readonly resume = vi.fn(async () => {});
        readonly suspend = vi.fn(async () => {});
        constructor(_options?: AudioContextOptions) {
          contexts.push({ close: this.close, suspend: this.suspend });
        }
      },
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        readonly port = { postMessage: vi.fn(), close: vi.fn() };
        readonly connect = vi.fn();
        readonly disconnect = vi.fn();
        constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
          nodes.push({ disconnect: this.disconnect, port: this.port });
        }
      },
    );

    const sink = createBrowserAssistantSpeechStreamingSink();
    expect(sink).toBeDefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      sink?.play({ text: "Hello" }, aborted.signal, {
        onStart: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);

    sink?.dispose();
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(null);
    expect(nodes[0]?.port.close).toHaveBeenCalledTimes(1);
    expect(nodes[0]?.disconnect).toHaveBeenCalledTimes(1);

    const abortedAgain = new AbortController();
    abortedAgain.abort();
    await sink?.play({ text: "Again" }, abortedAgain.signal, {
      onStart: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    });
    expect(contexts).toHaveLength(2);
  });
});
