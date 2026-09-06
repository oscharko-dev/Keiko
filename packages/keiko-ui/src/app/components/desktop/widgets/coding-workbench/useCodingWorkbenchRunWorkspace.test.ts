/**
 * Hook tests for useCodingWorkbenchRunWorkspace.
 *
 * Regression context (#3381 review): run attribution used to be read from the shell's live
 * workspace pointer. The server binds a run to the pointer it reads synchronously when Start
 * arrives and then awaits runtime startup, so the response's `runId` can land after the operator
 * moved that pointer — at which point every surface that describes the run (composer chips, context
 * bar, Git target, editor-bridge root) named the wrong workspace while the run's authority stayed
 * with the workspace it started in. These tests pin the submission-time capture, the lock that
 * holds it for the run's lifetime, and the mismatch signal that is the ONLY thing the live pointer
 * is allowed to decide.
 */
import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CodingWorkbenchWorkspaceProjection } from "@/lib/coding-workbench-live-state";
import {
  useCodingWorkbenchRunWorkspace,
  type CodingWorkbenchRunWorkspace,
  type CodingWorkbenchRunWorkspaceBinding,
} from "./useCodingWorkbenchRunWorkspace";

function projection(workspaceId: string, taskBranch: string): CodingWorkbenchWorkspaceProjection {
  return {
    workspaceId,
    taskId: `task-${workspaceId}`,
    taskBranch,
    health: "healthy",
    switching: false,
  };
}

const WORKSPACE_A: CodingWorkbenchRunWorkspace = {
  root: "/worktrees/a",
  taskBranch: "issue/a",
  workspace: projection("workspace-a", "issue/a"),
  trust: {
    repositoryRoot: "/repos/a",
    repositoryId: "repository-a",
    workspaceId: "workspace-a",
    correlationId: "correlation-workspace-a",
  },
};

const WORKSPACE_B: CodingWorkbenchRunWorkspace = {
  root: "/worktrees/b",
  taskBranch: "issue/b",
  workspace: projection("workspace-b", "issue/b"),
  trust: {
    repositoryRoot: "/repos/b",
    repositoryId: "repository-b",
    workspaceId: "workspace-b",
    correlationId: "correlation-workspace-b",
  },
};

const UNBOUND: CodingWorkbenchRunWorkspace = {
  root: null,
  taskBranch: null,
  workspace: null,
  trust: null,
};

interface Props {
  readonly runId: string | undefined;
  readonly live: CodingWorkbenchRunWorkspace;
  readonly bindingPending: boolean;
}

function renderRunWorkspace(
  initialProps: Props,
): RenderHookResult<CodingWorkbenchRunWorkspaceBinding, Props> {
  return renderHook((props: Props) => useCodingWorkbenchRunWorkspace(props), { initialProps });
}

describe("useCodingWorkbenchRunWorkspace", () => {
  it("attributes a delayed Start to the workspace it was submitted against", () => {
    const { result, rerender } = renderRunWorkspace({
      runId: undefined,
      live: WORKSPACE_A,
      bindingPending: false,
    });
    act(() => {
      result.current.captureSubmission();
    });

    // The operator moves the singleton pointer while the Start request is still in flight, and the
    // binding is transiently unreadable during the switch.
    rerender({ runId: undefined, live: UNBOUND, bindingPending: true });
    rerender({ runId: undefined, live: WORKSPACE_B, bindingPending: false });
    // The delayed Start response finally lands.
    rerender({ runId: "run-1", live: WORKSPACE_B, bindingPending: false });

    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
    expect(result.current.mismatched).toBe(true);
  });

  it("holds the run's workspace across a mid-run switch and reports the mismatch", () => {
    const { result, rerender } = renderRunWorkspace({
      runId: undefined,
      live: WORKSPACE_A,
      bindingPending: false,
    });
    act(() => {
      result.current.captureSubmission();
    });
    rerender({ runId: "run-1", live: WORKSPACE_A, bindingPending: false });
    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
    expect(result.current.mismatched).toBe(false);

    rerender({ runId: "run-1", live: WORKSPACE_B, bindingPending: false });
    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
    expect(result.current.mismatched).toBe(true);

    // Switching back re-aligns the pointer with the run; the attribution never moved.
    rerender({ runId: "run-1", live: WORKSPACE_A, bindingPending: false });
    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
    expect(result.current.mismatched).toBe(false);
  });

  it("never claims a mismatch while the live binding is unsettled", () => {
    const { result, rerender } = renderRunWorkspace({
      runId: "run-1",
      live: WORKSPACE_A,
      bindingPending: false,
    });
    rerender({ runId: "run-1", live: UNBOUND, bindingPending: true });

    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
    expect(result.current.mismatched).toBe(false);
  });

  it("adopts the live workspace for a run it did not submit, once the binding settles", () => {
    const { result, rerender } = renderRunWorkspace({
      runId: "run-1",
      live: UNBOUND,
      bindingPending: true,
    });
    expect(result.current.bound).toStrictEqual(UNBOUND);

    rerender({ runId: "run-1", live: WORKSPACE_A, bindingPending: false });
    expect(result.current.bound).toStrictEqual(WORKSPACE_A);
  });

  it("re-arms for a new run and forgets the previous run's workspace", () => {
    const { result, rerender } = renderRunWorkspace({
      runId: undefined,
      live: WORKSPACE_A,
      bindingPending: false,
    });
    act(() => {
      result.current.captureSubmission();
    });
    rerender({ runId: "run-1", live: WORKSPACE_A, bindingPending: false });

    // A second run submitted from workspace B: the capture belongs to it, not to run-1.
    rerender({ runId: "run-1", live: WORKSPACE_B, bindingPending: false });
    act(() => {
      result.current.captureSubmission();
    });
    rerender({ runId: "run-2", live: WORKSPACE_B, bindingPending: false });

    expect(result.current.bound).toStrictEqual(WORKSPACE_B);
    expect(result.current.mismatched).toBe(false);
  });

  it("reports no attribution at all while no run is bound", () => {
    const { result } = renderRunWorkspace({
      runId: undefined,
      live: WORKSPACE_A,
      bindingPending: false,
    });

    expect(result.current.bound).toBeNull();
    expect(result.current.mismatched).toBe(false);
  });
});
