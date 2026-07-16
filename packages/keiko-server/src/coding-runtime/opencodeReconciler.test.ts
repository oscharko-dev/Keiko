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
  it("requires the first history event for each aggregate to begin at sequence zero", () => {
    const reconciler = createOpenCodeReconciler();

    expect(reconciler.ingest([event("evt_1", 1)])).toEqual({
      ok: false,
      reason: "sequence-gap",
    });
    expect(reconciler.checkpoints()).toEqual({});
    expect(reconciler.staging()).toMatchObject({ events: 0, bytes: 0 });
  });

  it("commits no checkpoints or staging when a later event overflows a history batch", () => {
    const reconciler = createOpenCodeReconciler({ maxEvents: 2, maxBytes: 1024 * 1024 });
    expect(reconciler.ingest([event("evt_permission", 0, "permission")])).toMatchObject({
      ok: true,
    });
    const checkpoints = reconciler.checkpoints();
    const staging = reconciler.staging();

    expect(
      reconciler.ingest([
        event("evt_observation", 1),
        event("evt_terminal", 2, "terminal"),
        event("evt_question", 3, "question"),
      ]),
    ).toEqual({ ok: false, reason: "staging-overflow" });
    expect(reconciler.checkpoints()).toEqual(checkpoints);
    expect(reconciler.staging()).toEqual(staging);
  });

  it("plans each batch before commit when a later gap, conflict, or invalid event is rejected", () => {
    const cases: readonly {
      readonly events: readonly OpenCodeReconciliationEvent[];
      readonly reason: "sequence-gap" | "sequence-conflict" | "invalid-event";
    }[] = [
      {
        events: [event("evt_next", 1), event("evt_gap", 3)],
        reason: "sequence-gap",
      },
      {
        events: [
          event("evt_next", 1),
          { ...event("evt_conflict", 1, "permission"), digest: "e".repeat(64) },
        ],
        reason: "sequence-conflict",
      },
      {
        events: [event("evt_next", 1), { ...event("evt_invalid", 2), digest: "invalid" }],
        reason: "invalid-event",
      },
    ];

    for (const { events, reason } of cases) {
      const reconciler = createOpenCodeReconciler();
      expect(reconciler.ingest([event("evt_seed", 0)])).toMatchObject({ ok: true });
      const checkpoints = reconciler.checkpoints();
      const staging = reconciler.staging();

      expect(reconciler.ingest(events)).toEqual({ ok: false, reason });
      expect(reconciler.checkpoints()).toEqual(checkpoints);
      expect(reconciler.staging()).toEqual(staging);
    }
  });

  it("treats a same-aggregate sequence with a different digest as fatal rather than a duplicate", () => {
    const reconciler = createOpenCodeReconciler();
    expect(reconciler.ingest([event("evt_seed", 0)])).toMatchObject({ ok: true });
    const checkpoints = reconciler.checkpoints();
    const staging = reconciler.staging();

    expect(
      reconciler.ingest([
        event("evt_next", 1),
        { ...event("evt_conflict", 1), digest: "f".repeat(64) },
      ]),
    ).toEqual({ ok: false, reason: "sequence-conflict" });
    expect(reconciler.checkpoints()).toEqual(checkpoints);
    expect(reconciler.staging()).toEqual(staging);
  });

  it("treats an empty history as a no-op", () => {
    const reconciler = createOpenCodeReconciler();
    expect(reconciler.ingest([event("evt_seed", 0)])).toMatchObject({ ok: true });
    const checkpoints = reconciler.checkpoints();
    const staging = reconciler.staging();

    expect(reconciler.ingest([])).toEqual({ ok: true, applied: 0, projections: [] });
    expect(reconciler.checkpoints()).toEqual(checkpoints);
    expect(reconciler.staging()).toEqual(staging);
  });

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

  it("bounds auxiliary reconciliation indexes under sustained history and aggregate churn", () => {
    let now = 0;
    const reconciler = createOpenCodeReconciler({ now: () => now++ }) as ReturnType<
      typeof createOpenCodeReconciler
    > & {
      staging(): Readonly<{
        events: number;
        bytes: number;
        observations: number;
        critical: number;
        identities: number;
        digests: number;
      }>;
    };
    let recent = event("evt_0", 0);
    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      recent = event(`evt_${String(sequence)}`, sequence);
      expect(reconciler.ingest([recent])).toMatchObject({ ok: true, applied: 1 });
    }

    const sustained = reconciler.staging();
    expect(sustained).toMatchObject({ events: 256, observations: 256, critical: 0 });
    expect(sustained.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(sustained.identities).toBeLessThanOrEqual(256);
    expect(sustained.digests).toBeLessThanOrEqual(256);
    expect(reconciler.ingest([recent])).toEqual({ ok: true, applied: 0, projections: [] });
    expect(
      reconciler.ingest([{ ...recent, id: "evt_recent_conflict", digest: "f".repeat(64) }]),
    ).toEqual({ ok: false, reason: "sequence-conflict" });

    const next = event("evt_10000", 10_000);
    expect(reconciler.ingest([next])).toMatchObject({ ok: true, applied: 1 });
    expect(reconciler.staging()).toMatchObject({
      events: sustained.events,
      observations: sustained.observations,
      critical: sustained.critical,
      identities: sustained.identities,
      digests: sustained.digests,
    });

    const churn = createOpenCodeReconciler({ now: () => now++ });
    for (let index = 0; index < 1_000; index += 1) {
      expect(
        churn.ingest([
          {
            ...event(`evt_churn_${String(index)}`, 0),
            aggregateId: `ses_${String(index)}`,
            digest: index.toString(16).padStart(64, "0"),
          },
        ]),
      ).toMatchObject({ ok: true, applied: 1 });
    }
    expect(Object.keys(churn.checkpoints()).length).toBeLessThanOrEqual(256);
  });
});
