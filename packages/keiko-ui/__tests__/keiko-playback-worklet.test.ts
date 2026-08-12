// Regression coverage for the gapless PCM playback AudioWorklet (audit KEIKO-0448) plus its
// bounded-ring-buffer + backpressure signalling fix (audit KEIKO-0471).
//
// public/keiko-playback-worklet.js is a hand-written browser script that runs in the dedicated
// AudioWorkletGlobalScope — it is never touched by the TS/eslint program (see the "public/ ships
// hand-written browser assets" carve-out in packages/keiko-ui/eslint.config.mjs) and it never
// `export`s its processor class; it only self-registers via the global `registerProcessor` call
// at import time. So the only way to reach the class under test is to stub `AudioWorkletProcessor`
// and `registerProcessor` on globalThis BEFORE importing the module, then read the class back off
// the arguments `registerProcessor` was called with.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface StubPort {
  readonly postMessage: ReturnType<typeof vi.fn<(message: unknown) => void>>;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

interface KeikoPlaybackProcessorInstance {
  readonly port: StubPort;
  readonly capacity: number;
  readonly size: number;
  readonly primed: boolean;
  process(inputs: readonly unknown[], outputs: readonly Float32Array[][]): boolean;
}

type KeikoPlaybackProcessorCtor = new () => KeikoPlaybackProcessorInstance;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The stub base class the real worklet's `class KeikoPlaybackProcessor extends
// AudioWorkletProcessor` needs to find on globalThis at class-definition time. Its shape mirrors
// exactly what the worklet's own constructor relies on: a `port` with `postMessage`/`onmessage`.
class StubAudioWorkletProcessor {
  readonly port: StubPort;
  constructor() {
    this.port = { postMessage: vi.fn<(message: unknown) => void>(), onmessage: null };
  }
}

let ProcessorCtor: KeikoPlaybackProcessorCtor;

beforeAll(async () => {
  const registerProcessor = vi.fn<(name: string, ctor: KeikoPlaybackProcessorCtor) => void>();
  vi.stubGlobal("registerProcessor", registerProcessor);
  vi.stubGlobal("AudioWorkletProcessor", StubAudioWorkletProcessor);

  // keiko-ui has allowJs off, and public/keiko-playback-worklet.js is a hand-written browser
  // script deliberately outside the TS program (see the "public/ ships hand-written browser
  // assets" carve-out in packages/keiko-ui/eslint.config.mjs). tsc still finds the real file on
  // disk, so it reports TS7016 "implicitly has an any type" rather than falling back to any
  // ambient `declare module` — a relative specifier that resolves to an actual file never
  // consults the ambient module table. We only need the side effect below (the module-scope
  // registerProcessor() call), so the missing static type is expected.
  // @ts-expect-error TS7016 — see comment above; the module intentionally has no declaration file.
  await import("../public/keiko-playback-worklet.js");

  const registeredCall = registerProcessor.mock.calls[0];
  if (registeredCall === undefined) {
    throw new Error("keiko-playback-worklet.js did not call registerProcessor() on import");
  }
  expect(registeredCall[0]).toBe("keiko-playback");
  ProcessorCtor = registeredCall[1];
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function makeProcessor(): KeikoPlaybackProcessorInstance {
  return new ProcessorCtor();
}

function send(processor: KeikoPlaybackProcessorInstance, data: unknown): void {
  processor.port.onmessage?.({ data });
}

function runQuantum(processor: KeikoPlaybackProcessorInstance, length: number): Float32Array {
  const channel = new Float32Array(length);
  processor.process([], [[channel]]);
  return channel;
}

function messagesOfType(processor: KeikoPlaybackProcessorInstance, type: string): unknown[] {
  return processor.port.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => isRecord(message) && message.type === type);
}

describe("keiko-playback-worklet — prime-threshold gating", () => {
  it("outputs silence and stays unprimed below the configured threshold", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 4 });
    send(processor, new Int16Array([16384, 16384, 16384])); // 3 samples < primeFrames(4)

    expect(processor.primed).toBe(false);
    const silent = runQuantum(processor, 8);
    expect(Array.from(silent)).toEqual(new Array<number>(8).fill(0));
  });

  it("starts producing real samples exactly once the threshold is reached", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 4 });
    send(processor, new Int16Array([16384, 16384, 16384]));
    runQuantum(processor, 8); // still below threshold; silence, buffered samples untouched

    send(processor, new Int16Array([16384])); // size now 4 >= primeFrames(4)
    expect(processor.primed).toBe(true);

    const audible = runQuantum(processor, 4);
    const expected = new Float32Array(4).fill(16384 / 32768);
    expect(audible).toEqual(expected);
  });
});

describe("keiko-playback-worklet — ring buffer wrap-around", () => {
  it("preserves FIFO sample order across the circular buffer boundary", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });

    // Prime and fully drain a single sample so the wrap loop below starts from size === 0.
    send(processor, new Int16Array([0]));
    runQuantum(processor, 1);

    const capacityBeforeWrap = processor.capacity;
    expect(capacityBeforeWrap).toBeGreaterThan(0);

    const chunk = 500;
    const cyclesToForceWrap = Math.ceil(capacityBeforeWrap / chunk) + 2;
    for (let cycle = 0; cycle < cyclesToForceWrap; cycle += 1) {
      const samples = new Int16Array(chunk);
      const expected = new Float32Array(chunk);
      for (let i = 0; i < chunk; i += 1) {
        // A deterministic, non-repeating-within-range pattern: if wrap corrupted the index
        // arithmetic (misreading a stale slot), the readback would land on the wrong value.
        const raw = ((cycle * chunk + i) % 65535) - 32768;
        samples[i] = raw;
        expected[i] = raw / 32768;
      }
      send(processor, samples);
      const drained = runQuantum(processor, chunk);
      expect(drained).toEqual(expected);
    }

    // The capacity discovered before the loop must be unchanged: the wrap was handled by head/tail
    // modulo arithmetic, not by growing the backing array large enough to never need to wrap.
    expect(processor.capacity).toBe(capacityBeforeWrap);
  });
});

describe("keiko-playback-worklet — bounded ring buffer capacity (KEIKO-0471)", () => {
  it("never grows the ring past its ceiling and reports the exact dropped count", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });

    const oversized = new Int16Array(5_000_000).fill(1); // far beyond any realistic ceiling
    send(processor, oversized);

    const cappedCapacity = processor.capacity;
    expect(cappedCapacity).toBeGreaterThan(0);
    expect(cappedCapacity).toBeLessThan(oversized.length);
    expect(processor.size).toBe(cappedCapacity); // filled exactly to the ceiling, never past it

    const expectedDropped = oversized.length - cappedCapacity;
    const backpressure = messagesOfType(processor, "backpressure");
    expect(backpressure).toEqual([{ type: "backpressure", dropped: expectedDropped }]);
  });

  it("keeps refusing growth and keeps signalling backpressure under sustained pressure", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });
    send(processor, new Int16Array(5_000_000).fill(1));
    const cappedCapacity = processor.capacity;

    const more = new Int16Array(1000).fill(1);
    send(processor, more);

    expect(processor.capacity).toBe(cappedCapacity); // ceiling holds under a second overflow
    const backpressure = messagesOfType(processor, "backpressure");
    expect(backpressure).toEqual([
      { type: "backpressure", dropped: 5_000_000 - cappedCapacity },
      { type: "backpressure", dropped: 1000 }, // the whole second chunk: buffer was already full
    ]);
  });

  it("does not drop or signal backpressure while comfortably under the ceiling", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });
    send(processor, new Int16Array(1000).fill(1));

    expect(messagesOfType(processor, "backpressure")).toEqual([]);
    expect(processor.size).toBe(1000);
  });
});

describe("keiko-playback-worklet — postMessage signalling on drain/end", () => {
  it("emits `ended` exactly once, only after the buffer fully drains past an `end` marker", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });
    send(processor, new Int16Array([16384, -16384]));
    send(processor, { type: "end" });

    runQuantum(processor, 1); // drains 1 of 2 buffered frames — not yet complete
    expect(messagesOfType(processor, "ended")).toEqual([]);

    runQuantum(processor, 4); // drains the remainder — natural completion
    expect(messagesOfType(processor, "ended")).toEqual([{ type: "ended" }]);

    runQuantum(processor, 4); // further quanta after completion must not re-fire "ended"
    expect(messagesOfType(processor, "ended")).toHaveLength(1);
  });

  it("reports playback position via postMessage once enough frames have been produced", () => {
    const processor = makeProcessor();
    send(processor, { type: "config", primeFrames: 1 });
    send(processor, new Int16Array(1300).fill(100));

    runQuantum(processor, 1300); // one quantum crossing the ~1200-frame report threshold

    expect(messagesOfType(processor, "position")).toEqual([{ type: "position", frames: 1300 }]);
  });
});
