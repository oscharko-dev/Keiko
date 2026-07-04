/**
 * STEP 07 cluster B — GEN-PERF-RENDER-005.
 *
 * The capsule-detail job poller (2s setInterval while a capsule is indexing/queued/
 * running) must PAUSE while the tab is hidden and resume with a single immediate
 * catch-up load on return to visible — it previously kept fetching every 2s in a
 * background tab for the whole (minutes-long) ingestion.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCapsuleDetail } from "./capsule-detail-state";
import type { CapsuleDetail } from "@/lib/local-knowledge-api";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

function capsuleId(): KnowledgeCapsuleId {
  return "cap-poll-1" as KnowledgeCapsuleId;
}

// A minimal indexing detail — only the fields the poller's isActive gate reads
// matter (capsule.lifecycleState + indexingJobs[0].status).
function indexingDetail(): CapsuleDetail {
  return {
    capsule: { lifecycleState: "indexing" },
    indexingJobs: [{ status: "running" }],
  } as unknown as CapsuleDetail;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("useCapsuleDetail poll visibility gate (GEN-PERF-RENDER-005)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops polling while hidden and does one immediate catch-up on return to visible", async () => {
    const fetchImpl = vi.fn(async () => Promise.resolve(indexingDetail()));
    renderHook(() => useCapsuleDetail(capsuleId(), fetchImpl));

    // Let the initial load resolve and the active-state poller effect commit.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // One poll tick while visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const beforeHidden = fetchImpl.mock.calls.length;

    // Hide the tab → the interval must stop; advancing time produces no new fetch.
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000 * 5);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(beforeHidden);

    // Return to visible → exactly one immediate catch-up load.
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchImpl).toHaveBeenCalledTimes(beforeHidden + 1);
  });
});
