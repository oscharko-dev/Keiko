import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  codingWorkbenchStreamRunId,
  useCodingWorkbenchWorkspaceEffect,
} from "./coding-workbench-runtime-effects";
import { STREAMABLE_RUNTIME_STATES } from "./useCodingWorkbenchRuntime";
import type { CodingWorkbenchRuntimeState } from "./coding-workbench-live-state";

describe("codingWorkbenchStreamRunId", () => {
  // #2386 regression: pausing must NOT tear down the run's event stream. With "paused" missing
  // from the streamable set, Pause silently closed the EventSource and the follow-up's
  // task-submitted event (and any later question signal) never reached the timeline.
  it("keeps the stream attached across the paused state", () => {
    const stateFor = (state: string): CodingWorkbenchRuntimeState =>
      ({
        run: { status: "ready", value: { runId: "run-1", state }, error: null },
      }) as unknown as CodingWorkbenchRuntimeState;
    expect(codingWorkbenchStreamRunId(stateFor("running"), STREAMABLE_RUNTIME_STATES)).toBe(
      "run-1",
    );
    expect(codingWorkbenchStreamRunId(stateFor("paused"), STREAMABLE_RUNTIME_STATES)).toBe("run-1");
    expect(
      codingWorkbenchStreamRunId(stateFor("cancelled"), STREAMABLE_RUNTIME_STATES),
    ).toBeUndefined();
  });
});

describe("useCodingWorkbenchWorkspaceEffect", () => {
  it("projects a workspace load error as a retryable resource failure", () => {
    const dispatch = vi.fn();
    renderHook(() => {
      useCodingWorkbenchWorkspaceEffect({
        activeBinding: null,
        activeInstance: null,
        error: "workspace offline",
        loading: false,
        switching: false,
        dispatch,
      });
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "resource-failed",
      resource: "workspace",
      status: "error",
      error: {
        code: "TASK_WORKSPACE_UNAVAILABLE",
        message: "workspace offline",
        retryable: true,
      },
    });
  });

  it("clears the workspace projection when no task workspace is bound", () => {
    const dispatch = vi.fn();
    renderHook(() => {
      useCodingWorkbenchWorkspaceEffect({
        activeBinding: null,
        activeInstance: null,
        error: null,
        loading: false,
        switching: false,
        dispatch,
      });
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: "workspace-set", workspace: null });
  });

  it("reports a loading workspace before any binding truth exists", () => {
    const dispatch = vi.fn();
    renderHook(() => {
      useCodingWorkbenchWorkspaceEffect({
        activeBinding: null,
        activeInstance: null,
        error: null,
        loading: true,
        switching: false,
        dispatch,
      });
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: "resource-loading", resource: "workspace" });
  });
});
