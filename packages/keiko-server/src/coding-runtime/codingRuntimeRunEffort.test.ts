import { describe, expect, it } from "vitest";

import {
  CodingRuntimeRunEffortLedger,
  createCodingRuntimeRunEffortRegistry,
  elapsedMs,
} from "./codingRuntimeRunEffort.js";

function fakeClock(startMs = 1_800_000_000_000): {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

describe("createCodingRuntimeRunEffortRegistry", () => {
  it("measures each dispatched model call from its reservation to its settlement", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const first = registry.modelCallReserved("run-a", 1_000);
    clock.advance(3_000);
    registry.modelCallSettled("run-a", first, 1_180);
    const second = registry.modelCallReserved("run-a", 1_400);
    clock.advance(5_000);
    registry.modelCallSettled("run-a", second, 1_400);

    expect(registry.read("run-a")).toEqual({
      modelTurnCount: 2,
      modelDurationMs: 8_000,
      // The second settlement kept the reserved estimate: it is not a provider count.
      promptTokensTotal: 1_180,
      toolInvocationCount: 0,
      workspaceReadCount: 0,
      editCount: 0,
      editRefusedCount: 0,
    });
    expect(registry.read("run-b")).toBeUndefined();
  });

  it("keeps the summed duration exact for overlapping calls of one size", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const first = registry.modelCallReserved("run-a", 500);
    clock.advance(1_000);
    const second = registry.modelCallReserved("run-a", 500);
    clock.advance(1_000);
    registry.modelCallSettled("run-a", first, 450);
    clock.advance(2_000);
    registry.modelCallSettled("run-a", second, 470);

    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 2,
      modelDurationMs: 2_000 + 3_000,
      promptTokensTotal: 920,
    });
  });

  // #3873 review (PR #3876): calls were paired by reservation size, oldest first, so a call that was
  // released unanswered took the start time of an answered call of the same size in flight: a call
  // of 5,000 ms was recorded as 4,900 ms. A settlement now names its own call.
  it("never times an answered call from the reservation of a released one of the same size", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const answered = registry.modelCallReserved("run-a", 800);
    clock.advance(100);
    const released = registry.modelCallReserved("run-a", 800);
    clock.advance(100);
    registry.modelCallSettled("run-a", released, 0);
    clock.advance(4_800);
    registry.modelCallSettled("run-a", answered, 760);

    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 1,
      modelDurationMs: 5_000,
      promptTokensTotal: 760,
    });
  });

  it("times a call from its own reservation however the settlements are ordered", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const calls = Array.from({ length: 4 }, () => {
      const id = registry.modelCallReserved("run-a", 640);
      clock.advance(250);
      return id;
    });
    // The settlements arrive in an order of their own, every call of one size.
    for (const index of [2, 0, 3, 1]) {
      clock.advance(1_000);
      registry.modelCallSettled("run-a", calls[index], 700 + index);
    }

    // Reserved at 0, 250, 500, 750; the clock reads 1_000 after the four reservations, then settles
    // calls 2, 0, 3, 1 at 2_000, 3_000, 4_000 and 5_000.
    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 4,
      modelDurationMs: 2_000 - 500 + (3_000 - 0) + (4_000 - 750) + (5_000 - 250),
    });
  });

  it("answers each reservation an identity of its own, across runs too", () => {
    const registry = createCodingRuntimeRunEffortRegistry();
    const ids = [
      registry.modelCallReserved("run-a", 100),
      registry.modelCallReserved("run-a", 100),
      registry.modelCallReserved("run-b", 100),
    ];

    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id !== undefined)).toBe(true);
  });

  it("counts neither a released call nor a settlement it cannot pair", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const released = registry.modelCallReserved("run-a", 800);
    clock.advance(500);
    registry.modelCallSettled("run-a", released, 0);
    // The released call is gone: naming it again settles nothing.
    registry.modelCallSettled("run-a", released, 950);
    // A call this registry never reserved, one that named none, and a run it never saw.
    registry.modelCallSettled("run-a", 9_999, 950);
    registry.modelCallSettled("run-a", undefined, 950);
    registry.modelCallSettled("run-unknown", released, 950);
    // An estimate that is not a count is no call.
    expect(registry.modelCallReserved("run-a", -1)).toBeUndefined();

    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 0,
      modelDurationMs: 0,
      promptTokensTotal: 0,
    });
    expect(registry.read("run-unknown")).toBeUndefined();
  });

  it("does not settle a call against another run's reservation", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    const other = registry.modelCallReserved("run-b", 300);
    registry.modelCallReserved("run-a", 300);
    clock.advance(1_000);
    registry.modelCallSettled("run-a", other, 310);

    expect(registry.read("run-a")).toMatchObject({ modelTurnCount: 0, modelDurationMs: 0 });
    expect(registry.read("run-b")).toMatchObject({ modelTurnCount: 0 });
  });

  it("counts governed tool calls by their action and answer", () => {
    const registry = createCodingRuntimeRunEffortRegistry();
    registry.toolSettled("run-a", "read", "completed");
    registry.toolSettled("run-a", "read", "denied");
    registry.toolSettled("run-a", "edit", "completed");
    registry.toolSettled("run-a", "edit", "failed");
    registry.toolSettled("run-a", "edit", "cancelled");
    registry.toolSettled("run-a", "edit", "invalid");
    registry.toolSettled("run-a", "verification", "completed");
    registry.toolSettled("run-a", undefined, "invalid");
    registry.toolSettled("run-a", "edit", "observed");

    expect(registry.read("run-a")).toMatchObject({
      toolInvocationCount: 8,
      workspaceReadCount: 1,
      editCount: 1,
      editRefusedCount: 2,
    });
  });
});

describe("CodingRuntimeRunEffortLedger", () => {
  const run = {
    runId: "run-a",
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:05:00.000Z",
  };

  it("adds the run's verifications, decisions and human waits to the host's counts", () => {
    const ledger = new CodingRuntimeRunEffortLedger();
    ledger.begin("run-a");
    ledger.verification("run-a");
    ledger.waiting("run-a", true, "2026-10-06T10:01:00.000Z");
    ledger.waiting("run-a", true, "2026-10-06T10:01:30.000Z");
    ledger.waiting("run-a", false, "2026-10-06T10:02:00.000Z");
    ledger.decision("run-a");
    ledger.waiting("run-a", false, "2026-10-06T10:03:00.000Z");

    expect(
      ledger.rollUp(run, {
        modelTurnCount: 2,
        modelDurationMs: 8_000,
        promptTokensTotal: 1_180,
        toolInvocationCount: 2,
        workspaceReadCount: 1,
        editCount: 1,
        editRefusedCount: 0,
      }),
    ).toEqual({
      wallDurationMs: 300_000,
      modelTurnCount: 2,
      modelDurationMs: 8_000,
      promptTokensTotal: 1_180,
      toolInvocationCount: 2,
      workspaceReadCount: 1,
      editCount: 1,
      editRefusedCount: 0,
      verificationCount: 1,
      operatorDecisionCount: 1,
      operatorWaitMs: 60_000,
    });
  });

  it.each([true, false])(
    "keeps a read-only verification result (%s) diagnostic until an edit applies",
    (passed) => {
      const ledger = new CodingRuntimeRunEffortLedger();
      ledger.begin("run-a");
      ledger.verification("run-a", passed, "diagnostic-target");
      expect(ledger.needsVerification("run-a")).toBe(false);
      expect(ledger.rollUp(run, undefined)).toMatchObject({ verificationCount: 1 });
      ledger.edit("run-a");
      expect(ledger.needsVerification("run-a")).toBe(true);
      ledger.verification("run-a", true, "diagnostic-target", ledger.verificationRevision("run-a"));
      expect(ledger.needsVerification("run-a")).toBe(false);
    },
  );

  it("requires actual revision provenance after an edit and ignores a late older pass", () => {
    const ledger = new CodingRuntimeRunEffortLedger();
    ledger.begin("run-a");
    ledger.edit("run-a");
    const earlier = ledger.verificationRevision("run-a");
    ledger.edit("run-a");
    ledger.verification("run-a", true, "target-a", earlier);
    expect(ledger.needsVerification("run-a")).toBe(true);
    ledger.verification("run-a", true, "target-a");
    expect(ledger.needsVerification("run-a")).toBe(true);
    ledger.verification("run-a", true, "target-a", ledger.verificationRevision("run-a"));
    expect(ledger.needsVerification("run-a")).toBe(false);
    ledger.verification("run-a", false, "target-a", earlier);
    expect(ledger.needsVerification("run-a")).toBe(false);
  });

  it("fails closed to zero host counts and reports only the wall time of an unobserved run", () => {
    const ledger = new CodingRuntimeRunEffortLedger();
    ledger.begin("run-a");
    expect(ledger.rollUp(run, undefined)).toMatchObject({
      wallDurationMs: 300_000,
      modelTurnCount: 0,
      toolInvocationCount: 0,
      operatorWaitMs: 0,
    });
    ledger.forget("run-a");
    expect(ledger.rollUp(run, undefined)).toEqual({ wallDurationMs: 300_000 });
    expect(elapsedMs("not-a-date", run.updatedAt)).toBe(0);
    expect(elapsedMs(run.updatedAt, run.createdAt)).toBe(0);
  });
});
