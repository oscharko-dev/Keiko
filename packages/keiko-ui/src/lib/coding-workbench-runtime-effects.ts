import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  GATEWAY_MODEL_READINESS_UPDATED_EVENT,
  GATEWAY_MODEL_CATALOG_UPDATED_EVENT,
  requestGatewayModelCatalogRefresh,
  gatewayModelCatalogCorrelationId,
} from "@/app/components/desktop/widgets/shared/gatewaySetupBus";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceApi } from "@/app/components/desktop/context/ActiveWorkspaceContext";
import { logRuntimeActivityEvents } from "@/app/components/desktop/widgets/shared/activityBus";
import { codingWorkbenchRuntimeApiError } from "./coding-workbench-runtime-api";
import type { CodingWorkbenchModelCheck } from "./coding-workbench-provider-api";
import { useCodingWorkbenchRuntimeEventStream } from "./coding-workbench-event-retention";
import {
  useCodingAppSessionEstablishments,
  useCodingAppSessionRedemptions,
  settleCodingAppSessionUnpairedReport,
  useCodingAppSessionUnpairedObservations,
} from "./coding-app-session-client";
import { fetchWorkspaceManifestAccess } from "./workspace-manifest-api";
import type {
  CodingWorkbenchResourceStatus,
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";
import { reportCodingWorkbenchInteraction } from "./coding-workbench-interaction";
import { newClientCorrelationId } from "./bff-correlation";
import { activeRunState } from "@/app/components/desktop/widgets/coding-workbench/codingWorkbenchLabels";
import type { ClientCodingWorkbenchReadinessRetryOutcome } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

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

function usePickedModelRefreshEffect({
  state,
  refreshSource,
  intent,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly intent: RefObject<{ pickedModelId: string | null }>;
  readonly refreshSource: (
    catalogAlreadyCurrent?: boolean,
    parentCorrelationId?: string,
    checkModel?: CodingWorkbenchModelCheck,
  ) => Promise<void>;
}): void {
  // A model chosen in the picker is the model the source describes: choosing one reads its profile
  // and asks the server to check exactly that model when it holds no fresh answer for it. No other
  // re-read asks for a check, so an open Workbench probes nothing in the background (customer 1.3.4).
  // Only the person's own pick asks for the explicit check (`check=1`, set by the pick action);
  // every other read this effect makes (the first read of a mounted window, a changed runtime
  // preference, a model adopted from a run, a StrictMode double run) is `check=use`, which asks
  // only for the model the server itself has in use (#4351). Pressing Start on a model that was
  // never checked is the first use that checks it.
  useEffect(() => {
    const picked = intent.current.pickedModelId;
    intent.current.pickedModelId = null;
    void refreshSource(
      false,
      undefined,
      picked !== null && picked === state.selectedModelId ? true : "use",
    );
  }, [state.runtimePreference, state.selectedModelId, refreshSource, intent]);
}

/**
 * U-45: a Start the server refused because the model is not admitted is the one moment the window
 * may still not know that the model is inactive (a catalog or source read that never landed). The
 * refusal therefore re-reads the source once, which also asks for the unfiltered model catalog, so
 * the "Activate {model}" notice appears right after it. A model that is only still being checked
 * is not an inactive one and re-reads nothing. One read per refusal, never a loop.
 */
function useModelRefusalReread(
  mutation: CodingWorkbenchRuntimeState["mutation"],
  refreshSource: (
    catalogAlreadyCurrent?: boolean,
    parentCorrelationId?: string,
    checkModel?: CodingWorkbenchModelCheck,
  ) => Promise<void>,
): void {
  const refused =
    mutation.status === "error" &&
    mutation.error?.code === "CODING_RUNTIME_MODEL_UNAVAILABLE" &&
    mutation.error.modelRefusalReason !== "model-verification-pending"
      ? mutation.requestId
      : null;
  useEffect(() => {
    if (refused !== null) void refreshSource(false, undefined, "use");
  }, [refused, refreshSource]);
}

/**
 * U-45: a page that stays open across a Keiko restart and is paired again in place (a fragment
 * navigation, no reload) still holds a source that said "admitted" for a server whose models are all
 * inactive again (ADR-0171 D2), which hid the activation notice. A NEW app session therefore re-reads
 * the source and the runtime posture and asks for the model catalog once. It is not a mount read:
 * the first value of the count is the mount's own, and only a later change acts.
 */
function useNewSessionReread(
  refreshRuntime: () => Promise<void>,
  refreshSource: (
    catalogAlreadyCurrent?: boolean,
    parentCorrelationId?: string,
    checkModel?: CodingWorkbenchModelCheck,
  ) => Promise<void>,
): void {
  const established = useCodingAppSessionEstablishments();
  const seen = useRef(established);
  useEffect(() => {
    if (seen.current === established) return;
    seen.current = established;
    void refreshRuntime();
    void refreshSource(false, undefined, "use");
    requestGatewayModelCatalogRefresh({ check: true });
  }, [established, refreshRuntime, refreshSource]);
}

function useModelRereads(
  mutation: CodingWorkbenchRuntimeState["mutation"],
  refreshRuntime: () => Promise<void>,
  refreshSource: (
    catalogAlreadyCurrent?: boolean,
    parentCorrelationId?: string,
    checkModel?: CodingWorkbenchModelCheck,
  ) => Promise<void>,
): void {
  useModelRefusalReread(mutation, refreshSource);
  useNewSessionReread(refreshRuntime, refreshSource);
}

export function useCodingWorkbenchRuntimeRefreshEffects({
  state,
  refreshRuntime,
  refreshSource,
  refreshRun,
  intent,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly intent: RefObject<{ pickedModelId: string | null }>;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshSource: (
    catalogAlreadyCurrent?: boolean,
    parentCorrelationId?: string,
    checkModel?: CodingWorkbenchModelCheck,
  ) => Promise<void>;
  readonly refreshRun: (quiet?: boolean) => Promise<void>;
}): void {
  useEffect(() => {
    void refreshRuntime();
  }, [state.requestedMode, refreshRuntime]);
  usePickedModelRefreshEffect({ state, refreshSource, intent });
  useModelRereads(state.mutation, refreshRuntime, refreshSource);
  // Settings replaces the gateway configuration (a saved setup, an applied verified capability)
  // and records readiness verdicts without this window knowing: the source stayed "unavailable"
  // after the operator had just verified tool calling, until a reload (workbench end-to-end run,
  // 2026-09-03). Both announcements re-read the source and the runtime posture.
  useEffect(() => {
    const refresh = (): void => {
      void refreshSource();
      void refreshRuntime();
    };
    const adoptCatalog = (event: Event): void => {
      const parent = gatewayModelCatalogCorrelationId(event);
      if (parent === undefined) void refreshSource(true);
      else void refreshSource(true, parent);
      void refreshRuntime();
    };
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refresh);
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, refresh);
    window.addEventListener(GATEWAY_MODEL_CATALOG_UPDATED_EVENT, adoptCatalog);
    return (): void => {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refresh);
      window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, refresh);
      window.removeEventListener(GATEWAY_MODEL_CATALOG_UPDATED_EVENT, adoptCatalog);
    };
  }, [refreshRuntime, refreshSource]);
  useEffect(() => {
    void refreshRun();
  }, [refreshRun]);
  useRunRereadOnReturn(refreshRun);
  usePostRunDescriptionRefresh(state.run.value, refreshRun);
  useRuntimeReadinessRetry(state.runtime.status, refreshRuntime);
  useAnchoredReadinessReread(state, refreshRuntime);
}

/** Waits before each re-read of a failed runtime readiness; after the last one the failure stays. */
export const RUNTIME_READINESS_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

/**
 * A failed readiness read heals itself (U-37). Nothing else re-reads readiness on its own, so one
 * transient failure (a refused or reset request while the page was still reloading) left "Runtime
 * could not be refreshed" on screen, and the composer without its agent switch, although every
 * later read of the same server succeeded. A bounded, backed-off retry runs only while the
 * resource is in error and ends at the first success; it is not a polling loop. Each attempt, the
 * recovery and the exhaustion are reported as body-free closed evidence under one correlation id.
 */
function useRuntimeReadinessRetry(
  status: CodingWorkbenchResourceStatus,
  refreshRuntime: () => Promise<void>,
): void {
  const episode = useRef<ReadinessRetryEpisode>({
    attempts: 0,
    exhausted: false,
    retryInFlight: false,
    correlationId: undefined,
  });
  useEffect(() => {
    const current = episode.current;
    if (status === "loading" && !current.retryInFlight) {
      // A refresh the retry did not start (a mode change, a manual read) opens a new episode: the
      // earlier attempts were spent on an earlier failure.
      resetReadinessRetryEpisode(current);
    }
    if (status === "ready" && current.attempts > 0) {
      reportReadinessRetry("recovered", current.attempts, current.correlationId);
    }
    if (status === "ready") resetReadinessRetryEpisode(current);
    if (status === "ready" || status === "error") current.retryInFlight = false;
    if (status !== "error") return;
    const delay = RUNTIME_READINESS_RETRY_DELAYS_MS[current.attempts];
    if (delay === undefined) {
      if (!current.exhausted) {
        current.exhausted = true;
        reportReadinessRetry("exhausted", current.attempts, current.correlationId);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      current.attempts += 1;
      current.retryInFlight = true;
      current.correlationId ??= newClientCorrelationId();
      reportReadinessRetry("started", current.attempts, current.correlationId);
      void refreshRuntime();
    }, delay);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [status, refreshRuntime]);
}

interface ReadinessRetryEpisode {
  attempts: number;
  /** `exhausted` is reported once per episode, not on every effect re-run. */
  exhausted: boolean;
  /** The refresh now loading was started by the retry itself. */
  retryInFlight: boolean;
  correlationId: string | undefined;
}

function resetReadinessRetryEpisode(episode: ReadinessRetryEpisode): void {
  episode.attempts = 0;
  episode.exhausted = false;
  episode.correlationId = undefined;
}

function reportReadinessRetry(
  readinessRetryOutcome: ClientCodingWorkbenchReadinessRetryOutcome,
  attempt: number,
  correlationId: string | undefined,
): void {
  reportCodingWorkbenchInteraction(
    { interaction: "runtime-readiness-retry", readinessRetryOutcome, attempt },
    correlationId,
  );
}

/**
 * A readiness answer anchored to a live run states that run's posture. When the run has ended the
 * answer is stale (the next run holds what is selected now), so it is read again once; the new
 * answer is not anchored, which ends the effect.
 */
function useAnchoredReadinessReread(
  state: CodingWorkbenchRuntimeState,
  refreshRuntime: () => Promise<void>,
): void {
  const anchored = state.runtime.value?.liveRunAnchored === true;
  const runSettled = state.run.status === "ready" && !activeRunState(state.run.value?.state);
  useEffect(() => {
    if (anchored && runSettled) void refreshRuntime();
  }, [anchored, runSettled, refreshRuntime]);
}

/**
 * U-14: another paired window of the same installation can start a run while this one sits idle,
 * and nothing pushes that to a window that follows no run. The run is therefore read again each
 * time the person returns to this window (the window gains focus, or its tab becomes visible), so
 * the active run is on screen, and Start is not offered, before the person types a task for it.
 * Not a polling loop: one coalesced status read per return.
 */
function useRunRereadOnReturn(refreshRun: (quiet?: boolean) => Promise<void>): void {
  useEffect(() => {
    const reread = (): void => {
      if (document.visibilityState === "visible") void refreshRun(true);
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return (): void => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [refreshRun]);
}

/** How often, and for how long at most, the settled run's snapshot is re-read while its
 * automatically generated description is still on its way. */
export const POST_RUN_DESCRIPTION_POLL_MS = 3_000;
export const POST_RUN_DESCRIPTION_POLL_MAX_MS = 5 * 60_000;

/**
 * #3390: whether the run has settled with a draft pull request whose automatically generated
 * description has not arrived yet.
 *
 * The description job is dispatched AT the terminal transition and generates a few seconds later --
 * after the run's event stream, which is kept only for live states, has delivered its last
 * re-snapshot. Nothing re-read the run after that, so the card an operator was watching kept
 * showing the pre-generation state for good, while a freshly opened window showed "Review exact
 * draft" at once (rehearsal run-04). The snapshot carries no "generation pending" phase of its own;
 * this condition is exactly the window in which one is pending.
 */
export function awaitingPostRunDescription(
  snapshot: CodingWorkbenchRuntimeSnapshot | null | undefined,
): boolean {
  return (
    snapshot?.state === "succeeded" &&
    snapshot.draftDelivery?.phase === "draft-created" &&
    snapshot.descriptionStatus === undefined
  );
}

// A bounded, purpose-specific re-read -- not a general polling loop: it runs only while the
// condition above holds, and gives up after `POST_RUN_DESCRIPTION_POLL_MAX_MS` so a job that never
// settles cannot keep a window polling forever.
function usePostRunDescriptionRefresh(
  snapshot: CodingWorkbenchRuntimeSnapshot | null | undefined,
  refreshRun: () => Promise<void>,
): void {
  const awaiting = awaitingPostRunDescription(snapshot);
  useEffect(() => {
    if (!awaiting) return;
    const timer = window.setInterval(() => {
      void refreshRun();
    }, POST_RUN_DESCRIPTION_POLL_MS);
    const stop = window.setTimeout(() => {
      window.clearInterval(timer);
    }, POST_RUN_DESCRIPTION_POLL_MAX_MS);
    return (): void => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [awaiting, refreshRun]);
}

/**
 * Release-audit F-08/RG-12: resolve the window's pairing dimension on mount, and again after every
 * re-pair without a page load (F65), from the honest workspaces read (which itself orders behind
 * the boot pairing redemption, #2478). The state stays
 * fail-closed on `unknown` when the read cannot answer — readiness must never claim a paired
 * session it has not confirmed, because an unpaired start is guaranteed to 403 (ADR-0141).
 */
export function useCodingWorkbenchPairingEffect(dispatch: RuntimeDispatch): void {
  const redemptions = useCodingAppSessionRedemptions();
  // U-22: a channel read that came back unpaired (a restarted Keiko) re-confirms the pairing here.
  const unpairedReads = useCodingAppSessionUnpairedObservations();
  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceManifestAccess().then(
      (access) => {
        if (access.session === "paired") settleCodingAppSessionUnpairedReport();
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
  }, [dispatch, redemptions, unpairedReads]);
}

/**
 * A refused start stays on screen until the next action, but only within the session it was refused
 * under: after a new pairing (typically a restarted Keiko) its support id names a request of the
 * previous session, so the window drops it rather than presenting it as current.
 */
export function useCodingWorkbenchSessionRenewalEffect(dispatch: RuntimeDispatch): void {
  const established = useCodingAppSessionEstablishments();
  const seen = useRef(established);
  useEffect(() => {
    if (seen.current === established) return;
    seen.current = established;
    dispatch({ kind: "session-renewed" });
  }, [dispatch, established]);
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
    onReconnecting: () => {
      dispatch({ kind: "stream-reconnecting" });
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
