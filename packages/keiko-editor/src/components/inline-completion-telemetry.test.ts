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
});
