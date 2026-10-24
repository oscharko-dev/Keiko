import { useMemo, type Dispatch, type RefObject } from "react";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchMode,
  CodingWorkbenchPromptReference,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeResearchGrant,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchCommandRequest,
  CodingWorkbenchRuntimeForkRequest,
  CodingWorkbenchRuntimeInboxAction,
  CodingWorkbenchRuntimeRevertAction,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import type { RuntimeMutationActions, RuntimeResources } from "./coding-workbench-runtime-hooks";
import type { CodingWorkbenchFollowUpInputs } from "./coding-workbench-runtime-mutations";

export interface CodingWorkbenchIssueStartIntent {
  readonly issueRef: string;
  readonly expectedIssueBindingDigest: string;
}

export interface CodingWorkbenchStartOptions {
  readonly conversationId?: string | undefined;
  readonly issue?: CodingWorkbenchIssueStartIntent | undefined;
  readonly projectMemoryEnabled: boolean;
  /**
   * Workspace files the first prompt references with `@`, by path relative to the workspace the run
   * starts in (ADR-0137 D10). The server resolves them when the first turn is dispatched.
   */
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /** Starts the first turn with a slash command; the text is then the command's arguments. */
  readonly command?: CodingWorkbenchCommandRequest | undefined;
  /**
   * Starts a NEW task forked from another task (S03): from the task as it ended, or just before one
   * of its user messages. Never together with `conversationId`.
   */
  readonly fork?: CodingWorkbenchRuntimeForkRequest | undefined;
}

export interface CodingWorkbenchRuntimeActions {
  readonly setRequestedMode: (mode: CodingWorkbenchMode) => void;
  readonly setAgent: (agent: CodingWorkbenchAgent) => void;
  readonly setRuntimePreference: (preference: CodingWorkbenchRuntimePreference) => void;
  readonly setSelectedModel: (modelId: string | null) => void;
  readonly setReasoningEffort: (effort: ModelReasoningEffort | null) => void;
  readonly prepareCodexSetup?: (method: CodingWorkbenchCodexAuthMethod) => Promise<void>;
  readonly refreshProfile: () => Promise<void>;
  readonly refreshSource: () => Promise<void>;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshRun: () => Promise<void>;
  readonly start: (taskIntent: string, options: CodingWorkbenchStartOptions) => Promise<void>;
  readonly decideApproval: (decision: CodingWorkbenchRuntimeApprovalDecision) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly takeover: () => Promise<void>;
  readonly retry: (taskIntent: string) => Promise<void>;
  readonly acknowledgeRecovery: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: (requestedMode: CodingWorkbenchMode) => Promise<void>;
  readonly submitFollowUp: (
    taskIntent: string,
    inputs?: CodingWorkbenchFollowUpInputs,
  ) => Promise<void>;
  /** Undo the run's newest turn or restore an undo (B3, S04). */
  readonly revert: (action: CodingWorkbenchRuntimeRevertAction) => Promise<void>;
  /** Withdraw a message waiting for the running turn, or change a queued one to Send now (S07). */
  readonly inboxAction: (
    action: CodingWorkbenchRuntimeInboxAction,
    itemId: string,
  ) => Promise<void>;
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
    inboxAction,
    retry,
    revert,
    revokeResearchGrant,
    start,
    stop,
    submitFollowUp,
    takeover,
  } = mutations;
  return {
    setRequestedMode: (mode) => dispatch({ kind: "select-mode", mode }),
    setAgent: (agent) => dispatch({ kind: "select-agent", agent }),
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
    revert,
    inboxAction,
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
    inboxAction,
    retry,
    revert,
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
          revert,
          inboxAction,
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
      inboxAction,
      pause,
      prepareCodexSetup,
      profileSequence,
      refreshProfile,
      refreshRun,
      refreshRuntime,
      refreshSource,
      resume,
      retry,
      revert,
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
