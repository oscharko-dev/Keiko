import {
  gatewayVerificationContradictsReadiness,
  UNVERIFIED_GATEWAY,
} from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import {
  DEFAULT_CODING_WORKBENCH_AGENT,
  isCodingWorkbenchAgent,
  isCodingWorkbenchBuiltInAgent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchBuiltInAgent,
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchMode,
  CodingWorkbenchModelRefusalReason,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimePromptInputs,
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
 * client-side. Every runtime mutation needs this session authority, so both `unknown` (boot, or
 * the read failed) and `unpaired` block start fail-closed.
 */
export type CodingWorkbenchPairingState = "unknown" | "paired" | "unpaired";

export interface CodingWorkbenchClientError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /** Copyable support id tying a surfaced failure to one redacted server diagnostic (RB-6). */
  readonly correlationId?: string;
  /** Why a refused start refused the chosen model, when the server named it (#3603). */
  readonly modelRefusalReason?: CodingWorkbenchModelRefusalReason;
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
  readonly unavailableReason?: string;
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
  | "revert"
  | "inbox"
  | "research-revoke";

export interface CodingWorkbenchMutationState {
  readonly status: "idle" | "pending" | "error";
  readonly kind: CodingWorkbenchMutationKind | null;
  readonly requestId: string | null;
  readonly error: CodingWorkbenchClientError | null;
  /**
   * The run revision the failed action was attempted against. A later snapshot that moves past it
   * (a newer revision, or another run) supersedes the failure: the alert described a state that no
   * longer exists. A snapshot that merely repeats the revision proves nothing and keeps the alert.
   */
  readonly failedAgainst?: { readonly runId: string | null; readonly revision: number };
}

export interface CodingWorkbenchRuntimeState {
  readonly requestedMode: CodingWorkbenchMode;
  /**
   * The primary agent the next turn runs under (#3897). A built-in `offeredCodingWorkbenchAgents`
   * lists, or a custom primary agent where the server offers them (#3903 AC1): the reducer returns
   * it to the default whenever the offer narrows, and the server confirms a custom one against the
   * run's live listing.
   */
  readonly agent: CodingWorkbenchAgent;
  /**
   * The agents the server's last readiness read said its tool profile can honour. Kept across a
   * mode change (which empties `runtime` while the next read loads) so the agent switch does not
   * disappear and reappear; never widened by the browser.
   */
  readonly selectableAgents: readonly CodingWorkbenchBuiltInAgent[];
  /**
   * What the server's last readiness read said the composed runtime can do with a prompt's inputs
   * (ADR-0137 D10): send a message while a turn runs, and attach referenced workspace files. Kept
   * across a mode change like `selectableAgents`, so the controls do not flicker while the next
   * read loads; never widened by the browser.
   */
  readonly promptInputs: CodingWorkbenchRuntimePromptInputs;
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
  | { readonly kind: "select-agent"; readonly agent: CodingWorkbenchAgent }
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
  | { readonly kind: "stream-reconnecting" }
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

/** What a runtime that reports nothing can do with a prompt's inputs: neither. */
export const NO_CODING_WORKBENCH_PROMPT_INPUTS: CodingWorkbenchRuntimePromptInputs = Object.freeze({
  delivery: false,
  references: false,
});

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
    agent: DEFAULT_CODING_WORKBENCH_AGENT,
    selectableAgents: [DEFAULT_CODING_WORKBENCH_AGENT],
    promptInputs: NO_CODING_WORKBENCH_PROMPT_INPUTS,
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
): CodingWorkbenchResourceState<CodingWorkbenchStreamProjection> {
  return !isStreamableSnapshot(snapshot) ? emptyResource() : state.stream;
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

// The browser is reconnecting an interrupted source by itself: a polite status, not a failure. The
// last cursor stays so the next open resumes from it; `stream-set` on the open turns it ready again.
function markStreamReconnecting(state: CodingWorkbenchRuntimeState): CodingWorkbenchRuntimeState {
  const snapshot = state.run.value;
  if (snapshot === null || !isStreamableSnapshot(snapshot)) return state;
  const previous = state.stream.value;
  return {
    ...state,
    stream: {
      status: "loading",
      value:
        previous === null || previous.runId !== snapshot.runId
          ? null
          : { ...previous, connected: false },
      error: null,
    },
  };
}

/**
 * #3390 recovery-ack-restart: once the operator has explicitly acknowledged a `recovery-required`
 * predecessor, the server treats that acknowledgement as the reconciliation ADR-0137 D5 requires
 * before a replacement run may start (`CodingRuntimeOrchestrator.start` auto-detects it). The
 * client-side start guard must agree, or the composer's single "Start coding run" action stays
 * disabled forever after a restart and the operator has no way to launch a replacement run short
 * of wiping local state.
 */
function isAcknowledgedRecoveryRequired(state: CodingWorkbenchRuntimeState): boolean {
  return (
    state.run.value?.state === "recovery-required" && state.run.value.recoveryAcknowledged === true
  );
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
    state.run.status === "ready" &&
    runState !== undefined &&
    (STARTABLE_RUN_STATES.has(runState) || isAcknowledgedRecoveryRequired(state));
  const mutationIdle = state.mutation.status !== "pending";
  // A confirmed unpaired browser cannot mutate the runtime: the server correctly refuses every
  // such request. Keep the draft editable, but do not present a Start or Retry action that is
  // guaranteed to fail authority resolution.
  const pairingReady = state.pairing === "paired";
  const modelSelected =
    state.runtimePreference !== "managed-gateway" || state.selectedModelId !== null;
  return {
    ...state,
    canStart:
      sourceReady &&
      workspaceReady &&
      authorityReady &&
      runReady &&
      mutationIdle &&
      pairingReady &&
      modelSelected,
    canRetry:
      sourceReady &&
      workspaceReady &&
      authorityReady &&
      pairingReady &&
      isAcknowledgedRecoveryRequired(state) &&
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

/**
 * The primary agents the browser may offer right now. Only the managed gateway runs OpenCode, whose
 * `plan` agent exists on the native tool profile; a Codex subscription run has no agent concept
 * and the server refuses `plan` for it, so it offers the default agent alone.
 */
export function offeredCodingWorkbenchAgents(
  state: Pick<CodingWorkbenchRuntimeState, "runtimePreference" | "selectableAgents">,
): readonly CodingWorkbenchBuiltInAgent[] {
  return state.runtimePreference === "managed-gateway"
    ? state.selectableAgents
    : [DEFAULT_CODING_WORKBENCH_AGENT];
}

/**
 * The prompt inputs the browser may offer right now. Only the managed gateway runs OpenCode, whose
 * native profile reads referenced files and takes a message while a turn runs; a Codex
 * subscription run has neither, and the server refuses both for it.
 */
export function offeredCodingWorkbenchPromptInputs(
  state: Pick<CodingWorkbenchRuntimeState, "runtimePreference" | "promptInputs">,
): CodingWorkbenchRuntimePromptInputs {
  return state.runtimePreference === "managed-gateway"
    ? state.promptInputs
    : NO_CODING_WORKBENCH_PROMPT_INPUTS;
}

/**
 * Whether the browser may offer `agent` right now: a built-in the server lists, or a custom primary
 * agent (#3903 AC1) where the server's profile runs OpenCode's own agents, the one that offers
 * `plan`. Which custom agents exist is the run's own listing; the server confirms the one chosen.
 */
export function isOfferedCodingWorkbenchAgent(
  state: Pick<CodingWorkbenchRuntimeState, "runtimePreference" | "selectableAgents">,
  agent: CodingWorkbenchAgent,
): boolean {
  const offered = offeredCodingWorkbenchAgents(state);
  if (isCodingWorkbenchBuiltInAgent(agent)) return offered.includes(agent);
  return isCodingWorkbenchAgent(agent) && offered.includes("plan");
}

// The selection never outlives its offer: whatever narrows the offer returns it to the default.
function withOfferedAgent(state: CodingWorkbenchRuntimeState): CodingWorkbenchRuntimeState {
  return isOfferedCodingWorkbenchAgent(state, state.agent)
    ? state
    : { ...state, agent: DEFAULT_CODING_WORKBENCH_AGENT };
}

function selectAgent(
  state: CodingWorkbenchRuntimeState,
  agent: CodingWorkbenchAgent,
): CodingWorkbenchRuntimeState {
  if (state.agent === agent || !isOfferedCodingWorkbenchAgent(state, agent)) return state;
  return { ...state, agent };
}

function selectPreference(
  state: CodingWorkbenchRuntimeState,
  runtimePreference: CodingWorkbenchRuntimePreference,
): CodingWorkbenchRuntimeState {
  if (state.runtimePreference === runtimePreference) return state;
  return projectReadiness(
    withOfferedAgent({
      ...state,
      runtimePreference,
      selectedModelId: null,
      reasoningEffort: null,
      profile: emptyResource(),
      codexSetup: emptyResource(),
      source: emptyResource(),
    }),
  );
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

function snapshotSupersedesFailure(
  mutation: CodingWorkbenchMutationState,
  snapshot: CodingWorkbenchRuntimeSnapshot,
): boolean {
  const against = mutation.failedAgainst;
  if (mutation.status !== "error" || against === undefined || snapshot.runId === undefined) {
    return false;
  }
  return snapshot.runId !== against.runId || snapshot.revision > against.revision;
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
    stream: changedRun ? emptyResource() : streamForSnapshot(state, snapshot),
    ...(changedRun ? { events: [] } : {}),
    ...(snapshotSupersedesFailure(state.mutation, snapshot) ? { mutation: IDLE_MUTATION } : {}),
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
  "select-agent": (state, action): CodingWorkbenchRuntimeState => selectAgent(state, action.agent),
  "select-runtime-preference": (state, action): CodingWorkbenchRuntimeState =>
    selectPreference(state, action.preference),
  "select-model": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({
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
    projectReadiness(
      withOfferedAgent({
        ...state,
        runtime: ready(action.readiness),
        selectableAgents: action.readiness.selectableAgents,
        promptInputs: action.readiness.promptInputs ?? NO_CODING_WORKBENCH_PROMPT_INPUTS,
      }),
    ),
  "workspace-set": (state, action): CodingWorkbenchRuntimeState =>
    projectReadiness({
      ...state,
      workspace: action.workspace ? ready(action.workspace) : emptyResource("empty"),
    }),
  "run-set": (state, action): CodingWorkbenchRuntimeState => acceptSnapshot(state, action.snapshot),
  "stream-set": (state, action): CodingWorkbenchRuntimeState =>
    acceptStreamProjection(state, action.stream),
  "stream-reconnecting": (state): CodingWorkbenchRuntimeState => markStreamReconnecting(state),
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
      mutation: {
        ...state.mutation,
        status: "error",
        error: action.error,
        failedAgainst: {
          runId: state.run.value?.runId ?? null,
          revision: state.run.value?.revision ?? 0,
        },
      },
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
