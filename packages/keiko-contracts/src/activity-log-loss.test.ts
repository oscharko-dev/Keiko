import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_LOSS_REASONS,
  activityLogLossCounters,
  activityLogLossTotal,
  isActivityLogLossReason,
  recordActivityLogLoss,
  resetActivityLogLossCountersForTests,
  type ActivityLogLossReason,
} from "./activity-log-loss.js";

afterEach(() => {
  resetActivityLogLossCountersForTests();
});

// #3532: the one bounded, process-wide ledger every layer counts a lost event in.
describe("Activity Log loss ledger", () => {
  it("starts every closed reason at zero", () => {
    expect(Object.keys(activityLogLossCounters()).sort()).toEqual(
      [...ACTIVITY_LOG_LOSS_REASONS].sort(),
    );
    expect(activityLogLossTotal()).toBe(0);
  });

  it("counts each reason separately and sums them", () => {
    recordActivityLogLoss("port-sink-failed");
    recordActivityLogLoss("port-sink-failed");
    recordActivityLogLoss("client-post-failed", 5);

    expect(activityLogLossCounters()["port-sink-failed"]).toBe(2);
    expect(activityLogLossCounters()["client-post-failed"]).toBe(5);
    expect(activityLogLossTotal()).toBe(7);
  });

  // It runs inside failing sinks, so an invalid input is ignored instead of becoming a new failure.
  it.each([
    ["zero", 0],
    ["a negative count", -3],
    ["a fractional count", 1.5],
    ["NaN", Number.NaN],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("ignores %s without throwing", (_label, count) => {
    expect(() => {
      recordActivityLogLoss("schema-rejected", count);
    }).not.toThrow();
    expect(activityLogLossTotal()).toBe(0);
  });

  it("ignores an unknown reason without throwing", () => {
    expect(() => {
      recordActivityLogLoss("made-up" as ActivityLogLossReason);
    }).not.toThrow();
    expect(activityLogLossTotal()).toBe(0);
    expect(isActivityLogLossReason("made-up")).toBe(false);
    expect(isActivityLogLossReason(3)).toBe(false);
    for (const reason of ACTIVITY_LOG_LOSS_REASONS)
      expect(isActivityLogLossReason(reason)).toBe(true);
  });

  it("saturates a counter and the total instead of overflowing", () => {
    recordActivityLogLoss("collector-dropped", Number.MAX_SAFE_INTEGER);
    recordActivityLogLoss("collector-dropped", 10);
    recordActivityLogLoss("logger-unavailable", Number.MAX_SAFE_INTEGER);

    expect(activityLogLossCounters()["collector-dropped"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(activityLogLossTotal()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("hands out copies that never change the ledger", () => {
    recordActivityLogLoss("persistence-failed");
    const copy = activityLogLossCounters() as Record<ActivityLogLossReason, number>;
    copy["persistence-failed"] = 99;

    expect(activityLogLossCounters()["persistence-failed"]).toBe(1);
  });
});
