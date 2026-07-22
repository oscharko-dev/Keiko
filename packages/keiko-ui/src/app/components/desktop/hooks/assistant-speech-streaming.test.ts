// Issue #1556 — streamed assistant-speech sink. The PCM byte→sample conversion (the tricky part:
// little-endian decoding + carrying a sample split across network chunks) is unit-tested directly; the
// browser sink is verified to be inert without WebAudio (jsdom), where the engine falls back to the
// buffered path. The streaming wiring itself is exercised through useAssistantSpeech with a fake sink.

import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAssistantSpeech } from "@/lib/api";
import {
  createBrowserAssistantSpeechStreamingSink,
  pcmBytesToInt16,
} from "./assistant-speech-streaming";

vi.mock("@/lib/api", () => ({ streamAssistantSpeech: vi.fn() }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stubPendingAudioWorklet(addModule: Promise<void>): {
  readonly contexts: Array<{
    readonly addModule: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  }>;
  readonly nodes: Array<{ readonly disconnect: ReturnType<typeof vi.fn> }>;
} {
  const contexts: Array<{
    readonly addModule: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  }> = [];
  const nodes: Array<{ readonly disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly addModule = vi.fn(() => addModule);
      readonly audioWorklet = { addModule: this.addModule };
      readonly destination = {};
      readonly close = vi.fn(() => Promise.resolve());
      readonly resume = vi.fn(() => Promise.resolve());
      constructor(_options?: AudioContextOptions) {
        contexts.push({ addModule: this.addModule, close: this.close });
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
        nodes.push({ disconnect: this.disconnect });
      }
    },
  );
  return { contexts, nodes };
}

interface DeferredResumeNode {
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly port: {
    readonly close: ReturnType<typeof vi.fn>;
    onmessage: ((event: MessageEvent) => void) | null;
    readonly postMessage: ReturnType<typeof vi.fn>;
  };
}

function stubDeferredAudioResume(resume: Promise<void>): {
  readonly contexts: Array<{
    readonly close: ReturnType<typeof vi.fn>;
    readonly resume: ReturnType<typeof vi.fn>;
  }>;
  readonly nodes: DeferredResumeNode[];
} {
  const contexts: Array<{
    readonly close: ReturnType<typeof vi.fn>;
    readonly resume: ReturnType<typeof vi.fn>;
  }> = [];
  const nodes: DeferredResumeNode[] = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
      readonly destination = {};
      readonly close = vi.fn(() => Promise.resolve());
      readonly resume = vi.fn(() => resume);
      constructor(_options?: AudioContextOptions) {
        contexts.push({ close: this.close, resume: this.resume });
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port: DeferredResumeNode["port"] = {
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
      };
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
        nodes.push({ disconnect: this.disconnect, port: this.port });
      }
    },
  );
  return { contexts, nodes };
}

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
    vi.mocked(streamAssistantSpeech).mockReset();
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

  it("reports a content-free diagnostic when AudioContext cleanup fails", async () => {
    const close = vi.fn(() => Promise.reject(new Error("customer-audio-detail")));
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    vi.stubGlobal(
      "AudioContext",
      class {
        readonly audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
        readonly destination = {};
        readonly close = close;
        readonly resume = vi.fn(() => Promise.resolve());
      },
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        readonly port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
        readonly connect = vi.fn();
        readonly disconnect = vi.fn();
      },
    );

    const sink = createBrowserAssistantSpeechStreamingSink();
    const controller = new AbortController();
    controller.abort();
    await sink?.play({ text: "Hello" }, controller.signal, {
      onStart: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    });
    sink?.dispose();
    sink?.dispose();
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    const reported = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("Assistant speech audio context cleanup failed.");
    expect((reported as Error).message).not.toContain("customer-audio-detail");
  });

  it.each(["stop", "dispose"] as const)(
    "invalidates and closes a pending AudioWorklet setup exactly once on %s",
    async (teardown) => {
      const addModule = deferred<void>();
      const { contexts, nodes } = stubPendingAudioWorklet(addModule.promise);
      const sink = createBrowserAssistantSpeechStreamingSink();
      const controller = new AbortController();
      const playback = sink?.play({ text: "Never synthesize" }, controller.signal, {
        onStart: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      });

      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.addModule).toHaveBeenCalledOnce();
      controller.abort();
      sink?.[teardown]();
      addModule.resolve();

      await expect(playback).resolves.toBe(true);
      expect(contexts[0]?.close).toHaveBeenCalledOnce();
      expect(nodes).toHaveLength(0);
      expect(streamAssistantSpeech).not.toHaveBeenCalled();
    },
  );

  it.each(["stop", "dispose"] as const)(
    "does not revive a playback invalidated during AudioContext resume on %s",
    async (teardown) => {
      const resume = deferred<void>();
      const { contexts, nodes } = stubDeferredAudioResume(resume.promise);
      vi.mocked(streamAssistantSpeech).mockRejectedValue(
        new DOMException("cancelled", "AbortError"),
      );
      const sink = createBrowserAssistantSpeechStreamingSink();
      const controller = new AbortController();
      const playback = sink?.play({ text: "Never request speech" }, controller.signal, {
        onStart: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      });
      await vi.waitFor(() => expect(contexts[0]?.resume).toHaveBeenCalledOnce());

      controller.abort();
      sink?.[teardown]();
      resume.resolve();

      await expect(playback).resolves.toBe(true);
      expect(nodes[0]?.port.postMessage.mock.calls).toEqual([[null]]);
      expect(nodes[0]?.port.onmessage).toBeNull();
      expect(nodes[0]?.port.close).toHaveBeenCalledOnce();
      expect(nodes[0]?.disconnect).toHaveBeenCalledOnce();
      expect(contexts[0]?.close).toHaveBeenCalledOnce();
      expect(streamAssistantSpeech).not.toHaveBeenCalled();
    },
  );

  it.each(["stop", "dispose"] as const)(
    "cancels a response that settles after playback was invalidated by %s",
    async (teardown) => {
      const { contexts, nodes } = stubDeferredAudioResume(Promise.resolve());
      const response = deferred<Response>();
      const cancelBody = vi.fn();
      vi.mocked(streamAssistantSpeech).mockReturnValue(response.promise);
      const sink = createBrowserAssistantSpeechStreamingSink();
      const controller = new AbortController();
      const playback = sink?.play({ text: "Cancel pending response" }, controller.signal, {
        onStart: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      });
      await vi.waitFor(() => expect(streamAssistantSpeech).toHaveBeenCalledOnce());

      controller.abort();
      sink?.[teardown]();
      response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelBody })));

      await expect(playback).resolves.toBe(true);
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(nodes[0]?.port.postMessage.mock.calls).toEqual([
        [{ type: "config", primeFrames: 2_400 }],
        [null],
      ]);
      expect(nodes[0]?.port.onmessage).toBeNull();
      expect(contexts[0]?.close).toHaveBeenCalledOnce();
    },
  );
});
