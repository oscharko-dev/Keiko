/**
 * STEP 07 cluster B — GEN-PERF-RENDER-005.
 *
 * The capsule-detail job poller (2s setInterval while a capsule is indexing/queued/
 * running) must PAUSE while the tab is hidden and resume with a single immediate
 * catch-up load on return to visible — it previously kept fetching every 2s in a
 * background tab for the whole (minutes-long) ingestion.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCapsuleDetail } from "./capsule-detail-state";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
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

describe("Knowledge Pod selection evidence", () => {
  afterEach(() => {
    cleanup();
    resetClientDiagnosticWriter();
  });

  it("records a failed detail load without claiming the selection was applied", async () => {
    const diagnostic = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(diagnostic);
    const fetchImpl = vi.fn(() => Promise.reject(new Error("PRIVATE detail unavailable")));
    const { result } = renderHook(() => useCapsuleDetail(capsuleId(), fetchImpl));
    await waitFor(() => expect(result.current.loadStatus).toBe("error"));
    expect(diagnostic).toHaveBeenCalledWith(
      "Knowledge Pod selection settled.",
      expect.objectContaining({
        stageReport: expect.objectContaining({ navigationOutcome: "failed" }),
      }),
    );
    expect(
      diagnostic.mock.calls.some(([, meta]) => {
        const stage = meta?.stageReport;
        return stage?.phase === "settled" && stage.navigationOutcome === "applied";
      }),
    ).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE detail unavailable");
  });

  it("settles selection only after its actual detail request resolves", async () => {
    const diagnostic = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(diagnostic);
    let finish: ((value: CapsuleDetail) => void) | undefined;
    const pending = new Promise<CapsuleDetail>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = vi.fn(() => pending);
    const { result } = renderHook(() => useCapsuleDetail(capsuleId(), fetchImpl));
    expect(diagnostic).toHaveBeenCalledWith("Knowledge Pod selection started.", expect.any(Object));
    expect(
      diagnostic.mock.calls.some(([message]) => message === "Knowledge Pod selection settled."),
    ).toBe(false);
    const base = indexingDetail();
    const detail: CapsuleDetail = {
      ...base,
      capsule: { ...base.capsule, id: capsuleId(), lifecycleState: "ready" },
      indexingJobs: [],
    };
    await act(async () => {
      finish?.(detail);
      await pending;
    });
    expect(result.current.data).toBe(detail);
    expect(diagnostic).toHaveBeenCalledWith(
      "Knowledge Pod selection settled.",
      expect.objectContaining({
        stageReport: expect.objectContaining({ navigationOutcome: "applied" }),
      }),
    );
  });
});

describe("useCapsuleDetail scope ownership", () => {
  afterEach(cleanup);

  it.each([false, true])(
    "ignores a previous selection's late mutation result, including a return to the same pod: %s",
    async (returnToFirst) => {
      const firstId = "cap-first" as KnowledgeCapsuleId;
      const secondId = "cap-second" as KnowledgeCapsuleId;
      const detailFor = (id: KnowledgeCapsuleId): CapsuleDetail =>
        ({
          capsule: { id, lifecycleState: "ready" },
          indexingJobs: [],
        }) as unknown as CapsuleDetail;
      const firstDetail = detailFor(firstId);
      const secondDetail = detailFor(secondId);
      const fetchImpl = vi.fn((id: KnowledgeCapsuleId) =>
        Promise.resolve(id === firstId ? firstDetail : secondDetail),
      );
      const { result, rerender } = renderHook(({ id }) => useCapsuleDetail(id, fetchImpl), {
        initialProps: { id: firstId },
      });
      await waitFor(() => expect(result.current.data).toBe(firstDetail));
      const previousSave = result.current.replaceData;
      rerender({ id: secondId });
      await waitFor(() => expect(result.current.data).toBe(secondDetail));
      if (returnToFirst) {
        rerender({ id: firstId });
        await waitFor(() => expect(result.current.data).toBe(firstDetail));
      }
      const current = result.current.data;
      act(() => previousSave(detailFor(firstId)));
      expect(result.current.data).toBe(current);
      act(() => result.current.replaceData(detailFor(returnToFirst ? secondId : firstId)));
      expect(result.current.data).toBe(current);
      const updated = detailFor(returnToFirst ? firstId : secondId);
      act(() => result.current.replaceData(updated));
      expect(result.current.data).toBe(updated);
    },
  );

  it("ignores a previous pod's late detail response after switching the selected pod", async () => {
    const firstId = "cap-first" as KnowledgeCapsuleId;
    const secondId = "cap-second" as KnowledgeCapsuleId;
    const firstDetail = {
      capsule: { id: firstId, lifecycleState: "ready" },
      indexingJobs: [],
    } as unknown as CapsuleDetail;
    const secondDetail = {
      capsule: { id: secondId, lifecycleState: "draft" },
      indexingJobs: [],
    } as unknown as CapsuleDetail;
    let finishFirst: (value: CapsuleDetail) => void = () => undefined;
    const first = new Promise<CapsuleDetail>((resolve) => {
      finishFirst = resolve;
    });
    const fetchImpl = vi.fn((id: KnowledgeCapsuleId) =>
      id === firstId ? first : Promise.resolve(secondDetail),
    );
    const { result, rerender } = renderHook(({ id }) => useCapsuleDetail(id, fetchImpl), {
      initialProps: { id: firstId },
    });
    rerender({ id: secondId });
    await waitFor(() => expect(result.current.data).toBe(secondDetail));
    await act(async () => {
      finishFirst(firstDetail);
      await first;
    });
    expect(result.current.data).toBe(secondDetail);
  });
});

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
