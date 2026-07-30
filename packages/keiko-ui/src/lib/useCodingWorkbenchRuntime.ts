"use client";

import { useReducer, useRef, useState } from "react";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceApi } from "@/app/components/desktop/context/ActiveWorkspaceContext";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  useCodingWorkbenchRuntimeMutations,
  useCodingWorkbenchRuntimeResources,
} from "./coding-workbench-runtime-hooks";
import {
  useCodingWorkbenchRuntimeActions,
  type CodingWorkbenchRuntimeActions,
} from "./coding-workbench-runtime-actions";
import {
  codingWorkbenchStreamRunId,
  useCodingWorkbenchPairingEffect,
  useCodingWorkbenchRuntimeRefreshEffects,
  useCodingWorkbenchRuntimeStream,
  useCodingWorkbenchWorkspaceEffect,
} from "./coding-workbench-runtime-effects";
import { codingWorkbenchRuntimeReducer } from "./coding-workbench-live-state";

export type { CodingWorkbenchRuntimeActions } from "./coding-workbench-runtime-actions";

export interface UseCodingWorkbenchRuntimeInput {
  readonly workspace: Pick<
    ActiveWorkspaceApi,
    "activeBinding" | "activeInstance" | "loading" | "switching" | "error" | "refresh"
  >;
  readonly initialRequestedMode?: CodingWorkbenchMode | undefined;
  readonly initialRuntimePreference?: CodingWorkbenchRuntimePreference | undefined;
}

export interface UseCodingWorkbenchRuntimeResult {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
}

export const STREAMABLE_RUNTIME_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
  // #2386: a paused run stays live — the stream must survive Pause, or the follow-up's
  // task-submitted event (and any later question signal) never reaches the timeline.
  "paused",
  "awaiting-approval",
  "stopping",
  "recovery-required",
]);

export function useCodingWorkbenchRuntime(
  input: UseCodingWorkbenchRuntimeInput,
): UseCodingWorkbenchRuntimeResult {
  const { activeBinding, activeInstance, error, loading, switching } = input.workspace;
  const [state, dispatch] = useReducer(codingWorkbenchRuntimeReducer, undefined, () =>
    createInitialCodingWorkbenchRuntimeState(
      input.initialRequestedMode,
      input.initialRuntimePreference,
    ),
  );
  const [streamEpoch, setStreamEpoch] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const resources = useCodingWorkbenchRuntimeResources(stateRef, dispatch);
  const mutations = useCodingWorkbenchRuntimeMutations({
    stateRef,
    refreshRun: resources.refreshRun,
    dispatch,
  });
  useCodingWorkbenchPairingEffect(dispatch);
  useCodingWorkbenchRuntimeRefreshEffects({ state, ...resources });
  useCodingWorkbenchWorkspaceEffect({
    activeBinding,
    activeInstance,
    error,
    loading,
    switching,
    dispatch,
  });
  const streamRunId = codingWorkbenchStreamRunId(state, STREAMABLE_RUNTIME_STATES);
  useCodingWorkbenchRuntimeStream({
    runId: streamRunId,
    streamEpoch,
    stateRef,
    refreshRun: resources.refreshRun,
    dispatch,
    setStreamEpoch,
  });

  const actions = useCodingWorkbenchRuntimeActions({ stateRef, dispatch, resources, mutations });
  return { state, actions };
}
