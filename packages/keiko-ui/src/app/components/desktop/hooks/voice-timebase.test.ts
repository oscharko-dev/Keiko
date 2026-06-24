// Issue #498 (ADR-0061) — the Voice timing engine. Drives the engine with a deterministic SCRIPTED
// clock (an injected `{ now }` advanced by hand — no fake timers, no performance.now) and synthetic
// #496 control envelopes, exercising the full matrix: capability gating (none/STT/realtime),
// the phase state machine, jitter / packet-delay / duplicate / out-of-order / correction / interrupt
// ordering, the bounded replay ring + overflow + backpressure, ephemeral non-buffering, catch-up
// (including the truncated lossy window), reset, and the privacy invariant that no transcript text,
// SDP, or `message` object ever reaches the metrics observer (AC6).

import { describe, expect, it, vi } from "vitest";
import {
  VOICE_PROTOCOL_VERSION,
  type VoiceControlMessage,
  type VoiceControlMessageKind,
  type VoiceMediaTrackState,
  type VoicePlaybackState,
} from "@oscharko-dev/keiko-contracts";
import type { VoiceProfile, VoiceCapabilityResolution } from "@/lib/types";
import {
  createVoiceTimebaseEngine,
  createBrowserVoiceClock,
  resolutionToVoiceProfile,
  VOICE_TIMEBASE_REPLAY_CAPACITY,
  VOICE_TIMEBASE_BACKPRESSURE_HIGH,
  type VoiceClock,
  type VoiceTimebaseEngine,
  type VoiceTimebaseMetricsObserver,
} from "./voice-timebase";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

// A scripted clock: `now()` returns the next value in the script, then holds the last value once the
// script is exhausted. This makes receivedAtMs / latencyMs exact functions of the test, proving the
// engine reads no real clock.
function scriptedClock(values: readonly number[]): VoiceClock {
  let index = 0;
  return {
    now(): number {
      const value = values[Math.min(index, values.length - 1)] ?? 0;
      index += 1;
      return value;
    },
  };
}

// Build a valid control envelope for a kind. `extra` carries the per-kind payload fields. Every
// envelope shares the #496 shape (protocolVersion / sessionId / seq / direction / kind).
function makeMessage(
  kind: VoiceControlMessageKind,
  seq: number,
  extra: Record<string, unknown> = {},
): VoiceControlMessage {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId: "s",
    seq,
    direction: "host-to-client",
    kind,
    ...extra,
  } as VoiceControlMessage;
}

function committed(seq: number, text = "t"): VoiceControlMessage {
  return makeMessage("transcript.committed", seq, { text });
}

function partial(seq: number, text = "p"): VoiceControlMessage {
  return makeMessage("transcript.partial", seq, { text });
}

function track(seq: number, state: VoiceMediaTrackState): VoiceControlMessage {
  return makeMessage("media.track.state", seq, { track: "audio-in", state });
}

function playback(seq: number, state: VoicePlaybackState): VoiceControlMessage {
  return makeMessage("playback.state", seq, { state });
}

function makeEngine(
  profile: VoiceProfile,
  clock?: VoiceClock,
  observer?: VoiceTimebaseMetricsObserver,
): VoiceTimebaseEngine {
  return createVoiceTimebaseEngine({ profile, ...(clock ? { clock } : {}), observer });
}

// ─── AC1: capability gating — none / dormant ────────────────────────────────────
describe("voice-timebase — dormant profile (AC1)", () => {
  it("row 1: none rejects every ingest, stays dormant, and emits no metrics", () => {
    const observer: VoiceTimebaseMetricsObserver = {
      onIngest: vi.fn(),
      onOverflow: vi.fn(),
      onBackpressureChange: vi.fn(),
    };
    const engine = makeEngine("none", scriptedClock([10]), observer);

    const result = engine.ingest(committed(0));

    expect(result.outcome).toBe("not-allowed-for-profile");
    expect(result.snapshot.active).toBe(false);
    expect(result.snapshot.phase).toBe("dormant");
    expect(observer.onIngest).not.toHaveBeenCalled();
    expect(observer.onOverflow).not.toHaveBeenCalled();
    expect(observer.onBackpressureChange).not.toHaveBeenCalled();
  });

  it("row 2: none constructs dormant with empty buffers", () => {
    const snapshot = makeEngine("none").snapshot();
    expect(snapshot.phase).toBe("dormant");
    expect(snapshot.active).toBe(false);
    expect(snapshot.replayDepth).toBe(0);
  });
});

// ─── AC2: speech-to-text subset ─────────────────────────────────────────────────
describe("voice-timebase — speech-to-text subset (AC2)", () => {
  it("row 3: admits transcripts, rejects media-track (no realtime transport)", () => {
    const engine = makeEngine("speech-to-text", scriptedClock([10, 20, 30]));

    expect(engine.ingest(partial(0)).outcome).toBe("ignored-ephemeral");
    const committedResult = engine.ingest(committed(1));
    expect(committedResult.outcome).toBe("applied");
    expect(committedResult.snapshot.phase).toBe("transcribing");
    expect(committedResult.snapshot.lastCommittedSeq).toBe(1);

    expect(engine.ingest(track(2, "live")).outcome).toBe("not-allowed-for-profile");
  });
});

// ─── AC3: full-realtime admits everything; phase machine ────────────────────────
describe("voice-timebase — full-realtime phase machine (AC3)", () => {
  it("row 4: capturing -> transcribing -> responding -> idle across the stream", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20, 30, 40]));

    expect(engine.ingest(track(0, "live")).snapshot.phase).toBe("capturing");
    expect(engine.ingest(committed(1)).snapshot.phase).toBe("transcribing");
    expect(engine.ingest(playback(2, "playing")).snapshot.phase).toBe("responding");
    const last = engine.ingest(playback(3, "stopped"));
    expect(last.snapshot.phase).toBe("idle");
    expect(last.snapshot.highestAppliedSeq).toBe(3);
    expect(last.snapshot.captureState).toBe("live");
    expect(last.snapshot.playbackState).toBe("stopped");
  });
});

// ─── AC5: jitter / delay / dedup / ordering ─────────────────────────────────────
describe("voice-timebase — jitter & ordering (AC5)", () => {
  it("row 5: jittered clock deltas do not affect seq ordering; latency tracks the clock", () => {
    const observer = { onIngest: vi.fn() };
    // Clock readings: 5, 12, 62, 114 -> applied-to-applied deltas 0, 7, 50, 52.
    const engine = makeEngine("full-realtime", scriptedClock([5, 12, 62, 114]), observer);

    engine.ingest(committed(0));
    engine.ingest(committed(1));
    engine.ingest(committed(2));
    const last = engine.ingest(committed(3));

    expect(last.outcome).toBe("applied");
    expect(last.snapshot.highestAppliedSeq).toBe(3);
    const latencies = observer.onIngest.mock.calls.map((call) => call[0].latencyMs);
    expect(latencies).toEqual([0, 7, 50, 52]);
  });

  it("row 6: a delayed packet is still applied with a large latency; engine has no timers", () => {
    const observer = { onIngest: vi.fn() };
    const engine = makeEngine("full-realtime", scriptedClock([5, 1005]), observer);

    engine.ingest(committed(0));
    const delayed = engine.ingest(committed(1));

    expect(delayed.outcome).toBe("applied");
    expect(observer.onIngest.mock.calls[1]?.[0].latencyMs).toBe(1000);
  });

  it("row 7: a duplicate seq is a no-op that does not advance or buffer", () => {
    const observer = { onIngest: vi.fn() };
    const engine = makeEngine("full-realtime", scriptedClock([10, 20, 30]), observer);

    engine.ingest(playback(2, "playing"));
    const before = engine.snapshot();
    const second = engine.ingest(playback(2, "playing"));

    expect(second.outcome).toBe("duplicate");
    expect(second.snapshot.highestAppliedSeq).toBe(2);
    expect(second.snapshot.replayDepth).toBe(before.replayDepth);
    // Metrics fire for no-op ingests too (AC6 auditability): the duplicate is reported, not swallowed.
    expect(observer.onIngest.mock.calls[1]?.[0].outcome).toBe("duplicate");
  });

  it("row 8: an out-of-order (late) seq is rejected and not buffered", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    engine.ingest(playback(5, "playing"));
    const late = engine.ingest(committed(3));

    expect(late.outcome).toBe("out-of-order");
    expect(late.snapshot.phase).toBe("responding");
    expect(late.snapshot.highestAppliedSeq).toBe(5);
    expect(late.snapshot.replayDepth).toBe(1);
  });

  it("row 9: a discard correction is applied and both events are in the replay ring", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    engine.ingest(committed(5));
    const discarded = engine.ingest(makeMessage("transcript.discarded", 6));

    expect(discarded.outcome).toBe("applied");
    expect(discarded.snapshot.phase).toBe("transcribing");
    expect(discarded.snapshot.replayDepth).toBe(2);
    // The discard advances the applied seq but, unlike a commit, never touches lastCommittedSeq.
    expect(discarded.snapshot.highestAppliedSeq).toBe(6);
    expect(discarded.snapshot.lastCommittedSeq).toBe(5);
  });

  it("row 9b: partial then committed correction — partial never buffered, commit anchors", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    const partialResult = engine.ingest(partial(0));
    const committedResult = engine.ingest(committed(1));

    expect(partialResult.outcome).toBe("ignored-ephemeral");
    expect(committedResult.outcome).toBe("applied");
    // The partial stayed out of the replay ring; only the committed correction is retained.
    expect(committedResult.snapshot.replayDepth).toBe(1);
    expect(committedResult.snapshot.lastCommittedSeq).toBe(1);
    // The partial's clock reading is preserved on the snapshot, not overwritten by the commit.
    expect(committedResult.snapshot.lastPartialReceivedAtMs).toBe(10);
    const events = engine.catchUp({ sinceSeq: -1 }).events;
    expect(events.map((event) => event.kind)).toEqual(["transcript.committed"]);
  });

  it("row 10: a barge-in interrupt transitions to interrupted", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    engine.ingest(playback(7, "playing"));
    const interrupted = engine.ingest(makeMessage("control.interrupt", 8, { atMs: 42 }));

    expect(interrupted.outcome).toBe("applied");
    expect(interrupted.snapshot.phase).toBe("interrupted");
    expect(interrupted.snapshot.replayDepth).toBe(2);
    expect(interrupted.snapshot.highestAppliedSeq).toBe(8);
  });

  it("row 17: re-delivery on reconnect is deduplicated; highestAppliedSeq holds", () => {
    const engine = makeEngine("full-realtime");

    engine.ingest(committed(1));
    engine.ingest(committed(2));
    engine.ingest(committed(3));
    expect(engine.ingest(committed(1)).outcome).toBe("out-of-order");
    expect(engine.ingest(committed(2)).outcome).toBe("out-of-order");
    const last = engine.ingest(committed(3));
    expect(last.outcome).toBe("duplicate");
    expect(last.snapshot.highestAppliedSeq).toBe(3);
  });
});

// ─── AC4: replay ring, overflow, backpressure, ephemeral ────────────────────────
describe("voice-timebase — buffering & backpressure (AC4)", () => {
  it("row 11: overflow evicts oldest, caps depth at capacity, counts ascending", () => {
    const evicted: number[] = [];
    const observer: VoiceTimebaseMetricsObserver = {
      onOverflow: (event) => evicted.push(event.evictedSeq),
    };
    const engine = makeEngine("full-realtime", undefined, observer);

    for (let seq = 0; seq < 205; seq += 1) {
      engine.ingest(committed(seq));
    }

    const snapshot = engine.snapshot();
    expect(snapshot.replayDepth).toBe(200);
    expect(snapshot.overflowCount).toBe(5);
    expect(evicted).toEqual([0, 1, 2, 3, 4]);
  });

  it("row 12: depth 160 reports elevated; overflow flips to saturated, once each", () => {
    const levels: string[] = [];
    const observer: VoiceTimebaseMetricsObserver = {
      onBackpressureChange: (level) => levels.push(level),
    };
    const engine = makeEngine("full-realtime", undefined, observer);

    for (let seq = 0; seq < 160; seq += 1) {
      engine.ingest(committed(seq));
    }
    expect(engine.snapshot().backpressure).toBe("elevated");
    expect(levels).toEqual(["elevated"]);

    for (let seq = 160; seq < 201; seq += 1) {
      engine.ingest(committed(seq));
    }
    expect(engine.snapshot().backpressure).toBe("saturated");
    expect(levels).toEqual(["elevated", "saturated"]);
  });

  it("row 13: ephemeral signaling and partials are applied but never buffered", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    const sdp = engine.ingest(makeMessage("signal.sdp.offer", 0, { sdp: "v=0" }));
    expect(sdp.outcome).toBe("ignored-ephemeral");
    expect(sdp.snapshot.replayDepth).toBe(0);

    expect(sdp.snapshot.highestAppliedSeq).toBe(0);

    const partialResult = engine.ingest(partial(1));
    expect(partialResult.outcome).toBe("ignored-ephemeral");
    expect(partialResult.snapshot.replayDepth).toBe(0);
    expect(partialResult.snapshot.lastPartialReceivedAtMs).toBe(20);
    // Ephemeral messages still advance the applied seq so a later forward seq is not mistaken for stale.
    expect(partialResult.snapshot.highestAppliedSeq).toBe(1);

    expect(engine.catchUp({ sinceSeq: -1 }).events).toHaveLength(0);
  });

  it("row 11b: exactly capacity inserts fill without overflow; the next evicts the first", () => {
    let evictedSeq: number | undefined;
    const observer: VoiceTimebaseMetricsObserver = {
      onOverflow: (event) => {
        evictedSeq = event.evictedSeq;
      },
    };
    const engine = makeEngine("full-realtime", undefined, observer);

    for (let seq = 0; seq < VOICE_TIMEBASE_REPLAY_CAPACITY; seq += 1) {
      engine.ingest(committed(seq));
    }
    expect(engine.snapshot().replayDepth).toBe(VOICE_TIMEBASE_REPLAY_CAPACITY);
    expect(engine.snapshot().overflowCount).toBe(0);
    expect(evictedSeq).toBeUndefined();

    const overflow = engine.ingest(committed(VOICE_TIMEBASE_REPLAY_CAPACITY));
    expect(overflow.snapshot.replayDepth).toBe(VOICE_TIMEBASE_REPLAY_CAPACITY);
    expect(overflow.snapshot.overflowCount).toBe(1);
    expect(evictedSeq).toBe(0);
  });

  it("row 12b: depth 159 stays none; the 160th insert flips to elevated", () => {
    const engine = makeEngine("full-realtime");

    for (let seq = 0; seq < VOICE_TIMEBASE_BACKPRESSURE_HIGH - 1; seq += 1) {
      engine.ingest(committed(seq));
    }
    expect(engine.snapshot().replayDepth).toBe(VOICE_TIMEBASE_BACKPRESSURE_HIGH - 1);
    expect(engine.snapshot().backpressure).toBe("none");

    const crossing = engine.ingest(committed(VOICE_TIMEBASE_BACKPRESSURE_HIGH - 1));
    expect(crossing.snapshot.replayDepth).toBe(VOICE_TIMEBASE_BACKPRESSURE_HIGH);
    expect(crossing.snapshot.backpressure).toBe("elevated");
  });
});

// ─── AC3 / AC5: catch-up ────────────────────────────────────────────────────────
describe("voice-timebase — catch-up (AC3 / AC5)", () => {
  it("row 14: returns only replay-eligible events with seq > sinceSeq, ascending", () => {
    const engine = makeEngine("full-realtime");
    [1, 2, 3, 4].forEach((seq) => engine.ingest(committed(seq)));

    const result = engine.catchUp({ sinceSeq: 2 });

    expect(result.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(result.truncated).toBe(false);
  });

  it("row 15: a gap below the retained window reports truncated", () => {
    const engine = makeEngine("full-realtime");
    for (let seq = 0; seq < 205; seq += 1) {
      engine.ingest(committed(seq));
    }

    const result = engine.catchUp({ sinceSeq: 0 });

    expect(result.truncated).toBe(true);
  });

  it("row 16: catching up at the head returns nothing and preserves state", () => {
    const engine = makeEngine("full-realtime");
    [1, 2, 3, 4, 5].forEach((seq) => engine.ingest(committed(seq)));

    const result = engine.catchUp({ sinceSeq: 5 });

    expect(result.events).toHaveLength(0);
    expect(engine.snapshot().highestAppliedSeq).toBe(5);
  });

  it("row 15b: truncated keys on the actual evicted seq vs the anchor, not on retention", () => {
    const engine = makeEngine("full-realtime");
    // 205 inserts evict seqs 0..4 (lastEvictedSeq 4); the oldest retained is seq 5.
    for (let seq = 0; seq < VOICE_TIMEBASE_REPLAY_CAPACITY + 5; seq += 1) {
      engine.ingest(committed(seq));
    }

    // Anchor at 4: nothing ABOVE 4 was evicted, so no replay-eligible record above the anchor was lost.
    expect(engine.catchUp({ sinceSeq: 4 }).truncated).toBe(false);
    // Anchor at 3: seq 4 was evicted and is above the anchor — a real gap.
    expect(engine.catchUp({ sinceSeq: 3 }).truncated).toBe(true);
  });

  it("row 15c: an ephemeral seq gap with no eviction never reports truncated", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    // signal.sdp.offer (ephemeral) consumes seq 0 but never enters the ring; session.created (seq 1) does.
    engine.ingest(makeMessage("signal.sdp.offer", 0, { sdp: "v=0" }));
    engine.ingest(makeMessage("session.created", 1, { profile: "full-realtime" }));

    const result = engine.catchUp({ sinceSeq: -1 });
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("session.created");
  });
});

// ─── AC6: metrics carry no content ──────────────────────────────────────────────
describe("voice-timebase — content-free metrics (AC6)", () => {
  function captureAllArgs(observer: VoiceTimebaseMetricsObserver): unknown[] {
    const onIngest = observer.onIngest as ReturnType<typeof vi.fn>;
    const onOverflow = observer.onOverflow as ReturnType<typeof vi.fn>;
    const onBackpressureChange = observer.onBackpressureChange as ReturnType<typeof vi.fn>;
    return [...onIngest.mock.calls, ...onOverflow.mock.calls, ...onBackpressureChange.mock.calls];
  }

  it("row 18: transcript text never reaches the observer", () => {
    const observer: VoiceTimebaseMetricsObserver = {
      onIngest: vi.fn(),
      onOverflow: vi.fn(),
      onBackpressureChange: vi.fn(),
    };
    const engine = makeEngine("full-realtime", scriptedClock([10]), observer);

    engine.ingest(committed(0, "SENTINEL-XYZ"));

    const allArgs = captureAllArgs(observer);
    expect(JSON.stringify(allArgs)).not.toContain("SENTINEL-XYZ");
    const onIngest = observer.onIngest as ReturnType<typeof vi.fn>;
    const event = onIngest.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      kind: "transcript.committed",
      seq: 0,
      redaction: "reviewable-text",
    });
    expect(event).not.toHaveProperty("message");
    expect(event).not.toHaveProperty("text");
  });

  it("row 19: SDP material never reaches the observer; redaction is reported", () => {
    const observer: VoiceTimebaseMetricsObserver = {
      onIngest: vi.fn(),
      onOverflow: vi.fn(),
      onBackpressureChange: vi.fn(),
    };
    const engine = makeEngine("full-realtime", scriptedClock([10]), observer);

    engine.ingest(makeMessage("signal.sdp.offer", 0, { sdp: "SENTINEL-SDP-CANDIDATE" }));

    const allArgs = captureAllArgs(observer);
    expect(JSON.stringify(allArgs)).not.toContain("SENTINEL-SDP-CANDIDATE");
    const onIngest = observer.onIngest as ReturnType<typeof vi.fn>;
    expect(onIngest.mock.calls[0]?.[0].redaction).toBe("secret-bearing");
  });

  it("row 19b: partial-transcript text never reaches any observer argument", () => {
    const observer: VoiceTimebaseMetricsObserver = {
      onIngest: vi.fn(),
      onOverflow: vi.fn(),
      onBackpressureChange: vi.fn(),
    };
    const engine = makeEngine("full-realtime", scriptedClock([10]), observer);

    engine.ingest(partial(0, "SENTINEL-PARTIAL"));

    const allArgs = captureAllArgs(observer);
    expect(JSON.stringify(allArgs)).not.toContain("SENTINEL-PARTIAL");
    const onIngest = observer.onIngest as ReturnType<typeof vi.fn>;
    expect(onIngest.mock.calls[0]?.[0].redaction).toBe("reviewable-text");
  });
});

// ─── AC1/AC3: speech-output profile (playback + interrupt, no transcript-input) ──
describe("voice-timebase — speech-output subset (D8)", () => {
  it("row 22: rejects transcript.committed and signaling, admits playback into responding", () => {
    const engine = makeEngine("speech-output", scriptedClock([10, 20, 30]));

    expect(engine.ingest(committed(0)).outcome).toBe("not-allowed-for-profile");

    const played = engine.ingest(playback(1, "playing"));
    expect(played.outcome).toBe("applied");
    expect(played.snapshot.phase).toBe("responding");

    expect(engine.ingest(makeMessage("signal.sdp.offer", 2, { sdp: "v=0" })).outcome).toBe(
      "not-allowed-for-profile",
    );
  });
});

// ─── session.closed terminal phase ───────────────────────────────────────────────
describe("voice-timebase — session lifecycle phases", () => {
  it("row 23: session.closed maps to closed; a later session.created returns to idle", () => {
    const engine = makeEngine("full-realtime", scriptedClock([10, 20]));

    const closed = engine.ingest(makeMessage("session.closed", 0, { reason: "host-request" }));
    expect(closed.outcome).toBe("applied");
    expect(closed.snapshot.phase).toBe("closed");

    const reopened = engine.ingest(makeMessage("session.created", 1, { profile: "full-realtime" }));
    expect(reopened.snapshot.phase).toBe("idle");
  });
});

// ─── Reset, clock injection, adapter ─────────────────────────────────────────────
describe("voice-timebase — reset & determinism", () => {
  it("row 20: reset clears buffers, counters, and returns to the initial phase", () => {
    const engine = makeEngine("full-realtime");
    for (let seq = 0; seq < 205; seq += 1) {
      engine.ingest(committed(seq));
    }
    expect(engine.snapshot().overflowCount).toBe(5);

    engine.reset();

    const snapshot = engine.snapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.replayDepth).toBe(0);
    expect(snapshot.overflowCount).toBe(0);
    expect(snapshot.highestAppliedSeq).toBe(-1);
  });

  it("row 20b: reset on a none engine returns to dormant", () => {
    const engine = makeEngine("none");
    engine.reset();
    expect(engine.snapshot().phase).toBe("dormant");
  });

  it("row 21: scripted clock determines receivedAtMs / latencyMs exactly", () => {
    const observer = { onIngest: vi.fn() };
    const engine = makeEngine("full-realtime", scriptedClock([100, 175]), observer);

    engine.ingest(partial(0));
    engine.ingest(committed(1));

    expect(observer.onIngest.mock.calls[0]?.[0].latencyMs).toBe(0);
    expect(observer.onIngest.mock.calls[1]?.[0].latencyMs).toBe(75);
    // The partial's receivedAtMs surfaces on the snapshot, proving the scripted clock is the only source.
    expect(engine.snapshot().lastPartialReceivedAtMs).toBe(100);
  });
});

// ─── Capability-gating adapter ───────────────────────────────────────────────────
describe("voice-timebase — resolutionToVoiceProfile (AC1)", () => {
  it("maps undefined / unavailable to none and an available resolution to its profile", () => {
    expect(resolutionToVoiceProfile(undefined)).toBe("none");

    const unavailable: VoiceCapabilityResolution = {
      available: false,
      profile: "full-realtime",
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
      transport: { websocketControl: false, webrtcMedia: false },
    };
    expect(resolutionToVoiceProfile(unavailable)).toBe("none");

    const available: VoiceCapabilityResolution = {
      ...unavailable,
      available: true,
      profile: "speech-to-text",
    };
    expect(resolutionToVoiceProfile(available)).toBe("speech-to-text");
  });
});

// ─── Default browser clock ───────────────────────────────────────────────────────
describe("voice-timebase — browser clock", () => {
  it("createBrowserVoiceClock reads performance.now and is monotonic", () => {
    const clock = createBrowserVoiceClock();
    const first = clock.now();
    const second = clock.now();
    expect(typeof first).toBe("number");
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
