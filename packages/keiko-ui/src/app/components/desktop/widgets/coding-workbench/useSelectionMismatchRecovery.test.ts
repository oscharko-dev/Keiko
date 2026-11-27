import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CodingWorkbenchMutationState } from "@/lib/coding-workbench-live-state";
import { useSelectionMismatchRecovery } from "./useSelectionMismatchRecovery";

function failedStart(code: string, requestId = "request-1"): CodingWorkbenchMutationState {
  return {
    status: "error",
    kind: "start",
    requestId,
    error: { code, message: "refused", retryable: false },
  };
}

const IDLE: CodingWorkbenchMutationState = {
  status: "idle",
  kind: null,
  requestId: null,
  error: null,
};

describe("useSelectionMismatchRecovery", () => {
  // The server refused the start because its active workspace is not the displayed repository: the
  // window reads the workspace again and binds the displayed repository, instead of leaving the
  // person with a generic error and a Start that keeps meeting the same refusal.
  it("reads the workspace again, then binds the displayed repository, once per refused start", async () => {
    const refresh = vi.fn(() => Promise.resolve(true));
    const rebind = vi.fn();
    const { rerender } = renderHook(
      ({ mutation }) => {
        useSelectionMismatchRecovery(mutation, refresh, rebind);
      },
      { initialProps: { mutation: IDLE } },
    );
    expect(refresh).not.toHaveBeenCalled();

    rerender({ mutation: failedStart("CODING_RUNTIME_WORKSPACE_SELECTION_MISMATCH") });
    await vi.waitFor(() => {
      expect(rebind).toHaveBeenCalledOnce();
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
      rebind.mock.invocationCallOrder[0] ?? 0,
    );

    rerender({ mutation: failedStart("CODING_RUNTIME_WORKSPACE_SELECTION_MISMATCH") });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["another refusal", failedStart("CODING_RUNTIME_ACTIVE_RUN_CONFLICT")],
    [
      "another action",
      { ...failedStart("CODING_RUNTIME_WORKSPACE_SELECTION_MISMATCH"), kind: "stop" as const },
    ],
  ])("does nothing for %s", (_name, mutation) => {
    const refresh = vi.fn(() => Promise.resolve(true));
    const rebind = vi.fn();
    renderHook(() => {
      useSelectionMismatchRecovery(mutation, refresh, rebind);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("does not bind when the workspace could not be read again", async () => {
    const refresh = vi.fn(() => Promise.resolve(false));
    const rebind = vi.fn();
    renderHook(() => {
      useSelectionMismatchRecovery(
        failedStart("CODING_RUNTIME_WORKSPACE_SELECTION_MISMATCH"),
        refresh,
        rebind,
      );
    });
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
    });
    expect(rebind).not.toHaveBeenCalled();
  });
});
