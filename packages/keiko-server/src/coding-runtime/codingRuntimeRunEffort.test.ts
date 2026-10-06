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
    registry.modelCallReserved("run-a", 1_000);
    clock.advance(3_000);
    registry.modelCallSettled("run-a", 1_000, 1_180);
    registry.modelCallReserved("run-a", 1_400);
    clock.advance(5_000);
    registry.modelCallSettled("run-a", 1_400, 1_400);

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
    registry.modelCallReserved("run-a", 500);
    clock.advance(1_000);
    registry.modelCallReserved("run-a", 500);
    clock.advance(1_000);
    registry.modelCallSettled("run-a", 500, 450);
    clock.advance(2_000);
    registry.modelCallSettled("run-a", 500, 470);

    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 2,
      modelDurationMs: 2_000 + 3_000,
      promptTokensTotal: 920,
    });
  });

  it("counts neither a released call nor a settlement it cannot pair", () => {
    const clock = fakeClock();
    const registry = createCodingRuntimeRunEffortRegistry({ nowMs: clock.now });
    registry.modelCallReserved("run-a", 800);
    clock.advance(500);
    registry.modelCallSettled("run-a", 800, 0);
    registry.modelCallSettled("run-a", 900, 950);
    registry.modelCallSettled("run-unknown", 900, 950);
    registry.modelCallReserved("run-a", -1);

    expect(registry.read("run-a")).toMatchObject({
      modelTurnCount: 0,
      modelDurationMs: 0,
      promptTokensTotal: 0,
    });
    expect(registry.read("run-unknown")).toBeUndefined();
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
