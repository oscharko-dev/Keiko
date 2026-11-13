import { useMemo, type Dispatch, type RefObject } from "react";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchPromptReference,
  CodingWorkbenchRuntimePreference,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchCommandRequest,
  CodingWorkbenchPromptMentions,
  CodingWorkbenchRuntimeForkRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import type { RuntimeMutationActions, RuntimeResources } from "./coding-workbench-runtime-hooks";

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
  /** The subagents and skills the first prompt mentions (#3906); the server confirms each. */
  readonly mentions?: CodingWorkbenchPromptMentions | undefined;
  /**
   * Starts a NEW task forked from another task (S03): from the task as it ended, or just before one
   * of its user messages. Never together with `conversationId`.
   */
  readonly fork?: CodingWorkbenchRuntimeForkRequest | undefined;
  /** The Jira Pod the person picked for this run; the server checks it is theirs and ready. */
  readonly jiraPodId?: string | undefined;
  /** Explicit additional connector authority selected by the human for the ready Jira Pod. */
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  /** The MCP servers the person selected for this run; absent offers every enabled server. */
  readonly mcpServers?: readonly string[] | undefined;
}

/** The public action surface: the run's mutations plus the profile, source and preference controls. */
export interface CodingWorkbenchRuntimeActions extends RuntimeMutationActions {
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
    cancelStart,
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
    cancelStart,
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
    cancelStart,
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
          cancelStart,
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
      cancelStart,
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
