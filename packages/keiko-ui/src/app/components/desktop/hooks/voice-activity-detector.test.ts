// Issue #1556 — VAD decision logic. The pure `VoiceActivityState` is exhaustively unit-tested here;
// the WebAudio glue (createBrowserVoiceActivityDetector) is verified only to be inert without WebAudio
// (jsdom), since its analyser sampling cannot be driven without a real AudioContext.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserVoiceActivityDetector,
  VoiceActivityState,
  type VoiceActivityThresholds,
} from "./voice-activity-detector";

const T: VoiceActivityThresholds = { rmsThreshold: 0.1, onsetMs: 100, trailingSilenceMs: 300 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VoiceActivityState", () => {
  it("fires speech-onset only after sustained above-threshold energy", () => {
    const s = new VoiceActivityState(T);
    expect(s.feed(0.5, 50)).toBeUndefined(); // 50ms < onsetMs
    expect(s.feed(0.5, 50)).toBe("speech-onset"); // 100ms reached
    expect(s.feed(0.5, 50)).toBeUndefined(); // already past onset
  });

  it("does not fire onset for a sub-threshold blip (debounce resets on a quiet sample)", () => {
    const s = new VoiceActivityState(T);
    expect(s.feed(0.5, 50)).toBeUndefined();
    expect(s.feed(0.0, 50)).toBeUndefined(); // resets the above-threshold accumulator
    expect(s.feed(0.5, 50)).toBeUndefined(); // only 50ms again
  });

  it("fires end-of-turn after a trailing silence that follows speech", () => {
    const s = new VoiceActivityState(T);
    expect(s.feed(0.5, 100)).toBe("speech-onset");
    expect(s.feed(0.0, 100)).toBeUndefined(); // 100ms silence
    expect(s.feed(0.0, 100)).toBeUndefined(); // 200ms
    expect(s.feed(0.0, 100)).toBe("end-of-turn"); // 300ms >= trailingSilenceMs
  });

  it("never fires end-of-turn without prior speech (initial silence is not a turn)", () => {
    const s = new VoiceActivityState(T);
    for (let i = 0; i < 20; i += 1) {
      expect(s.feed(0.0, 100)).toBeUndefined();
    }
  });

  it("resets after end-of-turn so a later utterance is detected afresh", () => {
    const s = new VoiceActivityState(T);
    s.feed(0.5, 100); // onset
    s.feed(0.0, 100);
    s.feed(0.0, 100);
    expect(s.feed(0.0, 100)).toBe("end-of-turn");
    expect(s.feed(0.5, 100)).toBe("speech-onset"); // new utterance
  });

  it("keeps the turn open across a brief mid-speech pause shorter than the silence window", () => {
    const s = new VoiceActivityState(T);
    s.feed(0.5, 100); // onset
    expect(s.feed(0.0, 100)).toBeUndefined(); // 100ms pause
    expect(s.feed(0.5, 100)).toBeUndefined(); // speech resumes → silence accumulator resets
    expect(s.feed(0.0, 100)).toBeUndefined();
    expect(s.feed(0.0, 100)).toBeUndefined();
    expect(s.feed(0.0, 100)).toBe("end-of-turn"); // a full 300ms pause finally ends it
  });

  it("uses adaptive noise floor to reject stationary room noise above the static gate", () => {
    const s = new VoiceActivityState({
      rmsThreshold: 0.014,
      onsetMs: 100,
      trailingSilenceMs: 300,
      adaptiveNoiseFloor: true,
      noiseFloorMultiplier: 2.2,
      noiseFloorMinRms: 0.004,
      noiseFloorMaxRms: 0.05,
    });
    for (let i = 0; i < 10; i += 1) {
      expect(s.feed(0.02, 50)).toBeUndefined();
    }
    expect(s.feed(0.08, 50)).toBeUndefined();
    expect(s.feed(0.08, 50)).toBe("speech-onset");
  });
});

describe("createBrowserVoiceActivityDetector", () => {
  it("returns an inert monitor when WebAudio is unavailable (jsdom) without throwing", () => {
    const detector = createBrowserVoiceActivityDetector(T);
    const onEvent = vi.fn();
    const monitor = detector.start({} as unknown as MediaStream, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
    expect(() => monitor.stop()).not.toThrow();
  });

  it("returns an inert monitor when WebAudio cannot attach the supplied stream", () => {
    const close = vi.fn(async () => {});
    class ThrowingAudioContext {
      readonly close = close;
      createMediaStreamSource(): never {
        throw new Error("invalid stream");
      }
    }
    vi.stubGlobal("AudioContext", ThrowingAudioContext);
    const detector = createBrowserVoiceActivityDetector(T);
    const onEvent = vi.fn();

    const monitor = detector.start({} as unknown as MediaStream, onEvent);

    expect(onEvent).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => monitor.stop()).not.toThrow();
  });
});
