import { renderHook } from "@testing-library/react";
import { useRef, type Dispatch } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCodingWorkbenchRuntimeActions } from "./coding-workbench-runtime-actions";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import type { RuntimeMutationActions, RuntimeResources } from "./coding-workbench-runtime-hooks";

function mutations(): RuntimeMutationActions {
  return {
    start: vi.fn(() => Promise.resolve()),
    decideApproval: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    takeover: vi.fn(() => Promise.resolve()),
    retry: vi.fn(() => Promise.resolve()),
    acknowledgeRecovery: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    submitFollowUp: vi.fn(() => Promise.resolve()),
  };
}

function renderActions(dispatch: Dispatch<CodingWorkbenchRuntimeStateAction>): {
  readonly actions: ReturnType<typeof useCodingWorkbenchRuntimeActions>;
  readonly resources: RuntimeResources;
} {
  let resources: RuntimeResources | undefined;
  const view = renderHook(() => {
    const stateRef = useRef(createInitialCodingWorkbenchRuntimeState());
    const profileSequence = useRef(0);
    const sourceSequence = useRef(0);
    resources = {
      prepareCodexSetup: vi.fn(() => Promise.resolve()),
      profileSequence,
      refreshProfile: vi.fn(() => Promise.resolve()),
      refreshRun: vi.fn(() => Promise.resolve()),
      refreshRuntime: vi.fn(() => Promise.resolve()),
      refreshSource: vi.fn(() => Promise.resolve()),
      sourceSequence,
    };
    return useCodingWorkbenchRuntimeActions({
      stateRef,
      dispatch,
      resources,
      mutations: mutations(),
    });
  });
  if (resources === undefined) throw new Error("resources were not initialized");
  return { actions: view.result.current, resources };
}

describe("useCodingWorkbenchRuntimeActions", () => {
  it("dispatches a mode selection intent", () => {
    const dispatch = vi.fn();
    const { actions } = renderActions(dispatch);
    actions.setRequestedMode("supervised-coding");
    expect(dispatch).toHaveBeenCalledWith({ kind: "select-mode", mode: "supervised-coding" });
  });

  it("ignores re-selecting the active runtime preference without bumping sequences", () => {
    const dispatch = vi.fn();
    const { actions, resources } = renderActions(dispatch);
    actions.setRuntimePreference("managed-gateway");
    expect(dispatch).not.toHaveBeenCalled();
    expect(resources.profileSequence.current).toBe(0);
    expect(resources.sourceSequence.current).toBe(0);
  });

  it("invalidates in-flight profile and source refreshes when the preference changes", () => {
    const dispatch = vi.fn();
    const { actions, resources } = renderActions(dispatch);
    actions.setRuntimePreference("codex-subscription");
    expect(dispatch).toHaveBeenCalledWith({
      kind: "select-runtime-preference",
      preference: "codex-subscription",
    });
    expect(resources.profileSequence.current).toBe(1);
    expect(resources.sourceSequence.current).toBe(1);
  });
});
