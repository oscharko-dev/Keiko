import { useCallback, useRef, type Dispatch, type RefObject } from "react";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchRuntimeApprovalDecision,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./api";
import {
  codingWorkbenchFailureStatus,
  codingWorkbenchRuntimeApiError,
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeStatus,
} from "./coding-workbench-runtime-api";
import {
  createApprovalMutation,
  createFollowUpMutation,
  createLifecycleMutation,
  createRecoveryAcknowledgementMutation,
  createRetryMutation,
  createRunBoundMutation,
  createStartMutation,
  mutationResultMatchesCurrentTruth,
  type CodingWorkbenchMutationCommand,
} from "./coding-workbench-runtime-mutations";
import {
  codingWorkbenchSourceFromManaged,
  type CodingWorkbenchMutationKind,
  type CodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";

type RuntimeDispatch = Dispatch<CodingWorkbenchRuntimeStateAction>;

interface RefreshSequences {
  readonly profile: RefObject<number>;
  readonly source: RefObject<number>;
  readonly runtime: RefObject<number>;
  readonly run: RefObject<number>;
  readonly runRefresh: RefObject<Promise<void> | null>;
}

export interface RuntimeResources {
  readonly refreshProfile: () => Promise<void>;
  readonly refreshSource: () => Promise<void>;
  readonly prepareCodexSetup: (method: CodingWorkbenchCodexAuthMethod) => Promise<void>;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshRun: () => Promise<void>;
  readonly profileSequence: RefObject<number>;
  readonly sourceSequence: RefObject<number>;
}

export interface RuntimeMutationActions {
  readonly start: (taskIntent: string) => Promise<void>;
  readonly decideApproval: (decision: CodingWorkbenchRuntimeApprovalDecision) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly takeover: () => Promise<void>;
  readonly retry: (taskIntent: string) => Promise<void>;
  readonly acknowledgeRecovery: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly submitFollowUp: (taskIntent: string) => Promise<void>;
}

interface RuntimeMutationQueueInput {
  readonly stateRef: RefObject<CodingWorkbenchRuntimeState>;
  readonly refreshRun: () => Promise<void>;
  readonly dispatch: RuntimeDispatch;
}

function useRefreshSequences(): RefreshSequences {
  return {
    profile: useRef(0),
    source: useRef(0),
    runtime: useRef(0),
    run: useRef(0),
    runRefresh: useRef<Promise<void> | null>(null),
  };
}

function useProfileRefresh(
  sequenceRef: RefObject<number>,
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  dispatch: RuntimeDispatch,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const sequence = (sequenceRef.current += 1);
    if (stateRef.current.runtimePreference === "managed-gateway") {
      dispatch({ kind: "profile-empty" });
      return;
    }
    dispatch({ kind: "resource-loading", resource: "profile" });
    try {
      const profile = await fetchCodingWorkbenchCodexSubscriptionProfile();
      if (sequenceRef.current === sequence) dispatch({ kind: "profile-set", profile });
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      const mapped = codingWorkbenchRuntimeApiError(error);
      dispatch({
        kind: "resource-failed",
        resource: "profile",
        status: codingWorkbenchFailureStatus(mapped),
        error: mapped,
      });
    }
  }, [dispatch, sequenceRef, stateRef]);
}

function useSourceRefresh(
  sequenceRef: RefObject<number>,
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  dispatch: RuntimeDispatch,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const sequence = (sequenceRef.current += 1);
    const preference = stateRef.current.runtimePreference;
    dispatch({ kind: "resource-loading", resource: "source" });
    try {
      if (preference === "managed-gateway") {
        dispatch({ kind: "profile-empty" });
        const profile = await fetchCodingWorkbenchSidecarGatewayProfile();
        if (sequenceRef.current === sequence) {
          dispatch({ kind: "source-set", source: codingWorkbenchSourceFromManaged(profile) });
        }
        return;
      }
      dispatch({ kind: "resource-loading", resource: "profile" });
      const profile = await fetchCodingWorkbenchCodexSubscriptionProfile();
      if (sequenceRef.current !== sequence) return;
      setCodexSubscriptionSource(profile, dispatch);
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      const mapped = codingWorkbenchRuntimeApiError(error);
      dispatch({
        kind: "resource-failed",
        resource: "source",
        status: codingWorkbenchFailureStatus(mapped),
        error: mapped,
      });
      if (preference === "codex-subscription") {
        dispatch({
          kind: "resource-failed",
          resource: "profile",
          status: codingWorkbenchFailureStatus(mapped),
          error: mapped,
        });
      }
    }
  }, [dispatch, sequenceRef, stateRef]);
}

function setCodexSubscriptionSource(
  profile: Awaited<ReturnType<typeof fetchCodingWorkbenchCodexSubscriptionProfile>>,
  dispatch: RuntimeDispatch,
): void {
  dispatch({ kind: "profile-set", profile });
  dispatch({
    kind: "source-set",
    source: {
      runtimePreference: "codex-subscription",
      modelSource: profile.modelSource,
      runtimeSource: profile.runtimeSource,
      available: profile.status === "connected",
      ...(profile.status === "connected" ? {} : { unavailableReason: profile.status }),
    },
  });
}

function useCodexSetup(
  dispatch: RuntimeDispatch,
  refreshProfile: () => Promise<void>,
): (method: CodingWorkbenchCodexAuthMethod) => Promise<void> {
  return useCallback(
    async (method: CodingWorkbenchCodexAuthMethod): Promise<void> => {
      dispatch({ kind: "resource-loading", resource: "codexSetup" });
      try {
        const plan = await prepareCodingWorkbenchCodexSubscriptionSetup(method);
        dispatch({ kind: "codex-setup-set", plan });
        await refreshProfile();
      } catch (error) {
        const mapped = codingWorkbenchRuntimeApiError(error);
        dispatch({
          kind: "resource-failed",
          resource: "codexSetup",
          status: codingWorkbenchFailureStatus(mapped),
          error: mapped,
        });
      }
    },
    [dispatch, refreshProfile],
  );
}

function useRuntimeRefresh(
  sequenceRef: RefObject<number>,
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  dispatch: RuntimeDispatch,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const sequence = (sequenceRef.current += 1);
    const mode = stateRef.current.requestedMode;
    dispatch({ kind: "resource-loading", resource: "runtime" });
    try {
      const readiness = await getCodingWorkbenchRuntimeReadiness(mode);
      if (sequenceRef.current === sequence) dispatch({ kind: "runtime-set", readiness });
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      const mapped = codingWorkbenchRuntimeApiError(error);
      dispatch({
        kind: "resource-failed",
        resource: "runtime",
        status: codingWorkbenchFailureStatus(mapped),
        error: mapped,
      });
    }
  }, [dispatch, sequenceRef, stateRef]);
}

function useRunRefresh(
  runSequence: RefObject<number>,
  runRefresh: RefObject<Promise<void> | null>,
  dispatch: RuntimeDispatch,
): () => Promise<void> {
  return useCallback((): Promise<void> => {
    if (runRefresh.current !== null) return runRefresh.current;
    const sequence = (runSequence.current += 1);
    dispatch({ kind: "resource-loading", resource: "run" });
    const pending = (async (): Promise<void> => {
      try {
        const snapshot = await getCodingWorkbenchRuntimeStatus();
        if (runSequence.current === sequence) dispatch({ kind: "run-set", snapshot });
      } catch (error) {
        if (runSequence.current !== sequence) return;
        const mapped = codingWorkbenchRuntimeApiError(error);
        dispatch({
          kind: "resource-failed",
          resource: "run",
          status: codingWorkbenchFailureStatus(mapped),
          error: mapped,
        });
      }
    })();
    runRefresh.current = pending;
    void pending.then(() => {
      if (runRefresh.current === pending) runRefresh.current = null;
    });
    return pending;
  }, [dispatch, runRefresh, runSequence]);
}

export function useCodingWorkbenchRuntimeResources(
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  dispatch: RuntimeDispatch,
): RuntimeResources {
  const sequences = useRefreshSequences();
  const refreshProfile = useProfileRefresh(sequences.profile, stateRef, dispatch);
  const refreshSource = useSourceRefresh(sequences.source, stateRef, dispatch);
  const prepareCodexSetup = useCodexSetup(dispatch, refreshProfile);
  const refreshRuntime = useRuntimeRefresh(sequences.runtime, stateRef, dispatch);
  const refreshRun = useRunRefresh(sequences.run, sequences.runRefresh, dispatch);
  return {
    refreshProfile,
    refreshSource,
    prepareCodexSetup,
    refreshRuntime,
    refreshRun,
    profileSequence: sequences.profile,
    sourceSequence: sequences.source,
  };
}

function useRuntimeMutationQueue({
  stateRef,
  refreshRun,
  dispatch,
}: RuntimeMutationQueueInput): (
  kind: CodingWorkbenchMutationKind,
  prepare: (current: CodingWorkbenchRuntimeState) => CodingWorkbenchMutationCommand,
) => Promise<void> {
  const mutationTail = useRef<Promise<void>>(Promise.resolve());
  return useCallback(
    (
      kind: CodingWorkbenchMutationKind,
      prepare: (current: CodingWorkbenchRuntimeState) => CodingWorkbenchMutationCommand,
    ): Promise<void> => {
      const execute = async (): Promise<void> => {
        try {
          const command = prepare(stateRef.current);
          dispatch({ kind: "mutation-start", mutation: kind, requestId: command.requestId });
          const snapshot = await command.run();
          if (mutationResultMatchesCurrentTruth(command, stateRef.current.run.value, snapshot)) {
            dispatch({ kind: "run-set", snapshot });
          } else {
            await refreshRun();
          }
          dispatch({ kind: "mutation-complete" });
        } catch (error) {
          dispatch({ kind: "mutation-failed", error: codingWorkbenchRuntimeApiError(error) });
        }
      };
      const result = mutationTail.current.then(execute, execute);
      mutationTail.current = result;
      return result;
    },
    [dispatch, refreshRun, stateRef],
  );
}

export function useCodingWorkbenchRuntimeMutations(
  input: RuntimeMutationQueueInput,
): RuntimeMutationActions {
  const enqueueMutation = useRuntimeMutationQueue(input);
  const start = useCallback(
    (taskIntent: string): Promise<void> =>
      enqueueMutation("start", (current) => createStartMutation(taskIntent, current)),
    [enqueueMutation],
  );
  const decideApproval = useCallback(
    (decision: CodingWorkbenchRuntimeApprovalDecision): Promise<void> =>
      enqueueMutation("approval", (current) => createApprovalMutation(decision, current)),
    [enqueueMutation],
  );
  const runBoundMutation = useCallback(
    (kind: "stop" | "takeover"): Promise<void> =>
      enqueueMutation(kind, (current) => createRunBoundMutation(kind, current)),
    [enqueueMutation],
  );
  const retry = useCallback(
    (taskIntent: string): Promise<void> =>
      enqueueMutation("retry", (current) => createRetryMutation(taskIntent, current)),
    [enqueueMutation],
  );
  const stop = useCallback((): Promise<void> => runBoundMutation("stop"), [runBoundMutation]);
  const takeover = useCallback(
    (): Promise<void> => runBoundMutation("takeover"),
    [runBoundMutation],
  );
  const acknowledgeRecovery = useCallback(
    (): Promise<void> =>
      enqueueMutation("recovery-ack", (current) => createRecoveryAcknowledgementMutation(current)),
    [enqueueMutation],
  );
  const pause = useCallback(
    (): Promise<void> =>
      enqueueMutation("pause", (current) => createLifecycleMutation("pause", current)),
    [enqueueMutation],
  );
  const resume = useCallback(
    (): Promise<void> =>
      enqueueMutation("resume", (current) => createLifecycleMutation("resume", current)),
    [enqueueMutation],
  );
  const submitFollowUp = useCallback(
    (taskIntent: string): Promise<void> =>
      enqueueMutation("follow-up", (current) => createFollowUpMutation(taskIntent, current)),
    [enqueueMutation],
  );
  return {
    start,
    decideApproval,
    stop,
    takeover,
    retry,
    acknowledgeRecovery,
    pause,
    resume,
    submitFollowUp,
  };
}
