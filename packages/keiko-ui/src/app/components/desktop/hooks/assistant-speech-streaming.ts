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
  // Creates and resumes the local playback context from the Voice-mode click. It never starts TTS or
  // plays audio; it only preserves the browser's user activation for later canonical speech.
  primeFromUserGesture(): void;
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
const AUDIO_CONTEXT_CLEANUP_ERROR = "Assistant speech audio context cleanup failed.";
const AUDIO_CONTEXT_RESUME_ERROR = "Assistant speech audio context resume failed.";

function streamingSupported(): boolean {
  return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class AssistantSpeechSetupInvalidatedError extends Error {}

interface AssistantSpeechNodeLease {
  readonly context: AudioContext;
  readonly generation: number;
  readonly node: AudioWorkletNode;
}

interface AssistantSpeechContextLease {
  readonly context: AudioContext;
  readonly generation: number;
}

interface AssistantSpeechPumpControl {
  backpressured: boolean;
  cancel: () => void;
}

function reportAudioContextResumeFailure(): void {
  window.reportError(new Error(AUDIO_CONTEXT_RESUME_ERROR));
}

async function resumeAudioContext(context: AudioContext): Promise<void> {
  try {
    await context.resume();
  } catch {
    reportAudioContextResumeFailure();
  }
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
  let lifecycleGeneration = 0;
  let setupPromise: Promise<AssistantSpeechNodeLease> | undefined;
  const contextClosures = new WeakMap<AudioContext, Promise<void>>();

  function closeAudioContextOnce(ctx: AudioContext): Promise<void> {
    const activeClosure = contextClosures.get(ctx);
    if (activeClosure !== undefined) return activeClosure;
    const closure = ctx.close().catch(() => {
      window.reportError(new Error(AUDIO_CONTEXT_CLEANUP_ERROR));
    });
    contextClosures.set(ctx, closure);
    return closure;
  }

  function releaseWorkletNode(workletNode: AudioWorkletNode | undefined): void {
    workletNode?.port.postMessage(null);
    if (workletNode !== undefined) workletNode.port.onmessage = null;
    workletNode?.port.close?.();
    try {
      workletNode?.disconnect();
    } catch {
      // already disconnected
    }
  }

  function setupIsCurrent(ctx: AudioContext, generation: number): boolean {
    return context === ctx && lifecycleGeneration === generation;
  }

  async function initializeNode(
    ctx: AudioContext,
    generation: number,
  ): Promise<AssistantSpeechNodeLease> {
    let candidate: AudioWorkletNode | undefined;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      if (!setupIsCurrent(ctx, generation)) throw new AssistantSpeechSetupInvalidatedError();
      candidate = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      candidate.connect(ctx.destination);
      if (!setupIsCurrent(ctx, generation)) throw new AssistantSpeechSetupInvalidatedError();
      node = candidate;
      return { context: ctx, generation, node: candidate };
    } catch (error) {
      if (node !== candidate) releaseWorkletNode(candidate);
      if (context === ctx) context = undefined;
      await closeAudioContextOnce(ctx);
      throw error;
    }
  }

  function ensureContext(): AssistantSpeechContextLease | undefined {
    if (context !== undefined) {
      return { context, generation: lifecycleGeneration };
    }
    let nextContext: AudioContext;
    try {
      nextContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      // Priming is best-effort and playback can still use the buffered fallback.
      return undefined;
    }
    context = nextContext;
    return { context: nextContext, generation: lifecycleGeneration };
  }

  async function ensureNode(): Promise<AssistantSpeechNodeLease> {
    if (node !== undefined && context !== undefined) {
      return { context, generation: lifecycleGeneration, node };
    }
    if (setupPromise !== undefined) return setupPromise;
    const lease = ensureContext();
    if (lease === undefined) {
      throw new Error("Assistant speech audio context is unavailable.");
    }
    const pending = initializeNode(lease.context, lease.generation);
    setupPromise = pending;
    try {
      return await pending;
    } finally {
      if (setupPromise === pending) setupPromise = undefined;
    }
  }

  function closeContext(): void {
    const currentNode = node;
    const currentContext = context;
    lifecycleGeneration += 1;
    setupPromise = undefined;
    node = undefined;
    context = undefined;
    positionFrames = 0;
    releaseWorkletNode(currentNode);
    if (currentContext !== undefined) void closeAudioContextOnce(currentContext);
  }

  function leaseIsCurrent(lease: AssistantSpeechNodeLease, signal: AbortSignal): boolean {
    return (
      !signal.aborted && setupIsCurrent(lease.context, lease.generation) && node === lease.node
    );
  }

  async function cancelResponseBody(response: Response): Promise<void> {
    if (response.body === null) return;
    await response.body.cancel().catch(() => {
      // a stale playback is already detached; cancellation remains best-effort
    });
  }

  async function pump(
    workletNode: AudioWorkletNode,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    handlers: AssistantSpeechStreamHandlers,
    control: AssistantSpeechPumpControl,
  ): Promise<void> {
    const reader = body.getReader();
    control.cancel = (): void => {
      void reader.cancel().catch(() => {
        // Playback has already failed closed; releasing the detached stream is best-effort.
      });
    };
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
        if (control.backpressured) {
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
      if (control.backpressured) {
        return;
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

  function attachWorkletMessageHandler(
    workletNode: AudioWorkletNode,
    control: AssistantSpeechPumpControl,
    handlers: AssistantSpeechStreamHandlers,
  ): void {
    let started = false;
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
      } else if (data.type === "backpressure" && !control.backpressured) {
        control.backpressured = true;
        control.cancel();
        closeContext();
        handlers.onError();
      }
    };
  }

  return {
    primeFromUserGesture(): void {
      const lease = ensureContext();
      if (lease === undefined) return;
      void resumeAudioContext(lease.context);
      void ensureNode().catch(() => {
        // A later play attempt either retries setup or selects the buffered fallback.
      });
    },

    async play(input, signal, handlers): Promise<boolean> {
      let lease: AssistantSpeechNodeLease;
      try {
        lease = await ensureNode();
      } catch (error) {
        if (signal.aborted || error instanceof AssistantSpeechSetupInvalidatedError) return true;
        return false; // worklet/context unavailable → caller falls back to the buffered path
      }
      if (!leaseIsCurrent(lease, signal)) return true;
      positionFrames = 0;
      // AudioContext.resume() may stay pending until the browser's autoplay policy releases output.
      // Starting provider synthesis must not wait behind that browser-local gate: PCM can queue in the
      // worklet and begin as soon as the context runs.
      void resumeAudioContext(lease.context);
      const workletNode = lease.node;
      const pumpControl: AssistantSpeechPumpControl = {
        backpressured: false,
        cancel: () => undefined,
      };
      workletNode.port.postMessage({ type: "config", primeFrames: PRIME_FRAMES });
      attachWorkletMessageHandler(workletNode, pumpControl, handlers);

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
      if (!leaseIsCurrent(lease, signal)) {
        await cancelResponseBody(response);
        return true;
      }
      if (response.body === null) {
        return false;
      }
      void pump(workletNode, response.body, signal, handlers, pumpControl);
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
