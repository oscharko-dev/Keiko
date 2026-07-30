import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  codingWorkbenchStreamRunId,
  useCodingWorkbenchPairingEffect,
  useCodingWorkbenchWorkspaceEffect,
} from "./coding-workbench-runtime-effects";
import { STREAMABLE_RUNTIME_STATES } from "./useCodingWorkbenchRuntime";
import type { CodingWorkbenchRuntimeState } from "./coding-workbench-live-state";

const manifestAccessMock = vi.hoisted(() => vi.fn());
vi.mock("./workspace-manifest-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-manifest-api")>();
  return { ...actual, fetchWorkspaceManifestAccess: manifestAccessMock };
});

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

describe("useCodingWorkbenchPairingEffect (release-audit F-08/RG-12)", () => {
  it("projects the honest workspaces session answer into the pairing dimension", async () => {
    manifestAccessMock.mockResolvedValue({ session: "unpaired", manifests: [] });
    const dispatch = vi.fn();
    renderHook(() => {
      useCodingWorkbenchPairingEffect(dispatch);
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ kind: "pairing-set", pairing: "unpaired" });
    });
  });

  it("stays fail-closed on unknown when the workspaces read cannot answer", async () => {
    manifestAccessMock.mockRejectedValue(new Error("redacted transport failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn();
    renderHook(() => {
      useCodingWorkbenchPairingEffect(dispatch);
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ kind: "pairing-set", pairing: "unknown" });
    });
    // A BFF or validation outage must stay diagnosable rather than look like an initial boot.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // #2843 review: both cleanup guards. A settled read after unmount must dispatch nothing, or a
  // late answer would revive the pairing dimension of a destroyed workbench.
  it.each(["resolve", "reject"] as const)(
    "dispatches nothing when the workspaces read %ss after unmount",
    async (settle) => {
      let settleRead: () => void = () => undefined;
      manifestAccessMock.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settleRead =
              settle === "resolve"
                ? (): void => resolve({ session: "paired", manifests: [] })
                : (): void => reject(new Error("redacted transport failure"));
          }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const dispatch = vi.fn();
      const { unmount } = renderHook(() => {
        useCodingWorkbenchPairingEffect(dispatch);
      });

      unmount();
      settleRead();
      await Promise.resolve();
      await Promise.resolve();

      expect(dispatch).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );
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
