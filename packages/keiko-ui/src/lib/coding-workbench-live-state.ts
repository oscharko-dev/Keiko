import {
  gatewayVerificationContradictsReadiness,
  UNVERIFIED_GATEWAY,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchSidecarGatewayResult,
  GatewayVerificationState,
  ModelReasoningEffort,
  TaskWorkspaceHealth,
} from "@oscharko-dev/keiko-contracts";
import { retainCodingWorkbenchRuntimeEvents } from "./coding-workbench-event-retention";

export type CodingWorkbenchResourceStatus =
  "idle" | "loading" | "ready" | "empty" | "unavailable" | "error";

/**
 * Release-audit F-08/RG-12: whether this browser window holds a launcher-paired app session, as
 * reported by the honest workspaces read (`session: "paired" | "unpaired"`). Never guessed
 * client-side. Runtime start may proceed once the workspace is resolved, but content-bearing
 * channels still use this dimension; `unknown` (boot, or the read failed) blocks start fail-closed
 * without claiming the window is unpaired.
 */
export type CodingWorkbenchPairingState = "unknown" | "paired" | "unpaired";

export interface CodingWorkbenchClientError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /** Copyable support id tying a surfaced failure to one redacted server diagnostic (RB-6). */
  readonly correlationId?: string;
}

export interface CodingWorkbenchResourceState<T> {
  readonly status: CodingWorkbenchResourceStatus;
  readonly value: T | null;
  readonly error: CodingWorkbenchClientError | null;
}

export interface CodingWorkbenchWorkspaceProjection {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly taskBranch: string;
  readonly health: TaskWorkspaceHealth;
  readonly switching: boolean;
}

export interface CodingWorkbenchSourceProjection {
  readonly runtimePreference: CodingWorkbenchRuntimePreference;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly available: boolean;
  readonly unavailableReason?: string | undefined;
  /**
   * F-01: what a live probe last said about this source. `available` answers "is a source
   * configured"; this answers "did anyone confirm it answers". A never-probed source is
   * `unverified` — labelled as unconfirmed, never rendered as healthy — and a `failed` probe stops
   * the source counting as ready at all.
   */
  readonly verification: GatewayVerificationState;
}

export function codingWorkbenchSourceFromManaged(
  profile: CodingWorkbenchSidecarGatewayResult,
): CodingWorkbenchSourceProjection {
  return profile.status === "available"
    ? {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: true,
        verification: profile.verification,
      }
    : {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: false,
        unavailableReason: profile.reason,
        // An unavailable profile was never probed as a usable source; saying anything else would
        // attach a health claim to a source the config already rules out.
        verification: UNVERIFIED_GATEWAY,
      };
}

export interface CodingWorkbenchStreamProjection {
  readonly runId: string;
  readonly cursor: string | null;
  readonly connected: boolean;
}

export type CodingWorkbenchMutationKind =
  | "start"
  | "approval"
  | "stop"
  | "takeover"
  | "retry"
  | "recovery-ack"
  | "pause"
  | "resume"
  | "follow-up"
  | "research-revoke";

export interface CodingWorkbenchMutationState {
  readonly status: "idle" | "pending" | "error";
  readonly kind: CodingWorkbenchMutationKind | null;
  readonly requestId: string | null;
  readonly error: CodingWorkbenchClientError | null;
}

export interface CodingWorkbenchRuntimeState {
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference: CodingWorkbenchRuntimePreference;
  readonly selectedModelId: string | null;
  readonly reasoningEffort: ModelReasoningEffort | null;
  readonly profile: CodingWorkbenchResourceState<CodingWorkbenchCodexSubscriptionProfile>;
  readonly codexSetup: CodingWorkbenchResourceState<CodingWorkbenchCodexAuthSetupPlan>;
  readonly source: CodingWorkbenchResourceState<CodingWorkbenchSourceProjection>;
  readonly runtime: CodingWorkbenchResourceState<CodingWorkbenchRuntimeReadiness>;
  readonly workspace: CodingWorkbenchResourceState<CodingWorkbenchWorkspaceProjection>;
  readonly run: CodingWorkbenchResourceState<CodingWorkbenchRuntimeSnapshot>;
  readonly stream: CodingWorkbenchResourceState<CodingWorkbenchStreamProjection>;
  readonly mutation: CodingWorkbenchMutationState;
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly pairing: CodingWorkbenchPairingState;
  readonly canStart: boolean;
  readonly canRetry: boolean;
}

export type CodingWorkbenchResourceKey =
  "profile" | "codexSetup" | "source" | "runtime" | "workspace" | "run" | "stream";

export type CodingWorkbenchRuntimeStateAction =
  | { readonly kind: "select-mode"; readonly mode: CodingWorkbenchMode }
  | {
      readonly kind: "select-runtime-preference";
      readonly preference: CodingWorkbenchRuntimePreference;
    }
  | { readonly kind: "select-model"; readonly modelId: string | null }
  | { readonly kind: "select-reasoning-effort"; readonly effort: ModelReasoningEffort | null }
  | { readonly kind: "resource-loading"; readonly resource: CodingWorkbenchResourceKey }
  | { readonly kind: "profile-set"; readonly profile: CodingWorkbenchCodexSubscriptionProfile }
  | { readonly kind: "profile-empty" }
  | { readonly kind: "codex-setup-set"; readonly plan: CodingWorkbenchCodexAuthSetupPlan }
  | { readonly kind: "source-set"; readonly source: CodingWorkbenchSourceProjection }
  | { readonly kind: "runtime-set"; readonly readiness: CodingWorkbenchRuntimeReadiness }
  | {
      readonly kind: "workspace-set";
      readonly workspace: CodingWorkbenchWorkspaceProjection | null;
    }
  | { readonly kind: "run-set"; readonly snapshot: CodingWorkbenchRuntimeSnapshot }
  | { readonly kind: "stream-set"; readonly stream: CodingWorkbenchStreamProjection }
  | {
      readonly kind: "resource-failed";
      readonly resource: CodingWorkbenchResourceKey;
      readonly status: "unavailable" | "error";
      readonly error: CodingWorkbenchClientError;
    }
  | {
      readonly kind: "mutation-start";
      readonly mutation: CodingWorkbenchMutationKind;
      readonly requestId: string;
    }
  | { readonly kind: "mutation-complete" }
  | { readonly kind: "mutation-failed"; readonly error: CodingWorkbenchClientError }
  | { readonly kind: "events-received"; readonly events: readonly CodingWorkbenchRuntimeSseEvent[] }
  | { readonly kind: "events-reset" }
  | { readonly kind: "pairing-set"; readonly pairing: CodingWorkbenchPairingState };

const emptyResource = <T>(
  status: CodingWorkbenchResourceStatus = "idle",
): CodingWorkbenchResourceState<T> => ({ status, value: null, error: null });

const IDLE_MUTATION: CodingWorkbenchMutationState = {
  status: "idle",
  kind: null,
  requestId: null,
  error: null,
};

export function createInitialCodingWorkbenchRuntimeState(
  requestedMode: CodingWorkbenchMode = "supervised-coding",
  runtimePreference: CodingWorkbenchRuntimePreference = "managed-gateway",
): CodingWorkbenchRuntimeState {
  return {
    requestedMode,
    runtimePreference,
    selectedModelId: null,
    reasoningEffort: null,
    profile: emptyResource(),
    codexSetup: emptyResource(),
    source: emptyResource(),
    runtime: emptyResource(),
    workspace: emptyResource(),
    run: emptyResource(),
    stream: emptyResource(),
    mutation: IDLE_MUTATION,
    events: [],
    pairing: "unknown",
    canStart: false,
    canRetry: false,
  };
}

function ready<T>(value: T): CodingWorkbenchResourceState<T> {
  return { status: "ready", value, error: null };
}

const STARTABLE_RUN_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "idle",
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export const STREAMABLE_CODING_WORKBENCH_RUNTIME_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> =
  new Set([
    "starting",
    "ready",
    "running",
    "paused",
    "awaiting-approval",
    "stopping",
    "recovery-required",
  ]);

function isConcreteTerminalState(state: CodingWorkbenchRuntimeStateName): boolean {
  return state !== "idle" && STARTABLE_RUN_STATES.has(state);
}

function isConcreteTerminalRun(snapshot: CodingWorkbenchRuntimeSnapshot): boolean {
  return snapshot.runId !== undefined && isConcreteTerminalState(snapshot.state);
}

function isStreamableSnapshot(snapshot: CodingWorkbenchRuntimeSnapshot | null): boolean {
  return (
    snapshot?.runId !== undefined && STREAMABLE_CODING_WORKBENCH_RUNTIME_STATES.has(snapshot.state)
  );
}

function isUnboundIdle(snapshot: CodingWorkbenchRuntimeSnapshot): boolean {
  return snapshot.runId === undefined && snapshot.state === "idle";
}

function shouldRetainTerminalRun(
  current: CodingWorkbenchRuntimeSnapshot,
  snapshot: CodingWorkbenchRuntimeSnapshot,
): boolean {
  return isConcreteTerminalRun(current) && isUnboundIdle(snapshot);
}

function shouldIgnoreOlderSnapshot(
  current: CodingWorkbenchRuntimeSnapshot | null,
  snapshot: CodingWorkbenchRuntimeSnapshot,
): boolean {
  return (
    current !== null && current.runId === snapshot.runId && current.revision > snapshot.revision
  );
}

function streamForSnapshot(
  state: CodingWorkbenchRuntimeState,
  snapshot: CodingWorkbenchRuntimeSnapshot,
  changedRun: boolean,
): CodingWorkbenchResourceState<CodingWorkbenchStreamProjection> {
  return changedRun || !isStreamableSnapshot(snapshot) ? emptyResource() : state.stream;
}

function acceptStreamProjection(
  state: CodingWorkbenchRuntimeState,
  stream: CodingWorkbenchStreamProjection,
): CodingWorkbenchRuntimeState {
  const snapshot = state.run.value;
  if (snapshot === null || !isStreamableSnapshot(snapshot) || snapshot.runId !== stream.runId) {
    return { ...state, stream: emptyResource() };
  }
  return { ...state, stream: ready(stream) };
}

function projectReadiness(state: CodingWorkbenchRuntimeState): CodingWorkbenchRuntimeState {
  const runtime = state.runtime.value;
  // F-01: `available` is stored-config truth. A probe that ran and could not reach the gateway
  // contradicts it, so the source stops counting as ready — starting a run against a source the
  // product just failed to reach is the "green claim not backed by a probe" this closes. A source
  // nobody has probed stays startable and is labelled unverified instead: withholding the start
  // button on an absence of evidence would gate the whole product behind an optional check.
  const sourceReady =
    state.source.status === "ready" &&
    state.source.value?.runtimePreference === state.runtimePreference &&
    state.source.value.available === true &&
    !gatewayVerificationContradictsReadiness(state.source.value.verification);
  const workspaceReady =
    state.workspace.status === "ready" &&
    state.workspace.value?.health === "healthy" &&
    state.workspace.value.switching !== true;
  const authorityReady =
    state.runtime.status === "ready" &&
    runtime?.runtimeAvailable === true &&
    runtime.requestedMode === state.requestedMode;
  const runState = state.run.value?.state;
  const runReady =
    state.run.status === "ready" && runState !== undefined && STARTABLE_RUN_STATES.has(runState);
  const mutationIdle = state.mutation.status !== "pending";
  // Pairing is a channel diagnostic, not a local-composer kill switch. `unknown` still blocks while
  // the boot read is unresolved, but a confirmed unpaired browser must be allowed to send the start
  // request so the server can either bind the registered workspace or return the authoritative
  // failure. Blocking it here left a filled composer with a dead send button.
  const pairingReady = state.pairing !== "unknown";
  return {
    ...state,
    canStart:
      sourceReady && workspaceReady && authorityReady && runReady && mutationIdle && pairingReady,
    canRetry:
      sourceReady &&
      workspaceReady &&
      authorityReady &&
      pairingReady &&
      runState === "recovery-required" &&
      state.run.value?.recoveryAcknowledged === true &&
      mutationIdle,
  };
}

function selectMode(
  state: CodingWorkbenchRuntimeState,
  mode: CodingWorkbenchMode,
): CodingWorkbenchRuntimeState {
  if (state.requestedMode === mode) return state;
  return projectReadiness({ ...state, requestedMode: mode, runtime: emptyResource() });
}

function selectPreference(
  state: CodingWorkbenchRuntimeState,
  runtimePreference: CodingWorkbenchRuntimePreference,
): CodingWorkbenchRuntimeState {
  if (state.runtimePreference === runtimePreference) return state;
  return projectReadiness({
    ...state,
    runtimePreference,
    selectedModelId: null,
    reasoningEffort: null,
    profile: emptyResource(),
    codexSetup: emptyResource(),
    source: emptyResource(),
  });
}

function resourceLoading(
  state: CodingWorkbenchRuntimeState,
  resource: CodingWorkbenchResourceKey,
): CodingWorkbenchRuntimeState {
  if (resource === "run") {
    return projectReadiness({
      ...state,
      run: { status: "loading", value: state.run.value, error: null },
    });
  }
  return projectReadiness({ ...state, [resource]: emptyResource("loading") });
}

function resourceFailed(
  state: CodingWorkbenchRuntimeState,
  action: Extract<CodingWorkbenchRuntimeStateAction, { kind: "resource-failed" }>,
): CodingWorkbenchRuntimeState {
  if (action.resource === "stream" && !isStreamableSnapshot(state.run.value)) return state;
  if (action.resource === "run") {
    return projectReadiness({
      ...state,
      run: { status: action.status, value: state.run.value, error: action.error },
    });
  }
  return projectReadiness({
    ...state,
    [action.resource]: { status: action.status, value: null, error: action.error },
  });
}

function acceptSnapshot(
  state: CodingWorkbenchRuntimeState,
  snapshot: CodingWorkbenchRuntimeSnapshot,
): CodingWorkbenchRuntimeState {
  const current = state.run.value;
  if (current !== null && shouldRetainTerminalRun(current, snapshot)) {
    return projectReadiness({ ...state, run: ready(current), stream: emptyResource() });
  }
  if (shouldIgnoreOlderSnapshot(current, snapshot)) return state;
  const changedRun = current?.runId !== snapshot.runId;
  return projectReadiness({
    ...state,
    run: ready(snapshot),
    stream: streamForSnapshot(state, snapshot, changedRun),
    ...(changedRun ? { events: [] } : {}),
  });
}

function terminalSnapshotFromEvents(
  current: CodingWorkbenchRuntimeSnapshot | null,
  events: readonly CodingWorkbenchRuntimeSseEvent[],
): CodingWorkbenchRuntimeSnapshot | null {
  if (current?.runId === undefined) return null;
  let latest: Extract<CodingWorkbenchRuntimeSseEvent, { readonly kind: "status" }> | undefined;
  for (const event of events) {
    if (event.kind !== "status" || event.runId !== current.runId) continue;
    if (!isConcreteTerminalState(event.state) || event.revision < current.revision) continue;
    if (latest === undefined || event.revision >= latest.revision) latest = event;
  }
  if (latest === undefined) return null;
  const terminal = {
    ...current,
    state: latest.state,
    revision: latest.revision,
    updatedAt: latest.occurredAt,
    runId: latest.runId,
    failureCode: latest.failureCode,
    pendingPermission: undefined,
  };
  delete terminal.recoveryAcknowledged;
  return terminal;
}

function acceptEvents(
  state: CodingWorkbenchRuntimeState,
  incoming: readonly CodingWorkbenchRuntimeSseEvent[],
): CodingWorkbenchRuntimeState {
  const events = retainCodingWorkbenchRuntimeEvents(state.events, incoming);
  const terminal = terminalSnapshotFromEvents(state.run.value, incoming);
  return terminal === null
    ? { ...state, events }
    : projectReadiness({ ...state, run: ready(terminal), stream: emptyResource(), events });
}

type RuntimeActionHandlers = {
  readonly [Kind in CodingWorkbenchRuntimeStateAction["kind"]]: (
    state: CodingWorkbenchRuntimeState,
    action: Extract<CodingWorkbenchRuntimeStateAction, { readonly kind: Kind }>,
  ) => CodingWorkbenchRuntimeState;
};

const runtimeActionHandlers = {
  "select-mode": (state, action): CodingWorkbenchRuntimeState => selectMode(state, action.mode),
  "select-runtime-preference": (state, action): CodingWorkbenchRuntimeState =>
    selectPreference(state, action.preference),
  "select-model": (state, action): CodingWorkbenchRuntimeState => ({
    ...state,
    selectedModelId: action.modelId,
    reasoningEffort: null,
  }),
  "select-reasoning-effort": (state, action): CodingWorkbenchRuntimeState => ({
    ...state,
    reasoningEffort: action.effort,
  }),
  "resource-loading": (state, action): CodingWorkbenchRuntimeState =>
    resourceLoading(state, action.resource),
  "resource-failed": (state, action): CodingWorkbenchRuntimeState => resourceFailed(state, action),
  "profile-set": (state, action): CodingWorkbenchRuntimeState => ({
    ...state,
    profile: ready(action.profile),
  }),
  "profile-empty": (state): CodingWorkbenchRuntimeState => ({
    ...state,
    profile: emptyResource("empty"),
  }),
  "codex-setup-set": (state, action): CodingWorkbenchRuntimeState => ({
    ...state,
    codexSetup: ready(action.plan),
  }),
  "source-set": (state, action): CodingWorkbenchRuntimeState =>
    action.source.runtimePreference !== state.runtimePreference
      ? state
      : projectReadiness({ ...state, source: ready(action.source) }),
  "runtime-set": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({ ...state, runtime: ready(action.readiness) }),
  "workspace-set": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({
      ...state,
      workspace: action.workspace ? ready(action.workspace) : emptyResource("empty"),
    }),
  "run-set": (state, action): CodingWorkbenchRuntimeState => acceptSnapshot(state, action.snapshot),
  "stream-set": (state, action): CodingWorkbenchRuntimeState =>
    acceptStreamProjection(state, action.stream),
  "mutation-start": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({
      ...state,
      mutation: {
        status: "pending",
        kind: action.mutation,
        requestId: action.requestId,
        error: null,
      },
    }),
  "mutation-complete": (state): CodingWorkbenchRuntimeState =>
    projectReadiness({ ...state, mutation: IDLE_MUTATION }),
  "mutation-failed": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({
      ...state,
      mutation: { ...state.mutation, status: "error", error: action.error },
    }),
  "events-received": (state, action): CodingWorkbenchRuntimeState =>
    acceptEvents(state, action.events),
  "events-reset": (state): CodingWorkbenchRuntimeState => ({
    ...state,
    events: [],
    stream: emptyResource(),
  }),
  "pairing-set": (state, action): CodingWorkbenchRuntimeState =>
    state.pairing === action.pairing
      ? state
      : projectReadiness({ ...state, pairing: action.pairing }),
} satisfies RuntimeActionHandlers;

export function codingWorkbenchRuntimeReducer(
  state: CodingWorkbenchRuntimeState,
  action: CodingWorkbenchRuntimeStateAction,
): CodingWorkbenchRuntimeState {
  return runtimeActionHandlers[action.kind](state, action as never);
}
