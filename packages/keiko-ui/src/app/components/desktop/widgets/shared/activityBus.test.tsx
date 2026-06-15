import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActivity, logActivity, useActivitySubscription } from "./activityBus";

describe("activityBus", () => {
  beforeEach(() => {
    delete window.__keikoActivity;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends timestamped activity and caps the in-memory store", () => {
    for (let index = 0; index < 125; index += 1) {
      logActivity({ type: "step", text: `event-${index.toString()}`, agent: "qa" });
    }

    const activity = getActivity();
    expect(activity).toHaveLength(120);
    expect(activity[0]).toMatchObject({
      type: "step",
      text: "event-124",
      agent: "qa",
      time: Date.parse("2026-06-15T10:00:00Z"),
    });
    expect(activity.at(-1)?.text).toBe("event-5");
  });

  it("notifies subscribers when new activity arrives and unsubscribes on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(() => useActivitySubscription());

    expect(result.current).toEqual([]);

    act(() => logActivity({ type: "approval", text: "Needs review", tool: "tests" }));
    expect(result.current[0]).toMatchObject({ type: "approval", text: "Needs review" });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("keiko-activity", expect.any(Function));
  });
});
