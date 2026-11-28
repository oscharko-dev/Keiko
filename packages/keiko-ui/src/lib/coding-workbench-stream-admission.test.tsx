import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";
import {
  admitDirectBrowserStream,
  resetBrowserStreamCapacityForTests,
} from "./browser-stream-capacity";
import { useCodingWorkbenchRuntimeEventStream } from "./coding-workbench-event-retention";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

// #4573: the Workbench run stream is the main surface. When other streams hold every origin slot at
// the moment it starts, it must still open eventually: it keeps asking for a slot on a bounded
// backoff instead of failing once, and background streams yield their slot to it.

class OpenedEventSource {
  static instances: OpenedEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
  constructor() {
    OpenedEventSource.instances.push(this);
  }
  addEventListener(): void {
    // No frames are delivered; the suite only observes when the connection is opened.
  }
  removeEventListener(): void {
    // See addEventListener.
  }
}

function runStream(
  onError: () => void,
  onCapacityWaiting?: (waiting: boolean) => void,
): { unmount: () => void } {
  return renderHook(() =>
    useCodingWorkbenchRuntimeEventStream("run-1", 0, {
      onOpen: vi.fn(),
      onEvents: vi.fn(),
      onError,
      ...(onCapacityWaiting === undefined ? {} : { onCapacityWaiting }),
      onReset: vi.fn(() => Promise.resolve()),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  OpenedEventSource.instances = [];
  vi.stubGlobal("EventSource", OpenedEventSource);
  Reflect.deleteProperty(document, "visibilityState");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: createOriginLocksFixture(),
  });
  resetBrowserStreamCapacityForTests();
});

afterEach(() => {
  resetBrowserStreamCapacityForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the Workbench run stream under full stream occupancy", () => {
  it("says it waits for a connection, then opens once a holder frees a slot, without an error", async () => {
    const onError = vi.fn();
    const onWaiting = vi.fn();
    const held = Array.from({ length: 4 }, () => admitDirectBrowserStream(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const view = runStream(onError, onWaiting);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(OpenedEventSource.instances).toHaveLength(0);
    expect(onWaiting.mock.calls).toEqual([[true]]);
    held[0]?.release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    // At least one: a silent stream is also reopened by the session's own stale watchdog.
    expect(OpenedEventSource.instances.length).toBeGreaterThan(0);
    expect(onWaiting.mock.calls).toEqual([[true], [false]]);
    expect(onError).not.toHaveBeenCalled();
    view.unmount();
    held.forEach((admission) => admission.release());
  });

  it("takes a slot from background streams that hold all four", async () => {
    const yielded = vi.fn();
    const held = Array.from({ length: 4 }, () =>
      admitDirectBrowserStream(() => undefined, { priority: "background", onYield: yielded }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const view = runStream(vi.fn());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(OpenedEventSource.instances).toHaveLength(1);
    expect(yielded).toHaveBeenCalledTimes(1);
    view.unmount();
    held.forEach((admission) => admission.release());
  });

  it("closes a hidden tab's run stream for a visible tab's essential stream and reopens it later", async () => {
    const held = Array.from({ length: 3 }, () => admitDirectBrowserStream(() => undefined));
    const view = runStream(vi.fn());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(OpenedEventSource.instances).toHaveLength(1);
    // Another tab's run stream queues for a slot while this document goes into the background.
    const admitted = vi.fn();
    const otherTab = admitDirectBrowserStream(admitted);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(OpenedEventSource.instances[0]?.close).toHaveBeenCalled();
    expect(admitted).toHaveBeenCalledOnce();
    otherTab.release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(OpenedEventSource.instances).toHaveLength(2);
    view.unmount();
    held.forEach((admission) => admission.release());
  });

  it("stops asking for a slot once the view unmounts", async () => {
    const held = Array.from({ length: 4 }, () => admitDirectBrowserStream(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const view = runStream(vi.fn());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    view.unmount();
    held[0]?.release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(OpenedEventSource.instances).toHaveLength(0);
    held.forEach((admission) => admission.release());
  });
});

describe("the Workbench run stream without an event source", () => {
  it("records a closed diagnostic and reports the failure instead of staying silent", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("EventSource", undefined);
    const reported: { message: string; kind: string | undefined }[] = [];
    setClientDiagnosticWriter((message, meta) => reported.push({ message, kind: meta?.errorKind }));
    const onError = vi.fn();
    try {
      const view = runStream(onError);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(reported).toContainEqual({
        message: "[keiko] coding workbench runtime stream could not be created",
        kind: "unavailable",
      });
      view.unmount();
    } finally {
      resetClientDiagnosticWriter();
    }
  });
});
