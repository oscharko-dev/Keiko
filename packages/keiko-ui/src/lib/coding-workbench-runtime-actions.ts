import { useMemo, type Dispatch, type RefObject } from "react";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeResearchGrant,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import type { RuntimeMutationActions, RuntimeResources } from "./coding-workbench-runtime-hooks";

export interface CodingWorkbenchRuntimeActions {
  readonly setRequestedMode: (mode: CodingWorkbenchMode) => void;
  readonly setRuntimePreference: (preference: CodingWorkbenchRuntimePreference) => void;
  readonly setSelectedModel: (modelId: string | null) => void;
  readonly setReasoningEffort: (effort: ModelReasoningEffort | null) => void;
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
  readonly pause: () => Promise<void>;
  readonly resume: (requestedMode: CodingWorkbenchMode) => Promise<void>;
  readonly submitFollowUp: (taskIntent: string) => Promise<void>;
  readonly revokeResearchGrant: (grant: CodingWorkbenchRuntimeResearchGrant) => Promise<void>;
}

interface RuntimeActionInput {
  readonly stateRef: RefObject<CodingWorkbenchRuntimeState>;
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
  const {
    acknowledgeRecovery,
    decideApproval,
    pause,
    resume,
    retry,
    revokeResearchGrant,
    start,
    stop,
    submitFollowUp,
    takeover,
  } = mutations;
  return {
    setRequestedMode: (mode) => dispatch({ kind: "select-mode", mode }),
    setRuntimePreference: (preference) => {
      if (stateRef.current.runtimePreference === preference) return;
      profileSequence.current += 1;
      sourceSequence.current += 1;
      dispatch({ kind: "select-runtime-preference", preference });
    },
    setSelectedModel: (modelId) => dispatch({ kind: "select-model", modelId }),
    setReasoningEffort: (effort) => dispatch({ kind: "select-reasoning-effort", effort }),
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
    pause,
    resume,
    submitFollowUp,
    revokeResearchGrant,
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
  const {
    acknowledgeRecovery,
    decideApproval,
    pause,
    resume,
    retry,
    revokeResearchGrant,
    start,
    stop,
    submitFollowUp,
    takeover,
  } = mutations;
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
        mutations: {
          acknowledgeRecovery,
          decideApproval,
          pause,
          resume,
          retry,
          revokeResearchGrant,
          start,
          stop,
          submitFollowUp,
          takeover,
        },
      }),
    [
      acknowledgeRecovery,
      decideApproval,
      dispatch,
      pause,
      prepareCodexSetup,
      profileSequence,
      refreshProfile,
      refreshRun,
      refreshRuntime,
      refreshSource,
      resume,
      retry,
      revokeResearchGrant,
      sourceSequence,
      start,
      stateRef,
      stop,
      submitFollowUp,
      takeover,
    ],
  );
}
