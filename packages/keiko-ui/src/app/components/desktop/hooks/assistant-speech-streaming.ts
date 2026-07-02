// Issue #1556 — streamed assistant-speech playback via an AudioWorklet PCM sink. Replaces the buffered
// whole-clip <audio> path (which cannot start until the entire MP3 is synthesized + transferred) with a
// start-on-first-chunk path: the BFF streams raw PCM, the bytes are fed to the keiko-playback worklet,
// and audio begins after a small jitter prime. Barge-in is sub-frame (post `null` to flush the queue),
// and the worklet reports a precise media position for the interrupt offset.
//
// It is an injectable seam (like the dictation recorder and realtime audio sink): production wires a
// real AudioContext + worklet; the factory returns `undefined` when WebAudio/AudioWorklet is
// unavailable (e.g. jsdom under test, or an old browser), and the caller falls back to the buffered
// path. Raw audio is transient render-thread data and is never persisted.

import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import { streamAssistantSpeech } from "@/lib/api";

export interface AssistantSpeechStreamHandlers {
  // Fired when audible output actually begins (the worklet confirms it produced samples).
  readonly onStart: () => void;
  // Fired at natural completion (the stream ended and the buffer drained).
  readonly onEnded: () => void;
  // Fired on any non-cancellation failure; the written answer stays visible (AC4).
  readonly onError: () => void;
}

export interface AssistantSpeechStreamingSink {
  // Streams + plays `input`. Resolves true when this sink took over playback (the caller must NOT also
  // run the buffered path); false when streaming is unsupported up front (caller falls back). An abort
  // mid-stream resolves true (engaged) and is treated as a silent cancel, not an error.
  play(
    input: { readonly text: string; readonly persona?: VoicePersona },
    signal: AbortSignal,
    handlers: AssistantSpeechStreamHandlers,
  ): Promise<boolean>;
  // Immediate flush for stop / mute / interrupt (barge-in).
  stop(): void;
  // Live media position in ms (frames played ÷ sample rate), or undefined when nothing has played.
  positionMs(): number | undefined;
  // Final teardown for unmount/session disposal. After this call the sink must not reuse its
  // AudioContext or AudioWorkletNode; a later playback creates fresh WebAudio resources.
  dispose(): void;
}

// The provider streams 24 kHz mono signed-16-bit PCM (the fastest format to first audio). The worklet
// plays samples 1:1 at the AudioContext rate, so the context is created at the same rate (no resample).
const TARGET_SAMPLE_RATE = 24_000;
// ~100ms jitter buffer primed before the first output, so the first chunks never underrun.
const PRIME_FRAMES = 2_400;
const WORKLET_URL = "/keiko-playback-worklet.js";
const WORKLET_NAME = "keiko-playback";

function streamingSupported(): boolean {
  return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Converts a little-endian PCM16 byte chunk to Int16 samples, carrying any trailing odd byte forward so
// a sample split across two network chunks is never corrupted. Returns the samples and the new leftover.
export function pcmBytesToInt16(
  chunk: Uint8Array,
  leftover: Uint8Array | undefined,
): { samples: Int16Array; leftover: Uint8Array | undefined } {
  let bytes = chunk;
  if (leftover !== undefined && leftover.length > 0) {
    const merged = new Uint8Array(leftover.length + chunk.length);
    merged.set(leftover);
    merged.set(chunk, leftover.length);
    bytes = merged;
  }
  const usable = bytes.length - (bytes.length % 2);
  const nextLeftover = usable < bytes.length ? bytes.slice(usable) : undefined;
  const samples = new Int16Array(usable / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return { samples, leftover: nextLeftover };
}

export function createBrowserAssistantSpeechStreamingSink():
  AssistantSpeechStreamingSink | undefined {
  if (!streamingSupported()) {
    return undefined;
  }
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let positionFrames = 0;

  async function ensureNode(): Promise<AudioWorkletNode> {
    if (node !== undefined) {
      return node;
    }
    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const workletNode = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      workletNode.connect(ctx.destination);
      context = ctx;
      node = workletNode;
      return workletNode;
    } catch (error) {
      await ctx.close().catch(() => {
        // close failed while setup already failed; do not retain the context for reuse
      });
      throw error;
    }
  }

  function closeContext(): void {
    const currentNode = node;
    const currentContext = context;
    node = undefined;
    context = undefined;
    positionFrames = 0;
    currentNode?.port.postMessage(null);
    if (currentNode !== undefined) {
      currentNode.port.onmessage = null;
    }
    currentNode?.port.close?.();
    try {
      currentNode?.disconnect();
    } catch {
      // already disconnected
    }
    void currentContext?.close().catch(() => {
      // close failure must not leave a stale context/node eligible for reuse
    });
  }

  async function pump(
    workletNode: AudioWorkletNode,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    handlers: AssistantSpeechStreamHandlers,
  ): Promise<void> {
    const reader = body.getReader();
    let leftover: Uint8Array | undefined;
    let posted = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (signal.aborted) {
          await reader.cancel();
          return;
        }
        const { samples, leftover: rest } = pcmBytesToInt16(value, leftover);
        leftover = rest;
        if (samples.length > 0) {
          posted += samples.length;
          workletNode.port.postMessage(samples, [samples.buffer]);
        }
      }
      if (posted === 0) {
        // A 200 with no audio: degrade to the visible text rather than waiting on a stream that will
        // never play (the worklet emits no "ended" without samples).
        handlers.onError();
      } else {
        workletNode.port.postMessage({ type: "end" });
      }
    } catch {
      if (!signal.aborted) {
        handlers.onError();
      }
    }
  }

  return {
    async play(input, signal, handlers): Promise<boolean> {
      let workletNode: AudioWorkletNode;
      try {
        workletNode = await ensureNode();
      } catch {
        return false; // worklet/context unavailable → caller falls back to the buffered path
      }
      if (signal.aborted) {
        return true;
      }
      positionFrames = 0;
      let started = false;
      await context?.resume().catch(() => {
        // a context that cannot resume still receives data; autoplay policy resolves on the user gesture
      });
      workletNode.port.postMessage({ type: "config", primeFrames: PRIME_FRAMES });
      workletNode.port.onmessage = (event: MessageEvent): void => {
        const data = event.data as { type?: string; frames?: number };
        if (data.type === "position") {
          positionFrames = data.frames ?? positionFrames;
          if (!started) {
            started = true;
            handlers.onStart();
          }
        } else if (data.type === "ended") {
          handlers.onEnded();
        }
      };

      let response: Response;
      try {
        response = await streamAssistantSpeech(input, signal);
      } catch (error) {
        if (isAbortError(error)) {
          return true; // cancelled mid-flight — do not fall back
        }
        // Any up-front failure (provider error, network) before audio has started: fall back to the
        // buffered path so a turn is never lost and a stubbed/working buffered route still plays.
        return false;
      }
      if (response.body === null) {
        return false;
      }
      void pump(workletNode, response.body, signal, handlers);
      return true;
    },

    stop(): void {
      closeContext();
    },

    positionMs(): number | undefined {
      if (node === undefined || positionFrames === 0) {
        return undefined;
      }
      return Math.round((positionFrames / TARGET_SAMPLE_RATE) * 1000);
    },

    dispose(): void {
      closeContext();
    },
  };
}
