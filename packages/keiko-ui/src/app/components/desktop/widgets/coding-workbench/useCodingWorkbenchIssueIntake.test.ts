/**
 * #3384 review 3941836282: a rate limit, a GitHub-side 5xx, or a wall-time timeout reading an
 * issue is reported by the server as CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE
 * (issuePreviewRoutes.ts B5-13). Before this fix `issueFailure()` only recognized the closed
 * CodingWorkbenchIssueBindingFailure vocabulary (coding-workbench-issue-errors.ts) and turned any
 * other code into "unknown" — so the transient-specific retry copy could never be selected. This
 * pins the UI-local "read-transient-failure" state without widening the closed wire contract.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-shared-primitives";
import { useCodingWorkbenchIssueIntake } from "./useCodingWorkbenchIssueIntake";

const previewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, previewCodingWorkbenchIssue: previewMock };
});

afterEach(() => {
  previewMock.mockReset();
});

describe("useCodingWorkbenchIssueIntake — transient read failure", () => {
  it("maps CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE to read-transient-failure, not unknown", async () => {
    const rejection = new ApiError(
      "CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE",
      "GitHub could not be reached (rate limit or a temporary error). Try again.",
      503,
    );
    rejection.correlationId = "corr-transient-1";
    previewMock.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useCodingWorkbenchIssueIntake("/repos/keiko-checkout"));
    act(() => {
      result.current.change("#42");
    });
    act(() => {
      result.current.preview();
    });

    await waitFor(() => expect(result.current.state.kind).toBe("failed"));
    expect(result.current.state).toStrictEqual({
      kind: "failed",
      failure: "read-transient-failure",
      correlationId: "corr-transient-1",
    });
  });

  it("still falls back to unknown for a code outside the closed vocabulary and the transient code", async () => {
    previewMock.mockRejectedValueOnce(
      new ApiError("SOME_UNRELATED_CODE", "message not shown", 500),
    );

    const { result } = renderHook(() => useCodingWorkbenchIssueIntake("/repos/keiko-checkout"));
    act(() => {
      result.current.change("#42");
    });
    act(() => {
      result.current.preview();
    });

    await waitFor(() => expect(result.current.state.kind).toBe("failed"));
    expect(result.current.state).toMatchObject({ kind: "failed", failure: "unknown" });
  });
});
