import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceApi } from "@/app/components/desktop/context/ActiveWorkspaceContext";
import { codingWorkbenchRuntimeApiError } from "./coding-workbench-runtime-api";
import { useCodingWorkbenchRuntimeEventStream } from "./coding-workbench-event-retention";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";

type RuntimeDispatch = Dispatch<CodingWorkbenchRuntimeStateAction>;

interface WorkspaceEffectInput {
  readonly activeBinding: ActiveWorkspaceApi["activeBinding"];
  readonly activeInstance: ActiveWorkspaceApi["activeInstance"];
  readonly error: string | null;
  readonly loading: boolean;
  readonly switching: boolean;
  readonly dispatch: RuntimeDispatch;
}

interface RuntimeEventStreamInput {
  readonly runId: string | undefined;
  readonly streamEpoch: number;
  readonly stateRef: RefObject<CodingWorkbenchRuntimeState>;
  readonly refreshRun: () => Promise<void>;
  readonly dispatch: RuntimeDispatch;
  readonly setStreamEpoch: Dispatch<SetStateAction<number>>;
}

export function useCodingWorkbenchRuntimeRefreshEffects({
  state,
  refreshRuntime,
  refreshSource,
  refreshRun,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshSource: () => Promise<void>;
  readonly refreshRun: () => Promise<void>;
}): void {
  useEffect(() => {
    void refreshRuntime();
  }, [state.requestedMode, refreshRuntime]);
  useEffect(() => {
    void refreshSource();
  }, [state.runtimePreference, refreshSource]);
  useEffect(() => {
    void refreshRun();
  }, [refreshRun]);
}

export function useCodingWorkbenchWorkspaceEffect({
  activeBinding,
  activeInstance,
  error,
  loading,
  switching,
  dispatch,
}: WorkspaceEffectInput): void {
  useEffect(() => {
    if (loading || switching) dispatch({ kind: "resource-loading", resource: "workspace" });
    else if (error) {
      dispatch({
        kind: "resource-failed",
        resource: "workspace",
        status: "error",
        error: { code: "TASK_WORKSPACE_UNAVAILABLE", message: error, retryable: true },
      });
    } else if (activeBinding && activeInstance) {
      dispatch({
        kind: "workspace-set",
        workspace: {
          workspaceId: activeBinding.workspaceId,
          taskId: activeBinding.taskId,
          taskBranch: activeInstance.taskBranch,
          health: activeInstance.health,
          switching: false,
        },
      });
    } else {
      dispatch({ kind: "workspace-set", workspace: null });
    }
  }, [activeBinding, activeInstance, dispatch, error, loading, switching]);
}

export function useCodingWorkbenchRuntimeStream({
  runId,
  streamEpoch,
  stateRef,
  refreshRun,
  dispatch,
  setStreamEpoch,
}: RuntimeEventStreamInput): void {
  useCodingWorkbenchRuntimeEventStream(runId, streamEpoch, {
    onOpen: () => {
      if (!runId) return;
      dispatch({
        kind: "stream-set",
        stream: {
          runId,
          cursor: stateRef.current.stream.value?.cursor ?? null,
          connected: true,
        },
      });
    },
    onEvents: (events, cursor, resnapshot) => {
      if (!runId) return;
      dispatch({ kind: "events-received", events });
      dispatch({ kind: "stream-set", stream: { runId, cursor, connected: true } });
      if (resnapshot) void refreshRun();
    },
    onError: (error) => {
      const mapped = codingWorkbenchRuntimeApiError(error);
      dispatch({ kind: "resource-failed", resource: "stream", status: "error", error: mapped });
    },
    onReset: async () => {
      dispatch({ kind: "events-reset" });
      await refreshRun();
      setStreamEpoch((value) => value + 1);
    },
  });
}

export function codingWorkbenchStreamRunId(
  state: CodingWorkbenchRuntimeState,
  streamableStates: ReadonlySet<CodingWorkbenchRuntimeStateName>,
): string | undefined {
  return streamableStates.has(state.run.value?.state ?? "idle")
    ? state.run.value?.runId
    : undefined;
}
