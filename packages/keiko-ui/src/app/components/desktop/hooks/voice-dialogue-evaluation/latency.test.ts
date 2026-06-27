// Issue #1563, Epic #1556 — AC2 latency / interruption evidence.
//
// Drives the REAL production floor-control reducer (`createVoiceTurnManager`, the single conversational
// truth the dialogue hook composes) through one STT+TTS dialogue turn and a barge-in, with an injected
// clock so provider time is deterministic. It proves three things:
//
//   1. Latency and interruption evidence IS recorded — the content-free turn-manager observer reports a
//      `latencyMs` for every floor transition, and the snapshot records `interruptions` / the interrupt
//      time. (AC2 "evidence is recorded".)
//   2. The evidence is content-free — every recorded event carries only closed-vocabulary enum labels
//      and integer counts; no transcript text, audio, or SDP can enter it. (AC2 "without storing raw
//      audio".)
//   3. The four named latency legs (start, end-of-turn, time-to-first-audio, interruption) measured
//      against the injected clock are within the documented production budgets, and an over-budget
//      reading is caught. (AC2 thresholds + the negative "teeth".)
//
// Wall-clock provider latency (STT transcribe, TTS synthesis) depends on the deployed speech provider
// and is closed in production by the headphone walkthrough recorded in the evaluation report; here those
// legs are injected via the controllable clock so the measurement + scoring path is proven deterministically.

import { describe, expect, it } from "vitest";
import {
  createVoiceTurnManager,
  type VoiceClock,
  type VoiceTurnInterruptEvent,
  type VoiceTurnTransitionEvent,
} from "../voice-turn-manager";
import {
  DIALOGUE_LATENCY_LEGS,
  scoreDialogueLatency,
  type DialogueLatencyObservation,
} from "./index";

// A monotonic clock whose value is advanced explicitly; `now()` is idempotent between advances so each
// measurement is deterministic. (Distinct from the turn-manager test's scriptedClock, which auto-steps.)
interface ProbeClock extends VoiceClock {
  advance(ms: number): void;
}

function makeProbeClock(): ProbeClock {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const ALLOWED_TRANSITION_KEYS = [
  "from",
  "to",
  "trigger",
  "floorHolder",
  "turnIndex",
  "latencyMs",
].sort();

const ALLOWED_INTERRUPT_KEYS = ["state", "atMs", "interruptions"].sort();

// One full dialogue turn + barge-in. `delays` injects the provider-dependent gaps so the four legs are
// deterministic; the helper returns the measured legs plus the recorded observer evidence.
function probeDialogueLatency(delays: {
  readonly startArmMs: number;
  readonly speakMs: number;
  readonly endOfTurnMs: number;
  readonly timeToFirstAudioMs: number;
  readonly interruptMs: number;
}): {
  readonly legs: readonly DialogueLatencyObservation[];
  readonly transitions: readonly VoiceTurnTransitionEvent[];
  readonly interrupts: readonly VoiceTurnInterruptEvent[];
  readonly stopPlaybackEmitted: boolean;
  readonly interruptions: number;
  readonly lastInterruptAtMs: number | undefined;
} {
  const clock = makeProbeClock();
  const transitions: VoiceTurnTransitionEvent[] = [];
  const interrupts: VoiceTurnInterruptEvent[] = [];
  const manager = createVoiceTurnManager({
    profile: "full-realtime",
    clock,
    observer: {
      onTransition: (event) => transitions.push(event),
      onInterrupt: (event) => interrupts.push(event),
    },
  });

  // start-latency: gesture → capture armed.
  const gestureAt = clock.now();
  clock.advance(delays.startArmMs);
  manager.apply({ kind: "user-speech-start" });
  const startLatency = clock.now() - gestureAt;

  // end-of-turn-latency: user stops speaking → transcript committed (after STT transcribe).
  clock.advance(delays.speakMs);
  const stopAt = clock.now();
  clock.advance(delays.endOfTurnMs);
  manager.apply({ kind: "user-end-of-turn" });
  const endOfTurnLatency = clock.now() - stopAt;

  // time-to-first-audio: answer settled → assistant speech begins (after TTS synthesis).
  const answerAt = clock.now();
  clock.advance(delays.timeToFirstAudioMs);
  manager.apply({ kind: "assistant-speech-start" });
  const timeToFirstAudio = clock.now() - answerAt;

  // interruption-latency: barge-in → playback stop (synchronous floor control).
  const bargeAt = clock.now();
  clock.advance(delays.interruptMs);
  const result = manager.apply({ kind: "user-interrupt", atMs: bargeAt });
  const interruptLatency = clock.now() - bargeAt;

  const snapshot = manager.snapshot();
  return {
    legs: [
      { leg: "start-latency", observedMs: startLatency },
      { leg: "end-of-turn-latency", observedMs: endOfTurnLatency },
      { leg: "time-to-first-audio", observedMs: timeToFirstAudio },
      { leg: "interruption-latency", observedMs: interruptLatency },
    ],
    transitions,
    interrupts,
    stopPlaybackEmitted: result.effects.includes("stop-playback"),
    interruptions: snapshot.interruptions,
    lastInterruptAtMs: snapshot.lastInterruptAtMs,
  };
}

const WITHIN_BUDGET = {
  startArmMs: 40,
  speakMs: 2000,
  endOfTurnMs: 25,
  timeToFirstAudioMs: 30,
  interruptMs: 0,
} as const;

describe("AC2 — latency / interruption evidence is recorded", () => {
  it("records a content-free latencyMs for every floor transition of a dialogue turn", () => {
    const probe = probeDialogueLatency(WITHIN_BUDGET);
    // idle→listening, listening→thinking, thinking→speaking, speaking→interrupted = 4 transitions.
    expect(probe.transitions).toHaveLength(4);
    for (const transition of probe.transitions) {
      expect(typeof transition.latencyMs).toBe("number");
      expect(Number.isFinite(transition.latencyMs)).toBe(true);
      expect(Object.keys(transition).sort()).toEqual(ALLOWED_TRANSITION_KEYS);
    }
  });

  it("records the interruption content-free (count + time, no payload)", () => {
    const probe = probeDialogueLatency(WITHIN_BUDGET);
    expect(probe.stopPlaybackEmitted).toBe(true);
    expect(probe.interruptions).toBe(1);
    expect(probe.lastInterruptAtMs).toBeTypeOf("number");
    expect(probe.interrupts).toHaveLength(1);
    expect(Object.keys(probe.interrupts[0] ?? {}).sort()).toEqual(ALLOWED_INTERRUPT_KEYS);
  });

  it("the recorded evidence contains no raw audio, transcript, or SDP (content-free by construction)", () => {
    const probe = probeDialogueLatency(WITHIN_BUDGET);
    const serialized = JSON.stringify({
      transitions: probe.transitions,
      interrupts: probe.interrupts,
      legs: probe.legs,
    });
    // No data-URL, base64 audio marker, SDP marker, or free transcript text can appear.
    expect(serialized).not.toMatch(/data:|audio\/|v=0|m=audio|transcript/iu);
  });
});

describe("AC2 — latency budgets", () => {
  it("scores every named leg within budget for a responsive turn (GO)", () => {
    const probe = probeDialogueLatency(WITHIN_BUDGET);
    expect(probe.legs.map((l) => l.leg)).toEqual([...DIALOGUE_LATENCY_LEGS]);
    const results = scoreDialogueLatency(probe.legs);
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
  });

  it("client-controlled legs (start, interruption) are deterministic and well under budget", () => {
    const probe = probeDialogueLatency(WITHIN_BUDGET);
    const byLeg = new Map(probe.legs.map((l) => [l.leg, l.observedMs]));
    expect(byLeg.get("start-latency")).toBe(WITHIN_BUDGET.startArmMs);
    expect(byLeg.get("interruption-latency")).toBe(0);
  });

  it("CATCHES an over-budget interruption and an over-budget end-of-turn (the teeth)", () => {
    const probe = probeDialogueLatency({
      ...WITHIN_BUDGET,
      endOfTurnMs: 5000, // > 4000 budget
      interruptMs: 500, // > 300 budget
    });
    const results = scoreDialogueLatency(probe.legs);
    const failing = results
      .filter((r) => r.outcome === "fail")
      .map((r) => r.leg)
      .sort();
    expect(failing).toEqual(["end-of-turn-latency", "interruption-latency"]);
  });
});
