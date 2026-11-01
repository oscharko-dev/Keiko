import type { CodingWorkbenchStartOptions } from "./coding-workbench-runtime-actions";
import { ApiError } from "./api";
import { newClientCorrelationId } from "./bff-correlation";
import { reportGatewayProfileRefresh, reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";
import { requestCodingAppSessionReinspection } from "./coding-app-session-client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from "react";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchRuntimeInboxAction,
  CodingWorkbenchRuntimeRevertAction,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./coding-workbench-provider-api";
import {
  CodingWorkbenchPreemptedError,
  RUNTIME_REQUEST_TIMEOUT_CODE,
  codingWorkbenchFailureStatus,
  codingWorkbenchRuntimeApiError,
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeStatus,
  isCodingWorkbenchPreempted,
} from "./coding-workbench-runtime-api";
import {
  createApprovalMutation,
  createFollowUpMutation,
  createLifecycleMutation,
  createRecoveryAcknowledgementMutation,
  createResearchRevokeMutation,
  createRetryMutation,
  createInboxMutation,
  createRevertMutation,
  createRunBoundMutation,
  createStartMutation,
  mutationResultMatchesCurrentTruth,
  runBoundTarget,
  type CodingWorkbenchFollowUpInputs,
  type CodingWorkbenchMutationCommand,
} from "./coding-workbench-runtime-mutations";
import { requestGatewayModelCatalogRefresh } from "@/app/components/desktop/widgets/shared/gatewaySetupBus";
import {
  codingWorkbenchSourceFromManaged,
  type CodingWorkbenchMutationKind,
  type CodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeStateAction,
} from "./coding-workbench-live-state";

type RuntimeDispatch = Dispatch<CodingWorkbenchRuntimeStateAction>;
type SourceRefresh = (
  catalogAlreadyCurrent?: boolean,
  parentCorrelationId?: string,
  checkModel?: boolean,
) => Promise<void>;

interface RefreshSequences {
  readonly profile: RefObject<number>;
  readonly source: RefObject<number>;
  readonly runtime: RefObject<number>;
  readonly run: RefObject<number>;
  readonly runRefresh: RefObject<Promise<void> | null>;
}

export interface RuntimeResources {
  readonly refreshProfile: () => Promise<void>;
  readonly refreshSource: SourceRefresh;
  readonly prepareCodexSetup: (method: CodingWorkbenchCodexAuthMethod) => Promise<void>;
  readonly refreshRuntime: () => Promise<void>;
  readonly refreshRun: () => Promise<void>;
  readonly profileSequence: RefObject<number>;
  readonly sourceSequence: RefObject<number>;
}

export interface RuntimeMutationActions {
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
  readonly revert: (action: CodingWorkbenchRuntimeRevertAction) => Promise<void>;
  readonly inboxAction: (
    action: CodingWorkbenchRuntimeInboxAction,
    itemId: string,
  ) => Promise<void>;
  readonly revokeResearchGrant: (grant: CodingWorkbenchRuntimeResearchGrant) => Promise<void>;
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

// #3591 (1.1.7): while the server is still verifying the elected model against a slow gateway it
// answers `model-verification-pending`; the Workbench reads the profile again after this pause
// instead of leaving the operator with a refusal that a later read would have lifted.
export const CODING_WORKBENCH_VERIFYING_REFRESH_MS = 10_000;

function sourceVerificationPending(
  profile: Awaited<ReturnType<typeof fetchCodingWorkbenchSidecarGatewayProfile>>,
): boolean {
  return profile.status === "unavailable" && profile.reason === "model-verification-pending";
}

function settleGatewayProfileRefresh(
  correlationId: string,
  parentCorrelationId: string | undefined,
  startedAt: number,
  outcome: "adopted" | "unavailable" | "failed" | "superseded",
  catalogReread: "requested" | "skipped" | "none",
): void {
  reportGatewayProfileRefresh(correlationId, parentCorrelationId, {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    evidence: { outcome, catalogReread },
  });
}

async function refreshManagedGatewaySource(
  sequenceRef: RefObject<number>,
  sequence: number,
  dispatch: RuntimeDispatch,
  scheduleReread: (sequence: number) => void,
  catalogAlreadyCurrent: boolean,
  model: { readonly id: string | null; readonly check: boolean },
  parentCorrelationId?: string,
): Promise<void> {
  const correlationId = newClientCorrelationId();
  const startedAt = performance.now();
  reportGatewayProfileRefresh(correlationId, parentCorrelationId);
  dispatch({ kind: "profile-empty" });
  try {
    const profile = await fetchCodingWorkbenchSidecarGatewayProfile(
      correlationId,
      model.id ?? undefined,
      model.check,
    );
    if (sequenceRef.current !== sequence) {
      settleGatewayProfileRefresh(
        correlationId,
        parentCorrelationId,
        startedAt,
        "superseded",
        "none",
      );
      return;
    }
    if (!catalogAlreadyCurrent) requestGatewayModelCatalogRefresh();
    dispatch({ kind: "source-set", source: codingWorkbenchSourceFromManaged(profile) });
    if (sourceVerificationPending(profile)) scheduleReread(sequence);
    settleGatewayProfileRefresh(
      correlationId,
      parentCorrelationId,
      startedAt,
      profile.status === "available" ? "adopted" : "unavailable",
      catalogAlreadyCurrent ? "skipped" : "requested",
    );
  } catch (error) {
    settleGatewayProfileRefresh(
      correlationId,
      parentCorrelationId,
      startedAt,
      sequenceRef.current === sequence ? "failed" : "superseded",
      "none",
    );
    throw error;
  }
}

// The re-read timer belongs to the mounted Workbench: a newer refresh replaces it, and unmounting
// clears it, so a closed Workbench never keeps reading the profile (#3591 review). Unmounting also
// retires the refresh sequence, so a read still in flight neither dispatches into the unmounted
// hook nor schedules a re-read when it lands.
function useVerificationReread(
  sequenceRef: RefObject<number>,
  refreshRef: RefObject<SourceRefresh>,
): (sequence: number) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => (): void => {
      clearTimeout(timerRef.current);
      sequenceRef.current += 1;
    },
    [sequenceRef],
  );
  return useCallback(
    (sequence: number): void => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        if (sequenceRef.current === sequence) void refreshRef.current(true);
      }, CODING_WORKBENCH_VERIFYING_REFRESH_MS);
    },
    [refreshRef, sequenceRef],
  );
}

function failSourceRefresh(
  preference: CodingWorkbenchRuntimeState["runtimePreference"],
  error: unknown,
  dispatch: RuntimeDispatch,
): void {
  const mapped = codingWorkbenchRuntimeApiError(error);
  const status = codingWorkbenchFailureStatus(mapped);
  dispatch({ kind: "resource-failed", resource: "source", status, error: mapped });
  if (preference === "codex-subscription")
    dispatch({ kind: "resource-failed", resource: "profile", status, error: mapped });
}

function useSourceRefresh(
  sequenceRef: RefObject<number>,
  stateRef: RefObject<CodingWorkbenchRuntimeState>,
  dispatch: RuntimeDispatch,
): SourceRefresh {
  const refreshRef = useRef<SourceRefresh>(() => Promise.resolve());
  const scheduleReread = useVerificationReread(sequenceRef, refreshRef);
  refreshRef.current = useCallback(
    async (
      catalogAlreadyCurrent = false,
      parentCorrelationId?: string,
      checkModel = false,
    ): Promise<void> => {
      const sequence = (sequenceRef.current += 1);
      const preference = stateRef.current.runtimePreference;
      dispatch({ kind: "resource-loading", resource: "source" });
      try {
        if (preference === "managed-gateway") {
          await refreshManagedGatewaySource(
            sequenceRef,
            sequence,
            dispatch,
            scheduleReread,
            catalogAlreadyCurrent,
            { id: stateRef.current.selectedModelId, check: checkModel },
            parentCorrelationId,
          );
          return;
        }
        dispatch({ kind: "resource-loading", resource: "profile" });
        const profile = await fetchCodingWorkbenchCodexSubscriptionProfile();
        if (sequenceRef.current !== sequence) return;
        setCodexSubscriptionSource(profile, dispatch);
      } catch (error) {
        if (sequenceRef.current !== sequence) return;
        failSourceRefresh(preference, error, dispatch);
      }
    },
    [dispatch, scheduleReread, sequenceRef, stateRef],
  );
  return refreshRef.current;
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
      // F-01: the subscription profile reports whether an authenticated CLI session exists, which is
      // not a live model round-trip. The gateway readiness probe says nothing about this source, so
      // it stays unverified rather than borrowing a confirmation from a connected auth state.
      verification: UNVERIFIED_GATEWAY,
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

// #3632: a call while a read is in flight may carry an event newer than that read saw, so it queues
// one more read after it; further calls in the meantime join that one. Reads never overlap.
function useRunRefresh(
  runSequence: RefObject<number>,
  runRefresh: RefObject<Promise<void> | null>,
  dispatch: RuntimeDispatch,
): () => Promise<void> {
  const followUp = useRef(false);
  return useCallback((): Promise<void> => {
    if (runRefresh.current !== null) {
      followUp.current = true;
      return runRefresh.current;
    }
    dispatch({ kind: "resource-loading", resource: "run" });
    const pending = (async (): Promise<void> => {
      do {
        followUp.current = false;
        runSequence.current += 1;
        await readRun(runSequence.current, runSequence, dispatch);
      } while (followUp.current);
    })();
    runRefresh.current = pending;
    void pending.then(() => {
      if (runRefresh.current === pending) runRefresh.current = null;
    });
    return pending;
  }, [dispatch, runRefresh, runSequence]);
}

async function readRun(
  sequence: number,
  runSequence: RefObject<number>,
  dispatch: RuntimeDispatch,
): Promise<void> {
  try {
    const snapshot = await getCodingWorkbenchRuntimeStatus();
    if (runSequence.current === sequence) dispatch({ kind: "run-set", snapshot });
  } catch (error) {
    if (runSequence.current !== sequence) return;
    const mapped = codingWorkbenchRuntimeApiError(error);
    // A read that hit its own deadline is already recorded by the API layer with its call kind and
    // deadline (`client.coding-workbench.request-timed-out`); a generic note would only repeat it.
    if (mapped.code !== RUNTIME_REQUEST_TIMEOUT_CODE) {
      // i18n-exempt: body-free diagnostic message for the activity log, never rendered
      reportClientDiagnostic("[keiko] coding workbench run status read failed", {
        kind: "other",
        errorKind: bffRequestErrorKind(error),
        ...(mapped.correlationId === undefined ? {} : { correlationId: mapped.correlationId }),
      });
    }
    dispatch({
      kind: "resource-failed",
      resource: "run",
      status: codingWorkbenchFailureStatus(mapped),
      error: mapped,
    });
  }
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

// ADR-0141 D6: a per-run control from a browser without app-session authority is answered with the
// same not-found result as an unknown run, so the refusal cannot say whether the session was revoked.
const RUN_NOT_FOUND_CODE = "CODING_RUNTIME_RUN_NOT_FOUND";

// The window's own readiness gate refuses with a conflict-coded error before any request is sent,
// so there is no newer server state to read after it.
const LOCAL_GATE_REFUSAL_CODE = "CODING_RUNTIME_ACTION_UNAVAILABLE";

// A 409 from the server means it holds a state this window has not seen yet (a stale revision, a
// run another paired client already settled): re-read so the newer snapshot can supersede the alert.
function isServerConflict(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.code !== LOCAL_GATE_REFUSAL_CODE
  );
}

/** One enqueued mutation. Its controller is aborted, with the preemption reason, only by Stop. */
interface PendingMutation {
  readonly kind: CodingWorkbenchMutationKind;
  readonly controller: AbortController;
}

function wasPreempted(signal: AbortSignal): boolean {
  return signal.aborted && isCodingWorkbenchPreempted(signal.reason);
}

// Stop is never queued behind another mutation (#4109): it ends the client wait of the one in
// flight and drops the ones still waiting for their turn. The server may still apply a preempted
// request; the run state reconciles through the Stop answer or a re-read. Another Stop is not
// preempted, so Stops keep their order.
function preemptForStop(pending: ReadonlySet<PendingMutation>): void {
  for (const entry of pending) {
    if (entry.kind !== "stop") entry.controller.abort(new CodingWorkbenchPreemptedError());
  }
}

// Resolves when `work` settles or the mutation is preempted, whichever comes first, so a re-read
// that never returns cannot hold Stop. A rejection of `work` before a preemption still rejects.
function untilPreempted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const preempted = new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  return Promise.race([work, preempted]);
}

async function applyMutationResult(
  { stateRef, refreshRun, dispatch }: RuntimeMutationQueueInput,
  command: CodingWorkbenchMutationCommand,
  snapshot: CodingWorkbenchRuntimeSnapshot,
  signal: AbortSignal,
): Promise<void> {
  if (mutationResultMatchesCurrentTruth(command, stateRef.current.run.value, snapshot)) {
    dispatch({ kind: "run-set", snapshot });
    return;
  }
  await untilPreempted(refreshRun(), signal);
}

async function failMutation(
  { refreshRun, dispatch }: RuntimeMutationQueueInput,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  // A request Stop took the place of is neither a failure nor a timeout: no alert, no report.
  if (wasPreempted(signal)) return;
  const failure = codingWorkbenchRuntimeApiError(error);
  dispatch({ kind: "mutation-failed", error: failure });
  if (failure.code === RUN_NOT_FOUND_CODE) requestCodingAppSessionReinspection();
  if (isServerConflict(error)) await untilPreempted(refreshRun(), signal);
}

// A control that hit its own deadline is already recorded by the API layer with its call kind and
// deadline (`client.coding-workbench.request-timed-out`), and one Stop took the place of failed
// nothing: neither gets a second note.
function reportMutationFailure(error: unknown, signal: AbortSignal): void {
  if (wasPreempted(signal)) return;
  const failure = codingWorkbenchRuntimeApiError(error);
  if (failure.code === RUNTIME_REQUEST_TIMEOUT_CODE) return;
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic("[keiko] coding workbench run control failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    ...(failure.correlationId === undefined ? {} : { correlationId: failure.correlationId }),
  });
}

async function runMutation(
  context: RuntimeMutationQueueInput,
  { kind, controller: { signal } }: PendingMutation,
  prepare: (current: CodingWorkbenchRuntimeState) => CodingWorkbenchMutationCommand,
): Promise<void> {
  // Stop took this mutation's place while it still waited for its turn: it is never sent.
  if (wasPreempted(signal)) return;
  try {
    const command = prepare(context.stateRef.current);
    context.dispatch({ kind: "mutation-start", mutation: kind, requestId: command.requestId });
    const snapshot = await command.run(signal);
    if (wasPreempted(signal)) return;
    await applyMutationResult(context, command, snapshot, signal);
    if (wasPreempted(signal)) return;
    context.dispatch({ kind: "mutation-complete" });
  } catch (error) {
    reportMutationFailure(error, signal);
    await failMutation(context, error, signal);
  }
}

type EnqueueMutation = (
  kind: CodingWorkbenchMutationKind,
  prepare: (current: CodingWorkbenchRuntimeState) => CodingWorkbenchMutationCommand,
  preempting?: boolean,
) => Promise<void>;

function useRuntimeMutationQueue(input: RuntimeMutationQueueInput): EnqueueMutation {
  const { stateRef, refreshRun, dispatch } = input;
  const mutationTail = useRef<Promise<void>>(Promise.resolve());
  const [pending] = useState(() => new Set<PendingMutation>());
  return useCallback(
    (kind, prepare, preempting = false): Promise<void> => {
      const entry: PendingMutation = { kind, controller: new AbortController() };
      if (preempting) preemptForStop(pending);
      pending.add(entry);
      const execute = async (): Promise<void> => {
        try {
          await runMutation({ stateRef, refreshRun, dispatch }, entry, prepare);
        } finally {
          pending.delete(entry);
        }
      };
      const result = mutationTail.current.then(execute, execute);
      mutationTail.current = result;
      return result;
    },
    [dispatch, pending, refreshRun, stateRef],
  );
}

export function useCodingWorkbenchRuntimeMutations(
  input: RuntimeMutationQueueInput,
): RuntimeMutationActions {
  const enqueueMutation = useRuntimeMutationQueue(input);
  const start = useCallback(
    (taskIntent: string, options: CodingWorkbenchStartOptions): Promise<void> =>
      enqueueMutation("start", (current) => createStartMutation(taskIntent, current, options)),
    [enqueueMutation],
  );
  const decideApproval = useCallback(
    (decision: CodingWorkbenchRuntimeApprovalDecision): Promise<void> =>
      enqueueMutation("approval", (current) => createApprovalMutation(decision, current)),
    [enqueueMutation],
  );
  // Stop preempts a pending mutation, but only when it has a run to stop: a Stop the window would
  // refuse locally must not end a mutation (a Start) it cannot replace.
  const runBoundMutation = useCallback(
    (kind: "stop" | "takeover"): Promise<void> =>
      enqueueMutation(
        kind,
        (current) => createRunBoundMutation(kind, current),
        kind === "stop" && runBoundTarget(input.stateRef.current) !== null,
      ),
    [enqueueMutation, input.stateRef],
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
    (requestedMode: CodingWorkbenchMode): Promise<void> =>
      enqueueMutation("resume", (current) =>
        createLifecycleMutation("resume", current, requestedMode),
      ),
    [enqueueMutation],
  );
  const submitFollowUp = useCallback(
    (taskIntent: string, inputs?: CodingWorkbenchFollowUpInputs): Promise<void> =>
      enqueueMutation("follow-up", (current) =>
        createFollowUpMutation(taskIntent, current, inputs),
      ),
    [enqueueMutation],
  );
  const revert = useCallback(
    (action: CodingWorkbenchRuntimeRevertAction): Promise<void> =>
      enqueueMutation("revert", (current) => createRevertMutation(action, current)),
    [enqueueMutation],
  );
  const inboxAction = useCallback(
    (action: CodingWorkbenchRuntimeInboxAction, itemId: string): Promise<void> =>
      enqueueMutation("inbox", (current) => createInboxMutation(action, itemId, current)),
    [enqueueMutation],
  );
  const revokeResearchGrant = useCallback(
    (grant: CodingWorkbenchRuntimeResearchGrant): Promise<void> =>
      enqueueMutation("research-revoke", (current) => createResearchRevokeMutation(current, grant)),
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
    revert,
    inboxAction,
    revokeResearchGrant,
  };
}
