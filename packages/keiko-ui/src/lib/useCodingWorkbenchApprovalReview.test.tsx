import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchApprovalReview,
  type UseCodingWorkbenchApprovalReviewInput,
} from "./useCodingWorkbenchApprovalReview";

const getApprovalReviewMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  getCodingWorkbenchRuntimeApprovalReview: getApprovalReviewMock,
}));

const REVIEW = {
  requestId: "permission-7",
  paths: ["src/alpha.ts", "src/beta.ts"],
  pathsTruncated: false,
  fileCount: 2,
  addedLines: 12,
  deletedLines: 4,
} as const;

const RUN: UseCodingWorkbenchApprovalReviewInput = {
  runId: "run-1",
  permissionRequestId: "permission-7",
};

function active(): CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  return { session: "active", pending: REVIEW };
}

async function flushRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useCodingWorkbenchApprovalReview", () => {
  beforeEach(() => {
    pairingSettledMock.mockResolvedValue(undefined);
    getApprovalReviewMock.mockResolvedValue(active());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("stays idle and reads nothing while no approval is pending", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchApprovalReview({ runId: "run-1", permissionRequestId: undefined }),
    );
    await flushRead();

    expect(result.current).toEqual({
      status: "idle",
      review: null,
      retry: expect.any(Function),
    });
    expect(getApprovalReviewMock).not.toHaveBeenCalled();
  });

  it("stays idle without a run id", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchApprovalReview({ runId: undefined, permissionRequestId: "permission-7" }),
    );
    await flushRead();

    expect(result.current).toEqual({
      status: "idle",
      review: null,
      retry: expect.any(Function),
    });
    expect(getApprovalReviewMock).not.toHaveBeenCalled();
  });

  it("waits for pairing to settle, then publishes the reviewable changeset facts", async () => {
    const { result } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));
    expect(result.current).toEqual({
      status: "loading",
      review: null,
      retry: expect.any(Function),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        status: "ready",
        review: REVIEW,
        retry: expect.any(Function),
      });
    });
    expect(pairingSettledMock).toHaveBeenCalledOnce();
    expect(getApprovalReviewMock).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  });

  // Workbench audit, 2026-09-03: before `retry`, a transient failure while a file-edit approval was
  // open left the operator stuck on "unavailable" forever — nothing else re-triggers a fetch while
  // runId/permissionRequestId stay the same during that one decision.
  it("re-reads on demand via retry() without any input changing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getApprovalReviewMock.mockRejectedValueOnce(new Error("transient"));
    getApprovalReviewMock.mockResolvedValueOnce(active());
    const { result } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));
    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(getApprovalReviewMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.retry();
    });
    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.review).toEqual(REVIEW);
    expect(getApprovalReviewMock).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable for an unpaired window instead of an empty change summary", async () => {
    getApprovalReviewMock.mockResolvedValue({ session: "unpaired" });
    const { result } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));

    await waitFor(() => {
      expect(result.current).toEqual({
        status: "unavailable",
        review: null,
        retry: expect.any(Function),
      });
    });
  });

  it("reports unavailable when the paired channel carries no review for the pending ask", async () => {
    getApprovalReviewMock.mockResolvedValue({ session: "active" });
    const { result } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));

    await waitFor(() => {
      expect(result.current).toEqual({
        status: "unavailable",
        review: null,
        retry: expect.any(Function),
      });
    });
  });

  it("reports unavailable and stays diagnosable when the channel read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getApprovalReviewMock.mockRejectedValue(new Error("channel down"));
    const { result } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));

    await waitFor(() => {
      expect(result.current).toEqual({
        status: "unavailable",
        review: null,
        retry: expect.any(Function),
      });
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("re-reads for a new pending request and never shows the previous ask's files", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchApprovalReviewInput) => useCodingWorkbenchApprovalReview(input),
      { initialProps: RUN },
    );
    await waitFor(() => {
      expect(result.current.review).toEqual(REVIEW);
    });

    const next = {
      requestId: "permission-8",
      paths: ["src/gamma.ts"],
      pathsTruncated: false,
      fileCount: 1,
      addedLines: 1,
      deletedLines: 0,
    } as const;
    getApprovalReviewMock.mockResolvedValue({ session: "active", pending: next });
    rerender({ runId: "run-1", permissionRequestId: "permission-8" });

    // The scoped state is discarded the moment the input changes: a stale review can never be
    // rendered against a different approval decision.
    expect(result.current).toEqual({
      status: "loading",
      review: null,
      retry: expect.any(Function),
    });
    await waitFor(() => {
      expect(result.current).toEqual({
        status: "ready",
        review: next,
        retry: expect.any(Function),
      });
    });
  });

  it("aborts the in-flight read on unmount and publishes nothing afterwards", async () => {
    let capturedSignal: AbortSignal | undefined;
    getApprovalReviewMock.mockImplementation((_runId: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => undefined);
    });
    const { unmount } = renderHook(() => useCodingWorkbenchApprovalReview(RUN));
    await flushRead();

    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
