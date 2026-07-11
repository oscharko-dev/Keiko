import { describe, expect, it } from "vitest";

import {
  createOpenCodeReconciler,
  type OpenCodeReconciliationEvent,
} from "./opencodeReconciler.js";

function event(
  id: string,
  sequence: number,
  kind: OpenCodeReconciliationEvent["kind"] = "observation",
): OpenCodeReconciliationEvent {
  const suffix = sequence.toString(16);
  return {
    id,
    aggregateId: "ses_1",
    sequence,
    digest: suffix.padStart(64, id === "evt_other" ? "b" : "0"),
    kind,
  };
}

describe("OpenCode history reconciliation", () => {
  it("handles 1,000 observations across three overlapping reconnects within staging bounds", () => {
    const reconciler = createOpenCodeReconciler({ now: () => 0 });
    const criticalKinds: Record<number, OpenCodeReconciliationEvent["kind"]> = {
      100: "permission",
      300: "question",
      500: "tool",
      700: "terminal",
    };
    const burst = Array.from({ length: 1000 }, (_, sequence) =>
      event(`evt_${String(sequence)}`, sequence, criticalKinds[sequence] ?? "observation"),
    );
    const first = reconciler.ingest(burst);
    expect(first).toMatchObject({ ok: true, applied: 1000 });
    expect(reconciler.ingest(burst.slice(700))).toEqual({ ok: true, applied: 0, projections: [] });
    expect(reconciler.ingest(burst.slice(900))).toEqual({ ok: true, applied: 0, projections: [] });
    expect(reconciler.ingest(burst.slice(950))).toEqual({ ok: true, applied: 0, projections: [] });
    if (first.ok)
      expect(
        first.projections
          .filter((projection) => projection.kind !== "observation")
          .map((projection) => projection.id),
      ).toEqual(["evt_100", "evt_300", "evt_500", "evt_700"]);
    expect(reconciler.staging().events).toBe(256);
    expect(reconciler.staging()).toMatchObject({ observations: 252, critical: 4 });
    expect(reconciler.staging().bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it("deduplicates by identity and digest before a projection is emitted", () => {
    const reconciler = createOpenCodeReconciler({ now: () => 0 });
    expect(reconciler.ingest([event("evt_1", 0)])).toMatchObject({ ok: true, applied: 1 });
    expect(reconciler.ingest([event("evt_1", 0)])).toEqual({
      ok: true,
      applied: 0,
      projections: [],
    });
  });

  it("fails closed for a per-aggregate sequence gap or conflict", () => {
    const reconciler = createOpenCodeReconciler();
    expect(reconciler.ingest([event("evt_1", 0)])).toMatchObject({ ok: true });
    expect(reconciler.ingest([event("evt_3", 2)])).toEqual({ ok: false, reason: "sequence-gap" });
    expect(reconciler.ingest([event("evt_other", 0)])).toEqual({
      ok: false,
      reason: "sequence-conflict",
    });
  });

  it("preserves critical events but fails closed when bounds cannot retain them", () => {
    const reconciler = createOpenCodeReconciler({ maxEvents: 1, maxBytes: 1024 * 1024 });
    expect(reconciler.ingest([event("evt_permission", 0, "permission")])).toMatchObject({
      ok: true,
    });
    expect(reconciler.ingest([event("evt_terminal", 1, "terminal")])).toEqual({
      ok: false,
      reason: "staging-overflow",
    });
  });

  it("fails closed for critical-only byte overflow", () => {
    const reconciler = createOpenCodeReconciler({ maxEvents: 256, maxBytes: 1 });
    expect(reconciler.ingest([event("evt_permission", 0, "permission")])).toEqual({
      ok: false,
      reason: "staging-overflow",
    });
  });

  it("coalesces safe observations to no more than 10Hz while preserving checkpoints", () => {
    let now = 0;
    const reconciler = createOpenCodeReconciler({ now: () => now });
    expect(reconciler.ingest([event("evt_1", 0)])).toMatchObject({
      projections: [expect.anything()],
    });
    now = 99;
    expect(reconciler.ingest([event("evt_2", 1)])).toEqual({
      ok: true,
      applied: 1,
      projections: [],
    });
    now = 100;
    expect(reconciler.ingest([event("evt_3", 2)])).toMatchObject({
      projections: [expect.anything()],
    });
  });
});
