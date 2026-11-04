import { describe, expect, it } from "vitest";
import { awaitLearning } from "../testing/memory-lab/instance.mjs";

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
});
