import { act, renderHook } from "@testing-library/react";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActivity,
  logActivity,
  logRuntimeActivityEvents,
  useActivitySubscription,
} from "./activityBus";

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

  it("projects body-free runtime events once into the activity timeline (#3108)", () => {
    const event: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: "cursor-1",
      sequence: 1,
      occurredAt: "2026-06-15T10:00:01.000Z",
      kind: "runtime-event",
      runId: "run-1",
      state: "awaiting-approval",
      revision: 2,
      eventKind: "permission-requested",
    };

    act(() => logRuntimeActivityEvents([event, event]));

    expect(getActivity()).toHaveLength(1);
    expect(getActivity()[0]).toMatchObject({
      id: "run-1:cursor-1",
      type: "approval",
      labelKey: "activity.event.permissionRequested",
      agent: "runtime",
      time: Date.parse(event.occurredAt),
    });
  });
});
