// Regression coverage for KEIKO-0205's follow-up finding: Emitter.emit correctly quarantines a
// throwing sink, but the original fix dropped the FACT of the failure along with its (correctly
// untrusted) throw value, leaving a run report `completed` with a silently incomplete audit trail.
// Exercises Emitter directly (not through createSession) so each test controls exactly which sinks
// are wired, in what order, and how they fail — the session-level KEIKO-0205 pin in
// session.test.ts always wires exactly two sinks (an internal memory sink plus one caller sink)
// and cannot express a three-sink, notice-hostile scenario.

import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter.js";
import type { EventSink } from "./ports.js";
import type { HarnessEvent } from "./types.js";
import { stubClock } from "./_support.js";

function recordingSink(): { sink: EventSink; events: () => readonly HarnessEvent[] } {
  const collected: HarnessEvent[] = [];
  return {
    events: (): readonly HarnessEvent[] => collected,
    sink: {
      emit: (event: HarnessEvent): void => {
        collected.push(event);
      },
    },
  };
}

// A sink that throws whenever `shouldThrow` says so, and records how many delivery attempts it
// saw regardless of outcome (so a test can prove exactly how many times it was called).
function throwingSink(shouldThrow: (event: HarnessEvent) => boolean): {
  sink: EventSink;
  callCount: () => number;
} {
  let calls = 0;
  return {
    callCount: (): number => calls,
    sink: {
      emit: (event: HarnessEvent): void => {
        calls += 1;
        if (shouldThrow(event)) {
          throw new Error("sink is broken");
        }
      },
    },
  };
}

describe("Emitter sink-degraded notice (KEIKO-0205 follow-up)", () => {
  it("quarantines a throwing sink so it stops receiving subsequent events", () => {
    const failing = throwingSink(() => true);
    const healthy = recordingSink();
    const emitter = new Emitter([failing.sink, healthy.sink], stubClock().clock, "run-1", "fp");

    expect(() => {
      emitter.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });
    }).not.toThrow();
    expect(() => {
      emitter.emit({
        type: "state:transition",
        from: "planning",
        to: "model-call",
        reason: "go",
      });
    }).not.toThrow();

    // One delivery attempt for the original event; the sink is poisoned before any notice can be
    // built, so it never sees the later state:transition and never sees a notice about itself.
    expect(failing.callCount()).toBe(1);
  });

  it("delivers a body-free sink:degraded notice naming the failing sink's index to healthy sinks", () => {
    const failing = throwingSink(() => true); // index 0
    const healthy = recordingSink(); // index 1
    const emitter = new Emitter([failing.sink, healthy.sink], stubClock().clock, "run-1", "fp");

    emitter.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });

    const notice = healthy.events().find((event) => event.type === "sink:degraded");
    expect(notice).toBeDefined();
    if (notice?.type === "sink:degraded") {
      expect(notice.sinkIndex).toBe(0);
      expect(notice.reason).toBe("sink-threw");
      // Body-free: exactly the identity envelope plus sinkIndex/reason — no message, stack, or
      // any trace of the underlying (untrusted) throw value anywhere on the event.
      expect(Object.keys(notice).sort()).toEqual(
        [
          "schemaVersion",
          "runId",
          "fingerprint",
          "seq",
          "ts",
          "type",
          "sinkIndex",
          "reason",
        ].sort(),
      );
      expect(JSON.stringify(notice)).not.toMatch(/broken|stack|Error/i);
    }
  });

  it("keeps seq strictly increasing: the notice always follows the event it reports on", () => {
    const failing = throwingSink(() => true);
    const healthy = recordingSink();
    const emitter = new Emitter([failing.sink, healthy.sink], stubClock().clock, "run-1", "fp");

    emitter.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });
    emitter.emit({ type: "state:transition", from: "planning", to: "model-call", reason: "go" });

    const seqs = healthy.events().map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq
    expect(healthy.events().map((event) => event.type)).toEqual([
      "state:transition",
      "sink:degraded",
      "state:transition",
    ]);
  });

  it("does not recurse or hang when a sink throws on every emit, including the notice", () => {
    const failing = throwingSink(() => true); // index 0: fails on the very first event.
    // Healthy for regular events, but throws specifically when asked to relay a notice.
    const noticeHostile = throwingSink((event) => event.type === "sink:degraded"); // index 1
    const healthy = recordingSink(); // index 2

    const emitter = new Emitter(
      [failing.sink, noticeHostile.sink, healthy.sink],
      stubClock().clock,
      "run-1",
      "fp",
    );

    expect(() => {
      emitter.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });
    }).not.toThrow();

    // failing: one attempt (the original event), then quarantined.
    expect(failing.callCount()).toBe(1);
    // noticeHostile: one attempt for the original event (survives) plus one attempt for the
    // notice about `failing` (throws, gets quarantined) — it is never asked to relay a second
    // notice about its own failure, which is what proves there is no recursive chain.
    expect(noticeHostile.callCount()).toBe(2);
    // healthy sees the original event plus exactly one notice (about `failing`); a second notice
    // about noticeHostile's own failure would mean the guard against re-announcing had broken.
    expect(healthy.events().filter((event) => event.type === "sink:degraded")).toHaveLength(1);

    // A further emit proves the emitter keeps making forward progress: both broken sinks are
    // simply skipped from here on, with no additional throws and no hang.
    expect(() => {
      emitter.emit({ type: "state:transition", from: "model-call", to: "tool-call", reason: "go" });
    }).not.toThrow();
    expect(failing.callCount()).toBe(1);
    expect(noticeHostile.callCount()).toBe(2);
    expect(healthy.events()).toHaveLength(3);
  });

  it("keeps quarantine state per Emitter instance (does not leak across runs)", () => {
    const failing = throwingSink(() => true);
    const healthyA = recordingSink();
    const emitterA = new Emitter([failing.sink, healthyA.sink], stubClock().clock, "run-a", "fp-a");
    emitterA.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });
    expect(failing.callCount()).toBe(1);

    // A second Emitter wired with the SAME sink object must not inherit the first run's
    // quarantine: WeakSet membership is per-Emitter instance, not per-sink.
    const healthyB = recordingSink();
    const emitterB = new Emitter([failing.sink, healthyB.sink], stubClock().clock, "run-b", "fp-b");
    emitterB.emit({ type: "state:transition", from: "intake", to: "planning", reason: "go" });

    expect(failing.callCount()).toBe(2);
    const notice = healthyB.events().find((event) => event.type === "sink:degraded");
    expect(notice).toBeDefined();
  });
});
