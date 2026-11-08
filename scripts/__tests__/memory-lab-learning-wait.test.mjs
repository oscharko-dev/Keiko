import { setTimeout } from "node:timers";
import { describe, expect, it } from "vitest";
import {
  awaitLearning,
  LEARNING_PASS_SETTLED_OP,
  LEARNING_PASS_STARTED_OP,
  learningPassProgress,
} from "../testing/memory-lab/instance.mjs";

const quietLedger = {
  request: async () => ({ status: 200, json: { captures: [], total: 0 } }),
};

function passEvent(op, correlationId, fields = {}) {
  return { ts: new Date().toISOString(), op, correlationId, ...fields };
}

describe("memory lab learning wait after a model call ends", () => {
  it("waits a full quiet period after the last open call ends, so the capture that call produces still counts", async () => {
    // The failure this pins: the quiet period was armed when the wait began, so a wait that saw the
    // learner's call end returned at once, in the gap before the product wrote the capture. The
    // pre-probe snapshot behind the hard counters then missed a stored memory.
    let polls = 0;
    const instance = {
      request: async () => {
        polls += 1;
        return { status: 200, json: { captures: [], total: polls >= 5 ? 1 : 0 } };
      },
    };
    const openCalls = async () => (polls < 3 ? 1 : 0);
    const settled = await awaitLearning(instance, {
      quietMs: 250,
      graceMs: 5,
      maxMs: 5000,
      openCalls,
    });
    expect(settled.captures).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(5);
  });

  it("waits through the grace period in live mode when no call was ever seen", async () => {
    // The learner's call may start a moment after the answer; a quiet ledger alone would miss it.
    const started = Date.now();
    const instance = {
      request: async () => ({ status: 200, json: { captures: [], total: 0 } }),
    };
    const settled = await awaitLearning(instance, {
      quietMs: 20,
      graceMs: 300,
      maxMs: 5000,
      openCalls: async () => 0,
    });
    expect(settled.captures).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it("ends before the grace period once a call was seen to start and end", async () => {
    let polls = 0;
    const instance = {
      request: async () => {
        polls += 1;
        return { status: 200, json: { captures: [], total: polls >= 3 ? 1 : 0 } };
      },
    };
    const started = Date.now();
    const settled = await awaitLearning(instance, {
      quietMs: 50,
      graceMs: 5000,
      maxMs: 10000,
      openCalls: async () => (polls < 2 ? 1 : 0),
    });
    expect(settled.captures).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("names the phase of the unit when it gives up", async () => {
    const instance = {
      request: async () => ({ status: 200, json: { captures: [], total: 0 } }),
    };
    await expect(
      awaitLearning(instance, {
        quietMs: 10,
        maxMs: 120,
        openCalls: async () => 1,
        phase: "after the probes",
      }),
    ).rejects.toThrow(/did not settle in time \(after the probes\)/u);
  });

  it("waits for the background learning pass a turn armed, not only for a quiet ledger", async () => {
    // The failure this pins: a subject that learns after the person paused (#4213) starts its pass
    // seconds after the answer. The earlier wait ended once the ledger was quiet and the grace
    // period had passed, before that pass ran, so the probes measured a vault nothing was learned
    // into and product recall read 0.
    const events = [];
    const started = Date.now();
    setTimeout(() => events.push(passEvent(LEARNING_PASS_STARTED_OP, "pass-1")), 150);
    setTimeout(
      () =>
        events.push(
          passEvent(LEARNING_PASS_SETTLED_OP, "pass-1", {
            outcome: "completed",
            pendingChatCount: 0,
          }),
        ),
      400,
    );
    await awaitLearning(quietLedger, {
      quietMs: 10,
      graceMs: 5,
      maxMs: 5000,
      openCalls: async () => 0,
      passes: { idleMs: 100, events: async () => events },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
  });

  it("waits for the continuation a pass announced by leaving Chats pending", async () => {
    const events = [
      passEvent(LEARNING_PASS_STARTED_OP, "pass-1"),
      passEvent(LEARNING_PASS_SETTLED_OP, "pass-1", { outcome: "completed", pendingChatCount: 1 }),
    ];
    const started = Date.now();
    setTimeout(() => {
      events.push(passEvent(LEARNING_PASS_STARTED_OP, "pass-2"));
      events.push(
        passEvent(LEARNING_PASS_SETTLED_OP, "pass-2", {
          outcome: "completed",
          pendingChatCount: 0,
        }),
      );
    }, 300);
    await awaitLearning(quietLedger, {
      quietMs: 10,
      graceMs: 5,
      maxMs: 5000,
      openCalls: async () => 0,
      passes: { idleMs: 100, events: async () => events },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it("ends after the pause and its slack when the turn left nothing to learn", async () => {
    const started = Date.now();
    await awaitLearning(quietLedger, {
      quietMs: 10,
      graceMs: 5,
      maxMs: 10000,
      openCalls: async () => 0,
      passes: { idleMs: 50, events: async () => [] },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
  });

  it("does not wait minutes for the retry of a pass that found its model unavailable", async () => {
    const events = [
      passEvent(LEARNING_PASS_STARTED_OP, "pass-1"),
      passEvent(LEARNING_PASS_SETTLED_OP, "pass-1", {
        outcome: "unavailable",
        pendingChatCount: 1,
      }),
    ];
    const started = Date.now();
    await awaitLearning(quietLedger, {
      quietMs: 10,
      graceMs: 5,
      maxMs: 5000,
      openCalls: async () => 0,
      passes: { idleMs: 5000, events: async () => events },
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("counts a pass that started before the wait as open until it settles", () => {
    const before = passEvent(LEARNING_PASS_STARTED_OP, "pass-1");
    before.ts = new Date(Date.now() - 10_000).toISOString();
    expect(learningPassProgress([before], Date.now())).toMatchObject({
      open: 1,
      started: 0,
      settled: 0,
    });
  });
});
