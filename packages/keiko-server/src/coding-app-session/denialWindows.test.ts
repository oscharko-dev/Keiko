import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodingAppSessionDenialWindows,
  DENIAL_ALERT_THRESHOLD,
  LOCAL_SESSION_DENIAL_REASONS,
  type LocalSessionDenialSummary,
} from "./denialWindows.js";

afterEach(() => {
  vi.useRealTimers();
});

function collector(): {
  readonly summaries: LocalSessionDenialSummary[];
  readonly emit: (summary: LocalSessionDenialSummary) => void;
} {
  const summaries: LocalSessionDenialSummary[] = [];
  return {
    summaries,
    emit: (summary): void => {
      summaries.push(summary);
    },
  };
}

describe("local-session denial window (#4370)", () => {
  it("counts an isolated refusal under its reason when the window closes", () => {
    vi.useFakeTimers();
    const windows = new CodingAppSessionDenialWindows();
    const { summaries, emit } = collector();
    windows.recordLocalSessionDenial(Date.now(), "session-unregistered", emit);
    // Below the alert threshold nothing is written while the window is open.
    expect(summaries).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ count: 1, windowClosed: true });
    expect(summaries[0]?.histogram["session-unregistered"]).toBe(1);
    for (const reason of LOCAL_SESSION_DENIAL_REASONS)
      if (reason !== "session-unregistered") expect(summaries[0]?.histogram[reason]).toBe(0);
  });

  it("counts every closed reason and keeps the histogram total equal to the count", () => {
    vi.useFakeTimers();
    const windows = new CodingAppSessionDenialWindows();
    const { summaries, emit } = collector();
    LOCAL_SESSION_DENIAL_REASONS.forEach((reason, index) => {
      for (let repeat = 0; repeat <= index; repeat += 1)
        windows.recordLocalSessionDenial(Date.now(), reason, emit);
    });
    vi.advanceTimersByTime(60_000);
    const closed = summaries.filter((summary) => summary.windowClosed);
    expect(closed).toHaveLength(1);
    const total = Object.values(closed[0]?.histogram ?? {}).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(closed[0]?.count);
    LOCAL_SESSION_DENIAL_REASONS.forEach((reason, index) => {
      expect(closed[0]?.histogram[reason]).toBe(index + 1);
    });
  });

  it("raises one alert at the threshold and still closes the window with its final totals", () => {
    vi.useFakeTimers();
    const windows = new CodingAppSessionDenialWindows();
    const { summaries, emit } = collector();
    for (let index = 0; index < DENIAL_ALERT_THRESHOLD + 5; index += 1)
      windows.recordLocalSessionDenial(Date.now(), "proof-missing", emit);
    expect(summaries.map((summary) => summary.windowClosed)).toEqual([false]);
    expect(summaries[0]?.count).toBe(DENIAL_ALERT_THRESHOLD);
    vi.advanceTimersByTime(60_000);
    expect(summaries.map((summary) => summary.windowClosed)).toEqual([false, true]);
    expect(summaries[1]).toMatchObject({ count: DENIAL_ALERT_THRESHOLD + 5 });
    expect(summaries[1]?.histogram["proof-missing"]).toBe(DENIAL_ALERT_THRESHOLD + 5);
  });

  it("closes the previous window deterministically when the next denial arrives after it", () => {
    const windows = new CodingAppSessionDenialWindows();
    const { summaries, emit } = collector();
    windows.recordLocalSessionDenial(1_000, "inactivity", emit);
    windows.recordLocalSessionDenial(30_000, "inactivity", emit);
    windows.recordLocalSessionDenial(61_000, "secret-mismatch", emit);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ count: 2, windowClosed: true });
    expect(summaries[0]?.histogram.inactivity).toBe(2);
    windows.reset();
  });

  it("drops its pending window on disposal so nothing outlives the graph", () => {
    vi.useFakeTimers();
    const windows = new CodingAppSessionDenialWindows();
    const { summaries, emit } = collector();
    windows.recordLocalSessionDenial(Date.now(), "proof-missing", emit);
    windows.reset();
    vi.advanceTimersByTime(120_000);
    expect(summaries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
