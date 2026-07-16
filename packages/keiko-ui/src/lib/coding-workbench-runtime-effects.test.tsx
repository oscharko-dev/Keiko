import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodingWorkbenchWorkspaceEffect } from "./coding-workbench-runtime-effects";

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
