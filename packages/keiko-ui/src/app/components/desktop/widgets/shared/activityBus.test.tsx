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
    delete window.__keikoActivity;
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

  // #3390 wave: `operator-decision` is a governed pause reason, not a routine step, so it must
  // project through the SAME RUNTIME_EVENT_PRESENTATION table as an approval carrying its own
  // label — never silently fall back to a generic step the way an unmapped kind would.
  // A settled decision must leave the pending-approval shape: each closed outcome projects onto the
  // activity kind it already has, and only an event WITHOUT an outcome is still an open approval.
  it.each([
    ["accepted", "approved", "activity.event.operatorDecisionAccepted"],
    ["denied", "rejected", "activity.event.operatorDecisionDenied"],
    ["unavailable", "rejected", "activity.event.operatorDecisionUnavailable"],
    ["limit-reached", "rejected", "activity.event.operatorDecisionExpired"],
    ["stopped", "stopped", "activity.event.operatorDecisionStopped"],
  ] as const)("projects a settled operator decision (%s) as %s", (outcome, type, labelKey) => {
    const event: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: `cursor-${outcome}`,
      sequence: 3,
      occurredAt: "2026-06-15T10:00:03.000Z",
      kind: "runtime-event",
      runId: "run-1",
      state: "running",
      revision: 4,
      eventKind: "operator-decision",
      auxiliaryOutcome: outcome,
    };

    act(() => logRuntimeActivityEvents([event]));

    expect(getActivity()[0]).toMatchObject({ id: `run-1:cursor-${outcome}`, type, labelKey });
  });

  it("projects an operator-decision runtime event as an approval on the operator's own label", () => {
    const event: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: "cursor-2",
      sequence: 2,
      occurredAt: "2026-06-15T10:00:02.000Z",
      kind: "runtime-event",
      runId: "run-1",
      state: "awaiting-approval",
      revision: 3,
      eventKind: "operator-decision",
    };

    act(() => logRuntimeActivityEvents([event]));

    expect(getActivity()[0]).toMatchObject({
      id: "run-1:cursor-2",
      type: "approval",
      labelKey: "activity.event.operatorDecision",
      agent: "runtime",
      time: Date.parse(event.occurredAt),
    });
  });

  function decisionEvent(
    cursor: string,
    sequence: number,
    auxiliaryOutcome?: "accepted" | "denied",
    runId = "run-1",
  ): CodingWorkbenchRuntimeSseEvent {
    return {
      schemaVersion: "1",
      cursor,
      sequence,
      occurredAt: "2026-06-15T10:00:02.000Z",
      kind: "runtime-event",
      runId,
      state: auxiliaryOutcome === undefined ? "awaiting-approval" : "running",
      revision: sequence,
      eventKind: "operator-decision",
      ...(auxiliaryOutcome === undefined ? {} : { auxiliaryOutcome }),
    };
  }

  // Owner review, PR #3452: the open decision and its settlement are two events with two cursors,
  // so the settlement must retire the pending entry instead of sitting beside it.
  it("retires the open decision entry its settlement follows", () => {
    act(() =>
      logRuntimeActivityEvents([
        decisionEvent("cursor-2", 2),
        decisionEvent("cursor-3", 3, "accepted"),
      ]),
    );

    expect(getActivity()).toHaveLength(1);
    expect(getActivity()[0]).toMatchObject({ id: "run-1:cursor-3", type: "approved" });
  });

  it("does not re-admit an open decision replayed after its settlement", () => {
    act(() =>
      logRuntimeActivityEvents([
        decisionEvent("cursor-2", 2),
        decisionEvent("cursor-3", 3, "denied"),
      ]),
    );
    act(() => logRuntimeActivityEvents([decisionEvent("cursor-2", 2)]));

    expect(getActivity().map((entry) => entry.type)).toEqual(["rejected"]);
  });

  it("keeps a settled decision when the run opens its next one, and never crosses runs", () => {
    act(() =>
      logRuntimeActivityEvents([
        decisionEvent("cursor-2", 2),
        decisionEvent("cursor-9", 9, undefined, "run-2"),
        decisionEvent("cursor-3", 3, "accepted"),
        decisionEvent("cursor-5", 5),
      ]),
    );

    expect(getActivity().map((entry) => [entry.id, entry.type])).toEqual([
      ["run-1:cursor-5", "approval"],
      ["run-1:cursor-3", "approved"],
      ["run-2:cursor-9", "approval"],
    ]);
  });
});
