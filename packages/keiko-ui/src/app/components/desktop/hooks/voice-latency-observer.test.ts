// Voice latency observer — content-free timing layer. A fake clock makes every assertion deterministic.

import { describe, expect, it, vi } from "vitest";
import {
  createVoiceLatencyObserver,
  NOOP_VOICE_LATENCY_OBSERVER,
  type VoiceLatencyLeg,
  type VoiceLatencySample,
} from "./voice-latency-observer";

// A controllable monotonic clock.
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createVoiceLatencyObserver", () => {
  it("records marks relative to the first mark as non-negative integer milliseconds", () => {
    const clock = fakeClock();
    const observer = createVoiceLatencyObserver({ now: clock.now });

    observer.mark("mic_click");
    clock.advance(120);
    observer.mark("first_audio_level");

    expect(observer.snapshot()).toEqual([
      { mark: "mic_click", atMs: 0 },
      { mark: "first_audio_level", atMs: 120 },
    ]);
  });

  it("computes legs between the last occurrences of two marks", () => {
    const clock = fakeClock();
    const observer = createVoiceLatencyObserver({ now: clock.now });

    observer.mark("stop_pressed");
    clock.advance(340);
    observer.mark("stt_final");

    expect(observer.legMs("stop_pressed", "stt_final")).toBe(340);
    // Missing endpoint → undefined, never a guess.
    expect(observer.legMs("mic_click", "stt_final")).toBeUndefined();
  });

  it("auto-emits a content-free leg to the sink when the 'to' mark lands after a known 'from'", () => {
    const clock = fakeClock();
    const onLeg = vi.fn<(leg: VoiceLatencyLeg) => void>();
    const onMark = vi.fn<(sample: VoiceLatencySample) => void>();
    const observer = createVoiceLatencyObserver({ now: clock.now, sink: { onLeg, onMark } });

    observer.mark("mic_click");
    clock.advance(90);
    observer.mark("first_audio_level");

    expect(onLeg).toHaveBeenCalledWith({
      from: "mic_click",
      to: "first_audio_level",
      ms: 90,
    });
    // The sink only ever sees enum literals + integer ms — the privacy contract of the layer.
    const legArg = onLeg.mock.calls[0]?.[0];
    expect(Object.keys(legArg ?? {}).sort()).toEqual(["from", "ms", "to"]);
    expect(onMark).toHaveBeenCalledWith({ mark: "mic_click", atMs: 0 });
  });

  it("does not emit a leg whose 'from' was never recorded", () => {
    const clock = fakeClock();
    const onLeg = vi.fn<(leg: VoiceLatencyLeg) => void>();
    const observer = createVoiceLatencyObserver({ now: clock.now, sink: { onLeg } });

    // 'to' without its 'from' → no leg (interrupt_ack requires a prior interrupt_sent).
    observer.mark("interrupt_ack");
    expect(onLeg).not.toHaveBeenCalled();
  });

  it("measures the most recent cycle for repeated per-turn marks", () => {
    const clock = fakeClock();
    const observer = createVoiceLatencyObserver({ now: clock.now });

    observer.mark("interrupt_sent");
    clock.advance(200);
    observer.mark("interrupt_ack"); // first barge-in: 200ms
    clock.advance(500);
    observer.mark("interrupt_sent");
    clock.advance(140);
    observer.mark("interrupt_ack"); // second barge-in: 140ms

    expect(observer.legMs("interrupt_sent", "interrupt_ack")).toBe(140);
  });

  it("reset clears marks and the timing origin", () => {
    const clock = fakeClock();
    const observer = createVoiceLatencyObserver({ now: clock.now });
    observer.mark("mic_click");
    clock.advance(50);
    observer.reset();
    observer.mark("rtc_connected");
    expect(observer.snapshot()).toEqual([{ mark: "rtc_connected", atMs: 0 }]);
  });

  it("NOOP observer records nothing and returns undefined legs", () => {
    NOOP_VOICE_LATENCY_OBSERVER.mark("mic_click");
    expect(NOOP_VOICE_LATENCY_OBSERVER.snapshot()).toEqual([]);
    expect(NOOP_VOICE_LATENCY_OBSERVER.legMs("mic_click", "session_ready")).toBeUndefined();
  });
});
