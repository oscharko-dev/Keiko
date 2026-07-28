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
  TaskWorkspaceHealth,
} from "@oscharko-dev/keiko-contracts";
import { retainCodingWorkbenchRuntimeEvents } from "./coding-workbench-event-retention";

export type CodingWorkbenchResourceStatus =
  "idle" | "loading" | "ready" | "empty" | "unavailable" | "error";

export interface CodingWorkbenchClientError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
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
      }
    : {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: false,
        unavailableReason: profile.reason,
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
  readonly profile: CodingWorkbenchResourceState<CodingWorkbenchCodexSubscriptionProfile>;
  readonly codexSetup: CodingWorkbenchResourceState<CodingWorkbenchCodexAuthSetupPlan>;
  readonly source: CodingWorkbenchResourceState<CodingWorkbenchSourceProjection>;
  readonly runtime: CodingWorkbenchResourceState<CodingWorkbenchRuntimeReadiness>;
  readonly workspace: CodingWorkbenchResourceState<CodingWorkbenchWorkspaceProjection>;
  readonly run: CodingWorkbenchResourceState<CodingWorkbenchRuntimeSnapshot>;
  readonly stream: CodingWorkbenchResourceState<CodingWorkbenchStreamProjection>;
  readonly mutation: CodingWorkbenchMutationState;
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
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
  | { readonly kind: "events-reset" };

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
    profile: emptyResource(),
    codexSetup: emptyResource(),
    source: emptyResource(),
    runtime: emptyResource(),
    workspace: emptyResource(),
    run: emptyResource(),
    stream: emptyResource(),
    mutation: IDLE_MUTATION,
    events: [],
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

function isConcreteTerminalState(state: CodingWorkbenchRuntimeStateName): boolean {
  return state !== "idle" && STARTABLE_RUN_STATES.has(state);
}

function isConcreteTerminalRun(snapshot: CodingWorkbenchRuntimeSnapshot): boolean {
  return snapshot.runId !== undefined && isConcreteTerminalState(snapshot.state);
}

function isUnboundIdle(snapshot: CodingWorkbenchRuntimeSnapshot): boolean {
  return snapshot.runId === undefined && snapshot.state === "idle";
}

function projectReadiness(state: CodingWorkbenchRuntimeState): CodingWorkbenchRuntimeState {
  const runtime = state.runtime.value;
  const sourceReady =
    state.source.status === "ready" &&
    state.source.value?.runtimePreference === state.runtimePreference &&
    state.source.value.available === true;
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
  return {
    ...state,
    canStart: sourceReady && workspaceReady && authorityReady && runReady && mutationIdle,
    canRetry:
      sourceReady &&
      workspaceReady &&
      authorityReady &&
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
  if (current !== null && isConcreteTerminalRun(current) && isUnboundIdle(snapshot)) {
    return projectReadiness({ ...state, run: ready(current) });
  }
  if (
    current !== null &&
    current.runId === snapshot.runId &&
    current.revision > snapshot.revision
  ) {
    return state;
  }
  const changedRun = current?.runId !== snapshot.runId;
  return projectReadiness({
    ...state,
    run: ready(snapshot),
    ...(changedRun ? { events: [], stream: emptyResource() } : {}),
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
  return {
    ...current,
    state: latest.state,
    revision: latest.revision,
    updatedAt: latest.occurredAt,
    runId: latest.runId,
    failureCode: latest.failureCode,
    pendingPermission: undefined,
  };
}

function acceptEvents(
  state: CodingWorkbenchRuntimeState,
  incoming: readonly CodingWorkbenchRuntimeSseEvent[],
): CodingWorkbenchRuntimeState {
  const events = retainCodingWorkbenchRuntimeEvents(state.events, incoming);
  const terminal = terminalSnapshotFromEvents(state.run.value, incoming);
  return terminal === null
    ? { ...state, events }
    : projectReadiness({ ...state, run: ready(terminal), events });
}

type RuntimeActionHandlers = {
  readonly [Kind in CodingWorkbenchRuntimeStateAction["kind"]]: (
    state: CodingWorkbenchRuntimeState,
    action: Extract<CodingWorkbenchRuntimeStateAction, { readonly kind: Kind }>,
  ) => CodingWorkbenchRuntimeState;
};

const runtimeActionHandlers = {
  "select-mode": (state, action) => selectMode(state, action.mode),
  "select-runtime-preference": (state, action) => selectPreference(state, action.preference),
  "resource-loading": (state, action) => resourceLoading(state, action.resource),
  "resource-failed": (state, action) => resourceFailed(state, action),
  "profile-set": (state, action) => ({ ...state, profile: ready(action.profile) }),
  "profile-empty": (state) => ({ ...state, profile: emptyResource("empty") }),
  "codex-setup-set": (state, action) => ({ ...state, codexSetup: ready(action.plan) }),
  "source-set": (state, action) =>
    action.source.runtimePreference !== state.runtimePreference
      ? state
      : projectReadiness({ ...state, source: ready(action.source) }),
  "runtime-set": (state, action) =>
    projectReadiness({ ...state, runtime: ready(action.readiness) }),
  "workspace-set": (state, action) =>
    projectReadiness({
      ...state,
      workspace: action.workspace ? ready(action.workspace) : emptyResource("empty"),
    }),
  "run-set": (state, action) => acceptSnapshot(state, action.snapshot),
  "stream-set": (state, action) => ({ ...state, stream: ready(action.stream) }),
  "mutation-start": (state, action) =>
    projectReadiness({
      ...state,
      mutation: {
        status: "pending",
        kind: action.mutation,
        requestId: action.requestId,
        error: null,
      },
    }),
  "mutation-complete": (state) => projectReadiness({ ...state, mutation: IDLE_MUTATION }),
  "mutation-failed": (state, action) =>
    projectReadiness({
      ...state,
      mutation: { ...state.mutation, status: "error", error: action.error },
    }),
  "events-received": (state, action) => acceptEvents(state, action.events),
  "events-reset": (state) => ({ ...state, events: [], stream: emptyResource() }),
} satisfies RuntimeActionHandlers;

export function codingWorkbenchRuntimeReducer(
  state: CodingWorkbenchRuntimeState,
  action: CodingWorkbenchRuntimeStateAction,
): CodingWorkbenchRuntimeState {
  return runtimeActionHandlers[action.kind](state, action as never);
}
