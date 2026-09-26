import { describe, expect, it, vi } from "vitest";

import {
  createInlineCompletionTelemetry,
  EMPTY_INLINE_COMPLETION_TELEMETRY,
  inlineCompletionTelemetryReducer,
  type InlineCompletionTelemetryEvent,
} from "./inline-completion-telemetry.js";

describe("inlineCompletionTelemetryReducer", () => {
  it("starts from an all-zero snapshot", () => {
    expect(EMPTY_INLINE_COMPLETION_TELEMETRY).toEqual({
      offered: 0,
      shown: 0,
      accepted: 0,
      rejected: 0,
      ignored: 0,
      partiallyAccepted: 0,
      requestCount: 0,
      requestLatencyMsP50: 0,
      requestLatencyMsP95: 0,
    });
  });

  it("increments the matching field for each event without mutating the input", () => {
    const cases: readonly [
      InlineCompletionTelemetryEvent,
      keyof typeof EMPTY_INLINE_COMPLETION_TELEMETRY,
    ][] = [
      ["offered", "offered"],
      ["shown", "shown"],
      ["accepted", "accepted"],
      ["rejected", "rejected"],
      ["ignored", "ignored"],
      ["partially-accepted", "partiallyAccepted"],
    ];
    for (const [event, field] of cases) {
      const next = inlineCompletionTelemetryReducer(EMPTY_INLINE_COMPLETION_TELEMETRY, event);
      expect(next[field]).toBe(1);
      // input is not mutated
      expect(EMPTY_INLINE_COMPLETION_TELEMETRY[field]).toBe(0);
    }
  });

  it("accumulates across a sequence of events", () => {
    const events: InlineCompletionTelemetryEvent[] = [
      "offered",
      "shown",
      "accepted",
      "offered",
      "shown",
      "rejected",
    ];
    const snapshot = events.reduce(
      inlineCompletionTelemetryReducer,
      EMPTY_INLINE_COMPLETION_TELEMETRY,
    );
    expect(snapshot).toEqual({
      offered: 2,
      shown: 2,
      accepted: 1,
      rejected: 1,
      ignored: 0,
      partiallyAccepted: 0,
      requestCount: 0,
      requestLatencyMsP50: 0,
      requestLatencyMsP95: 0,
    });
  });
});

describe("createInlineCompletionTelemetry", () => {
  it("records events and notifies the observer with the new content-free snapshot", () => {
    const onChange = vi.fn();
    const telemetry = createInlineCompletionTelemetry(onChange);

    telemetry.record("offered");
    telemetry.record("shown");
    telemetry.record("accepted");

    expect(telemetry.snapshot()).toMatchObject({ offered: 1, shown: 1, accepted: 1 });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ offered: 1, shown: 1, accepted: 1 }),
    );
  });

  it("works without an observer", () => {
    const telemetry = createInlineCompletionTelemetry();
    expect(() => {
      telemetry.record("ignored");
    }).not.toThrow();
    expect(telemetry.snapshot().ignored).toBe(1);
  });

  it("records content-free nearest-rank p50/p95 request latency", () => {
    const onChange = vi.fn();
    const telemetry = createInlineCompletionTelemetry(onChange);
    for (const latency of [42.4, 10, 200, 60, 80]) {
      telemetry.recordLatency(latency);
    }
    expect(telemetry.snapshot()).toMatchObject({
      requestCount: 5,
      requestLatencyMsP50: 60,
      requestLatencyMsP95: 200,
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestCount: 5,
        requestLatencyMsP50: 60,
        requestLatencyMsP95: 200,
      }),
    );
  });

  it("never exposes a content-bearing key on the snapshot", () => {
    const telemetry = createInlineCompletionTelemetry();
    telemetry.record("accepted");
    const keys = Object.keys(telemetry.snapshot());
    for (const forbidden of ["text", "insertText", "prompt", "content"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // KEIKO-0639: `normaliseLatencyMs` clamps a non-finite (NaN/Infinity) or negative latency to 0
  // so a caller-side clock bug does not corrupt the p50/p95 the host forwards to the governed
  // telemetry BFF. The prior suite only fed finite positive values, leaving the guard uncovered.
  it("clamps negative, NaN, and Infinity latencies to 0 in the percentile aggregate", () => {
    const telemetry = createInlineCompletionTelemetry();
    for (const latency of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      telemetry.recordLatency(latency);
    }
    expect(telemetry.snapshot()).toMatchObject({
      requestCount: 3,
      requestLatencyMsP50: 0,
      requestLatencyMsP95: 0,
    });
  });

  // KEIKO-0709: the latency sample array backing p50/p95 was previously unbounded and fully
  // re-sorted on every `recordLatency`, so a long typing session added O(n log n) work per
  // keystroke to a path already gated by a strict per-keystroke budget (ADR-0042 D3.6/D5). The
  // bounded window drops the oldest samples so a stale high value can no longer dominate p95
  // indefinitely; `requestCount` must nonetheless remain the true monotonic total across ALL
  // recordLatency calls, independent of the retained sample window.
  it("bounds the retained latency window and keeps requestCount monotonic (KEIKO-0709)", () => {
    const telemetry = createInlineCompletionTelemetry();
    // Feed a large batch of high-value samples that would sit at the tail of an unbounded sort
    // and dominate p95 forever.
    for (let index = 0; index < 200; index += 1) {
      telemetry.recordLatency(1000);
    }
    // Then feed enough low-value samples to fully evict the earlier tail from a bounded window
    // (the bound is at most 200 by design; 500 low values guarantees eviction for any bound in
    // [1, 500]).
    for (let index = 0; index < 500; index += 1) {
      telemetry.recordLatency(1);
    }
    const snapshot = telemetry.snapshot();
    // Total observations across all calls, not the retained-array length.
    expect(snapshot.requestCount).toBe(700);
    // With the high values evicted the retained distribution is all-1 so p50/p95 collapse to 1.
    // An unbounded implementation would keep the 200 high values at the sorted tail and report
    // p95 = 1000.
    expect(snapshot.requestLatencyMsP50).toBe(1);
    expect(snapshot.requestLatencyMsP95).toBe(1);
  });
});
