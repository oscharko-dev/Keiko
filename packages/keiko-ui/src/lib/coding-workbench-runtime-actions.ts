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
  CodingWorkbenchClientError,
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
  /** The person's own pick: the one model whose check the server is asked to run (`check=1`). */
  readonly setSelectedModel: (modelId: string | null) => void;
  /**
   * The window's own choice of a model (the operator's saved one, or the elected default): it is
   * read with `check=use` like any other passive read and never aborts a Start that is waiting.
   */
  readonly adoptModel: (modelId: string | null) => void;
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
  readonly intent: RefObject<CodingWorkbenchModelIntent>;
}

// #4351: pressing Start on a model that was never checked is the first use that checks it. The
// window asks the server for the one check (an explicit read, like a pick), shows the source's own
// "being checked" state while it runs, and starts when the model is ready; a refusal leaves the
// source's readable reason on screen and starts nothing.
const START_MODEL_CHECK_POLL_MS = 5_000;
const START_MODEL_CHECK_MAX_WAIT_MS = 600_000;

// The answer to a Start pressed while the first one still waits for its model's check: the same
// closed refusal the server gives for a model whose verification is pending.
const MODEL_STILL_CHECKING: CodingWorkbenchClientError = {
  code: "CODING_RUNTIME_MODEL_UNAVAILABLE",
  message: "The selected model is still being checked.",
  retryable: true,
  modelRefusalReason: "model-verification-pending",
};

function sourceNeedsModelCheck(state: CodingWorkbenchRuntimeState): boolean {
  const value = state.source.value;
  return (
    state.runtimePreference === "managed-gateway" &&
    value?.available === true &&
    value.verification !== "verified"
  );
}

function sourceCheckPending(state: CodingWorkbenchRuntimeState): boolean {
  return state.source.value?.unavailableReason === "model-verification-pending";
}

// A read lands its source in the ref after React commits it, and a catalog update the read
// announces may start one more read: wait (bounded) until the source is a newer one than `before`
// and no longer loading.
async function settledSource(
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  before: CodingWorkbenchRuntimeState["source"],
): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    await /* NOSONAR typescript:S9382 -- bounded wait for the committed state (#4351). */ new Promise<void>(
      (resolve) => setTimeout(resolve, 10),
    );
    const current = stateRef.current.source;
    if (current !== before && current.status !== "loading") return;
  }
}

// Owned by the window: the model check a Start waits on, which ends when the window closes or the
// model changes, and which a second Start never joins or repeats.
export interface CodingWorkbenchModelIntent {
  /** The model a person just picked; the next source read for it is the one explicit check. */
  pickedModelId: string | null;
  /** The wait of a Start that is checking its model, if one is running. */
  startWait: AbortController | null;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function waitForModelCheck(
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  refreshSource: RuntimeResources["refreshSource"],
  signal: AbortSignal,
): Promise<boolean> {
  const before = stateRef.current.source;
  await refreshSource(false, undefined, true);
  await settledSource(stateRef, before);
  const deadline = Date.now() + START_MODEL_CHECK_MAX_WAIT_MS;
  while (!signal.aborted && sourceCheckPending(stateRef.current) && Date.now() < deadline) {
    await /* NOSONAR typescript:S9382 -- one bounded poll at a time, by design (#4351). */ abortableDelay(
      START_MODEL_CHECK_POLL_MS,
      signal,
    );
    if (signal.aborted) break;
    const pendingBefore = stateRef.current.source;
    await /* NOSONAR typescript:S9382 -- one bounded poll at a time, by design (#4351). */ refreshSource();
    await /* NOSONAR typescript:S9382 -- one bounded poll at a time, by design (#4351). */ settledSource(
      stateRef,
      pendingBefore,
    );
  }
  return !signal.aborted && stateRef.current.source.value?.available === true;
}

async function startAfterModelCheck(
  input: {
    readonly stateRef: RefObject<CodingWorkbenchRuntimeState>;
    readonly refreshSource: RuntimeResources["refreshSource"];
    readonly start: RuntimeMutationActions["start"];
    readonly intent: CodingWorkbenchModelIntent;
    readonly dispatch: Dispatch<CodingWorkbenchRuntimeStateAction>;
  },
  taskIntent: string,
  options: CodingWorkbenchStartOptions,
): Promise<void> {
  const { stateRef, refreshSource, start, intent } = input;
  // A second Start while the first one is checking its model does not repeat the check; it says
  // that the model is still being checked.
  if (intent.startWait !== null) {
    input.dispatch({ kind: "mutation-failed", error: MODEL_STILL_CHECKING });
    return;
  }
  if (!sourceNeedsModelCheck(stateRef.current)) {
    await start(taskIntent, options);
    return;
  }
  const controller = new AbortController();
  intent.startWait = controller;
  let ready = false;
  try {
    ready = await waitForModelCheck(stateRef, refreshSource, controller.signal);
  } finally {
    if (intent.startWait === controller) intent.startWait = null;
    // The "still being checked" answer to a second Start belongs to this wait only.
    if (stateRef.current.mutation.error?.modelRefusalReason === "model-verification-pending")
      input.dispatch({ kind: "mutation-complete" });
  }
  // The window closed or the model changed during the wait: nothing starts.
  if (ready && !controller.signal.aborted) await start(taskIntent, options);
}

function createCodingWorkbenchRuntimeActions({
  stateRef,
  dispatch,
  resources,
  mutations,
  intent,
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
    setRuntimePreference: (preference): void => {
      if (stateRef.current.runtimePreference === preference) return;
      // Another runtime preference is another source: the wait of a Start for the old one ends.
      intent.current.startWait?.abort();
      profileSequence.current += 1;
      sourceSequence.current += 1;
      dispatch({ kind: "select-runtime-preference", preference });
    },
    setSelectedModel: (modelId): void => {
      // The same model picked again changes nothing, so a Start that waits on it keeps waiting and
      // the explicit check is asked for only when no Start already runs it.
      if (modelId !== null && stateRef.current.selectedModelId === modelId) {
        if (intent.current.startWait === null) void refreshSource(false, undefined, true);
        return;
      }
      // Another model ends the wait of a Start that was checking the old one.
      intent.current.startWait?.abort();
      // The next source read for this model is the person's pick; every other read is passive.
      intent.current.pickedModelId = modelId;
      dispatch({ kind: "select-model", modelId });
    },
    adoptModel: (modelId): void => {
      if (stateRef.current.selectedModelId === modelId) return;
      dispatch({ kind: "select-model", modelId });
    },
    setReasoningEffort: (effort) => dispatch({ kind: "select-reasoning-effort", effort }),
    prepareCodexSetup,
    refreshProfile,
    refreshSource,
    refreshRuntime,
    refreshRun,
    start: (taskIntent, options) =>
      startAfterModelCheck(
        { stateRef, refreshSource, start, intent: intent.current, dispatch },
        taskIntent,
        options,
      ),
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
  const { stateRef, dispatch, resources, mutations, intent } = input;
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
        intent,
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
      intent,
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
