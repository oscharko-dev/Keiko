import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  GATEWAY_MODEL_READINESS_UPDATED_EVENT,
} from "@/app/components/desktop/widgets/shared/gatewaySetupBus";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceApi } from "@/app/components/desktop/context/ActiveWorkspaceContext";
import { logRuntimeActivityEvents } from "@/app/components/desktop/widgets/shared/activityBus";
import { codingWorkbenchRuntimeApiError } from "./coding-workbench-runtime-api";
import { useCodingWorkbenchRuntimeEventStream } from "./coding-workbench-event-retention";
import { fetchWorkspaceManifestAccess } from "./workspace-manifest-api";
import type {
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";

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
  // Settings replaces the gateway configuration (a saved setup, an applied verified capability)
  // and records readiness verdicts without this window knowing: the source stayed "unavailable"
  // after the operator had just verified tool calling, until a reload (workbench end-to-end run,
  // 2026-09-03). Both announcements re-read the source and the runtime posture.
  useEffect(() => {
    const refresh = (): void => {
      void refreshSource();
      void refreshRuntime();
    };
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refresh);
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, refresh);
    return (): void => {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refresh);
      window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, refresh);
    };
  }, [refreshRuntime, refreshSource]);
  useEffect(() => {
    void refreshRun();
  }, [refreshRun]);
}

/**
 * Release-audit F-08/RG-12: resolve the window's pairing dimension once per mount from the honest
 * workspaces read (which itself orders behind the boot pairing redemption, #2478). The state stays
 * fail-closed on `unknown` when the read cannot answer — readiness must never claim a paired
 * session it has not confirmed, because an unpaired start is guaranteed to 403 (ADR-0141).
 */
export function useCodingWorkbenchPairingEffect(dispatch: RuntimeDispatch): void {
  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceManifestAccess().then(
      (access) => {
        if (!cancelled) dispatch({ kind: "pairing-set", pairing: access.session });
      },
      (error: unknown) => {
        // Fail closed, but never silently: a BFF or validation outage must stay distinguishable
        // from an initial boot in the local console (#2843 review). Same bounded idiom as
        // verified-task-workspace-binding: the caller-visible state stays the sanitized
        // `unknown`, while the underlying failure remains diagnosable.
        reportClientDiagnostic(
          `[keiko] coding workbench pairing discovery failed: ${clientErrorSummary(error)}`,
          { correlationId: correlationIdOf(error) },
        );
        if (!cancelled) dispatch({ kind: "pairing-set", pairing: "unknown" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch]);
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
      logRuntimeActivityEvents(events);
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
