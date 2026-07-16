import { useMemo, type Dispatch, type MutableRefObject } from "react";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePreference,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import type { RuntimeMutationActions, RuntimeResources } from "./coding-workbench-runtime-hooks";

export interface CodingWorkbenchRuntimeActions {
  readonly setRequestedMode: (mode: CodingWorkbenchMode) => void;
  readonly setRuntimePreference: (preference: CodingWorkbenchRuntimePreference) => void;
  readonly prepareCodexSetup?:
    ((method: CodingWorkbenchCodexAuthMethod) => Promise<void>) | undefined;
  readonly refreshProfile: () => Promise<void>;
  readonly refreshSource: () => Promise<void>;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshRun: () => Promise<void>;
  readonly start: (taskIntent: string) => Promise<void>;
  readonly decideApproval: (decision: CodingWorkbenchRuntimeApprovalDecision) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly takeover: () => Promise<void>;
  readonly retry: (taskIntent: string) => Promise<void>;
  readonly acknowledgeRecovery: () => Promise<void>;
}

interface RuntimeActionInput {
  readonly stateRef: MutableRefObject<CodingWorkbenchRuntimeState>;
  readonly dispatch: Dispatch<CodingWorkbenchRuntimeStateAction>;
  readonly resources: RuntimeResources;
  readonly mutations: RuntimeMutationActions;
}

function createCodingWorkbenchRuntimeActions({
  stateRef,
  dispatch,
  resources,
  mutations,
}: RuntimeActionInput): CodingWorkbenchRuntimeActions {
  const {
    prepareCodexSetup,
    profileSequence,
    refreshProfile,
    refreshRun,
    refreshRuntime,
    refreshSource,
    sourceSequence,
  } = resources;
  const { acknowledgeRecovery, decideApproval, retry, start, stop, takeover } = mutations;
  return {
    setRequestedMode: (mode) => dispatch({ kind: "select-mode", mode }),
    setRuntimePreference: (preference) => {
      if (stateRef.current.runtimePreference === preference) return;
      profileSequence.current += 1;
      sourceSequence.current += 1;
      dispatch({ kind: "select-runtime-preference", preference });
    },
    prepareCodexSetup,
    refreshProfile,
    refreshSource,
    refreshRuntime,
    refreshRun,
    start,
    decideApproval,
    stop,
    takeover,
    retry,
    acknowledgeRecovery,
  };
}

export function useCodingWorkbenchRuntimeActions(
  input: RuntimeActionInput,
): CodingWorkbenchRuntimeActions {
  const { stateRef, dispatch, resources, mutations } = input;
  const {
    prepareCodexSetup,
    profileSequence,
    refreshProfile,
    refreshRun,
    refreshRuntime,
    refreshSource,
    sourceSequence,
  } = resources;
  const { acknowledgeRecovery, decideApproval, retry, start, stop, takeover } = mutations;
  return useMemo(
    () =>
      createCodingWorkbenchRuntimeActions({
        stateRef,
        dispatch,
        resources: {
          prepareCodexSetup,
          profileSequence,
          refreshProfile,
          refreshRun,
          refreshRuntime,
          refreshSource,
          sourceSequence,
        },
        mutations: { acknowledgeRecovery, decideApproval, retry, start, stop, takeover },
      }),
    [
      acknowledgeRecovery,
      decideApproval,
      dispatch,
      prepareCodexSetup,
      profileSequence,
      refreshProfile,
      refreshRun,
      refreshRuntime,
      refreshSource,
      retry,
      sourceSequence,
      start,
      stateRef,
      stop,
      takeover,
    ],
  );
}
