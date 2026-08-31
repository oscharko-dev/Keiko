// Governed LSP process manager (Issue #1381, Epic #1491, ADR-0069 D2/D4/D5). A long-lived supervisor
// for one external language-server child over stdio JSON-RPC: it runs the deny-by-default preflight,
// spawns through the injected `LspSpawnFn`, drives the `initialize` handshake under a timeout, serves
// requests under a per-request deadline plus AbortSignal cancellation, restarts only after a
// requested termination has confirmed root exit and bounded-tree containment, and shuts the process
// down gracefully on dispose. Every state transition
// emits a content-free `LspLifecycleEvent` (ADR-0069 I4/D6); no source text, paths, or method names
// ever cross the audit boundary.

import type {
  LanguageServiceOperation,
  LspLifecycleEvent,
  LspNetworkPolicy,
  LspProcessConfig,
  LspProcessErrorCode,
  LspProcessStatus,
  ManagedLspProcessHealthSnapshot,
  ManagedLspNegotiatedCapabilitySnapshot,
  ManagedLspLanguage,
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { createLspTransport } from "./lspTransport.js";
import type { LspTransport } from "./lspTransport.js";
import { LspFrameRejectError } from "./lspFrameCodec.js";
import {
  LspProcessError,
  defaultLspSpawnFn,
  createApprovedExecutablePath,
  escalateKill,
  preflightSpawnEnv,
  resolveExecutableOutsideWorkspace,
} from "./lspNodeAdapter.js";
import type { LspProcessKillResult, LspSpawnFn, LspTreeContainment } from "./lspNodeAdapter.js";
import { createLspRestartThrottle } from "./lspRestartThrottle.js";
import type {
  LspRuntimeLeaseReason,
  LspRuntimeStateLoadResult,
  LspRuntimeStatePort,
} from "./lspRuntimeStateStore.js";
import {
  LspRpcCancelledError,
  LspRpcDisposedError,
  LspRpcTimeoutError,
} from "./lspJsonRpcClient.js";
import { buildLanguageProvider } from "./lspLanguageProvider.js";
import type { LspManagerLanguageProvider } from "./lspLanguageProvider.js";
import { createLspProtocolSession, type LspProtocolSession } from "./lspProtocolSession.js";
import type { LspSemanticTokenNegotiation } from "./lspSemanticTokens.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { processServerLogSink } from "../../process-log-sink.js";

export interface LspProcessProtocolConfig {
  readonly language: ManagedLspLanguage;
  readonly candidateOperations: readonly LanguageServiceOperation[];
  readonly semanticTokensCandidate: boolean;
  readonly configurationRevision: number;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly initializationOptions?: Readonly<Record<string, unknown>> | undefined;
  readonly resourceBudget?: LspRuntimeResourceBudget | undefined;
}

export interface LspRuntimeResourceBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxMemoryMb?: number | undefined;
  readonly indexDeadlineMs?: number | undefined;
}

export interface LspSpawnPreparationInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly privateRuntimeStateRoot?: string | undefined;
  readonly resourceBudget?: LspRuntimeResourceBudget | undefined;
}

export interface LspSpawnPreparation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  /** Governed, abortable prerequisite executed only after this generation owns its durable lease. */
  readonly beforeSpawn?: ((signal: AbortSignal) => Promise<void>) | undefined;
  readonly cleanup?: (() => void) | undefined;
  readonly resourceBudgetSatisfied?: (() => boolean) | undefined;
  readonly backgroundResourceBudgetSatisfied?: (() => boolean) | undefined;
}

export type LspSpawnPrepareFn = (input: LspSpawnPreparationInput) => LspSpawnPreparation;

export interface LspProcessManagerDeps {
  readonly config: LspProcessConfig;
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly fixedEnv?: Readonly<Record<string, string>> | undefined;
  readonly approvedDescendantExecutables?: readonly string[] | undefined;
  readonly commandRules: readonly CommandRule[];
  readonly spawn?: LspSpawnFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly onLifecycleEvent?: ((event: LspLifecycleEvent) => void) | undefined;
  readonly protocol?: LspProcessProtocolConfig | undefined;
  readonly prepareSpawn?: LspSpawnPrepareFn | undefined;
  /** Durable lease/throttle state; an active restored lease remains quarantined, never reconciled. */
  readonly runtimeState?: LspRuntimeStatePort | undefined;
}

export interface LspProcessManager {
  getLspProcessStatus(): LspProcessStatus;
  getChildGeneration(): number;
  // True once a terminal/termination path retains a generation whose immediate exit and bounded-
  // tree containment have not both been confirmed. Callers must not replace such a manager: the old
  // generation can still have live descendants even when its root process already emitted `exit`.
  hasRetainedProcessOwnership(): boolean;
  getNegotiatedCapabilities(): ManagedLspNegotiatedCapabilitySnapshot | undefined;
  getHealthSnapshot(): ManagedLspProcessHealthSnapshot | undefined;
  getSemanticTokenNegotiation(): LspSemanticTokenNegotiation | undefined;
  asLanguageProvider(
    languages: readonly string[],
    operations: readonly LanguageServiceOperation[],
  ): LspManagerLanguageProvider;
  sendRequest<T>(method: string, params: unknown, signal: AbortSignal): Promise<T>;
  sendNotification(method: string, params: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  dispose(): Promise<void>;
}

type SpawnHandle = ReturnType<LspSpawnFn>;
type Transition = (status: LspProcessStatus, code?: LspProcessErrorCode) => void;
type TreeContainmentState = "not-required" | LspTreeContainment;
type OwnershipRetentionReason =
  | "exit-unconfirmed"
  | "tree-unconfirmed"
  | "resource-cleanup-failed"
  | "durable-quarantine"
  | "runtime-state-unavailable";
type OwnershipSettlement = "released" | "retained" | "cleanup-failed";

interface CrashTransition {
  readonly status: "CRASHED" | "INITIALIZE_TIMEOUT";
  readonly code: LspProcessErrorCode;
}

const DEFAULT_CRASH_TRANSITION: CrashTransition = Object.freeze({
  status: "CRASHED",
  code: "CRASHED",
});

interface RuntimeState {
  status: LspProcessStatus;
  transport: LspTransport | undefined;
  child: SpawnHandle | undefined;
  exited: boolean;
  // A terminal path has requested process-tree termination. This is deliberately distinct from
  // `exited`: requesting SIGKILL is not OS confirmation, and ownership must survive until an exit
  // callback proves the handle is no longer live.
  terminationRequested: boolean;
  treeContainment: TreeContainmentState;
  restartPendingAfterExit: boolean;
  terminalTransitionRecorded: boolean;
  ownershipRetentionReason: OwnershipRetentionReason | undefined;
  restartCount: number;
  disposed: boolean;
  // Monotonic counter incremented per spawned child. Each crash callback captures the generation it
  // was registered for; a callback whose captured generation no longer matches belongs to a superseded
  // child (a late `exit`/`error` arriving after a restart) and is discarded (ADR-0069 D4 — no spurious
  // CRASHED transition or throttle debit on a stale child event).
  childGeneration: number;
  startAttempt: number;
  preSpawnAttempt: PreSpawnAttempt | undefined;
  protocol: LspProtocolSession | undefined;
  lastTransitionTimestampMs: number;
  requestCount: number;
  successCount: number;
  timeoutCount: number;
  cancellationCount: number;
  failureCount: number;
  latencyTotalMs: number;
  latencyMaximumMs: number;
  latencyBuckets: [number, number, number, number, number];
  spawnResourceCleanup: (() => void) | undefined;
  resourceBudgetSatisfied: (() => boolean) | undefined;
  backgroundResourceBudgetSatisfied: (() => boolean) | undefined;
  resourceBudgetTimer: ReturnType<typeof setInterval> | undefined;
  durableState: LspRuntimeStatePort | undefined;
  durableLeaseActive: boolean;
  durableLeaseOrphaned: boolean;
  durableStateUnavailable: boolean;
  crashTimestampsMs: number[];
}

interface PreSpawnAttempt {
  readonly attempt: number;
  readonly generation: number;
  readonly controller: AbortController;
  settled: Promise<void>;
}

interface ManagerRuntime {
  readonly state: RuntimeState;
  readonly now: () => number;
  readonly transition: Transition;
}

interface SupervisorContext {
  readonly deps: LspProcessManagerDeps;
  readonly state: RuntimeState;
  readonly now: () => number;
  readonly spawn: LspSpawnFn;
  readonly throttle: ReturnType<typeof createLspRestartThrottle>;
  readonly transition: Transition;
}

function supervisorOnCrash(
  ctx: SupervisorContext,
  crashGeneration: number,
  terminateProcess: boolean,
  crashTransition: CrashTransition = DEFAULT_CRASH_TRANSITION,
): void {
  // A late `exit`/`error` from a child already superseded by a restart carries a stale generation;
  // discard it so it cannot debit the throttle or re-enter CRASHED (FIX 4). The same-generation
  // error+exit pair coalesces because the first call advances `exited`/`childGeneration` so the second
  // is caught here (stale generation after a restart) or by the `exited` guard below (no restart).
  if (crashGeneration !== ctx.state.childGeneration || ctx.state.exited) {
    return;
  }
  if (terminateProcess) {
    requestCrashTermination(ctx, crashTransition);
    return;
  }
  handleObservedChildExit(ctx);
}

function handleObservedChildExit(ctx: SupervisorContext): void {
  // Marking the child exited BEFORE the disposed early-return lets `escalateKill`'s stop-predicate
  // (`() => state.exited`) observe a prompt exit during dispose and resolve without waiting the full
  // grace window (FIX 2).
  ctx.state.exited = true;
  // An observed exit closes the protocol channel for this generation immediately. Relying on
  // `beginSpawnGeneration()` to dispose it is insufficient: when the restart throttle is exhausted
  // there is no next generation, so pending requests and their deadline/abort handles would remain
  // owned by a transport whose child is already dead.
  ctx.state.transport?.dispose();
  if (ctx.state.restartPendingAfterExit) {
    if (ctx.state.terminalTransitionRecorded) restartConfirmedCrash(ctx);
    return;
  }
  if (ctx.state.disposed || ctx.state.terminationRequested) {
    if (ctx.state.terminalTransitionRecorded) {
      settlementReleased(settleChildOwnership(ctx.state), ctx.state, ctx.transition);
    }
    return;
  }
  handleUnsolicitedChildExit(ctx);
}

function handleUnsolicitedChildExit(ctx: SupervisorContext): void {
  // The immediate child is only the root of the bounded process tree. Its unsolicited exit cannot
  // prove that descendants are gone (a detached POSIX child or a Windows cmd.exe wrapper can leave
  // one behind), and signalling its raw pid after this observation risks hitting a recycled pid.
  // Retain the generation and suppress replacement unless containment had already been confirmed.
  stopResourceBudgetMonitor(ctx.state);
  const treeWasConfirmed = ctx.state.treeContainment === "confirmed";
  if (!treeWasConfirmed) markTreeContainmentUnconfirmed(ctx.state);
  ctx.transition("CRASHED", "CRASHED");
  ctx.state.terminalTransitionRecorded = true;
  if (!settlementReleased(settleChildOwnership(ctx.state), ctx.state, ctx.transition)) return;
  restartAfterCrash(ctx);
}

function restartAfterCrash(ctx: SupervisorContext): void {
  const nowMs = ctx.now();
  const restartAllowed = ctx.throttle.recordCrashAndMayRestart(nowMs);
  ctx.state.restartCount = ctx.throttle.restartCount();
  ctx.state.crashTimestampsMs = [...ctx.throttle.crashTimestamps(nowMs)];
  if (!persistDurableRuntime(ctx.state, nowMs, "released")) {
    retainChildOwnership(ctx.state, "runtime-state-unavailable");
    ctx.transition("CRASHED", "RUNTIME_STATE_CLEANUP_FAILED");
    return;
  }
  if (restartAllowed) supervisorStart(ctx);
  else ctx.transition("RESTART_THROTTLED", "RESTART_THROTTLED");
}

function requestCrashTermination(ctx: SupervisorContext, crashTransition: CrashTransition): void {
  if (ctx.state.terminationRequested) return;
  ctx.state.terminationRequested = true;
  ctx.state.restartPendingAfterExit = true;
  ctx.state.terminalTransitionRecorded = false;
  stopResourceBudgetMonitor(ctx.state);
  ctx.state.transport?.dispose();
  // Node's asynchronous ENOENT/EACCES spawn failure has no pid and does not promise a later `exit`
  // event. No OS process was acquired, so this is an observed not-spawned terminal state rather than
  // an unconfirmed kill; waiting for an exit here would retain the handle and suppress restart
  // forever. A post-spawn error has a pid and still follows the retained-until-exit path below.
  if (ctx.state.child?.pid === undefined) {
    ctx.state.exited = true;
    ctx.state.treeContainment = "confirmed";
  } else terminateProcessTree(ctx.state);
  ctx.transition(crashTransition.status, crashTransition.code);
  completeTerminalTermination(ctx.state, ctx.transition);
  if (ctx.state.exited) restartConfirmedCrash(ctx);
}

function restartConfirmedCrash(ctx: SupervisorContext): void {
  if (
    !ctx.state.restartPendingAfterExit ||
    !settlementReleased(settleChildOwnership(ctx.state), ctx.state, ctx.transition)
  ) {
    return;
  }
  ctx.state.restartPendingAfterExit = false;
  ctx.state.terminationRequested = false;
  ctx.state.terminalTransitionRecorded = false;
  restartAfterCrash(ctx);
}

function terminateProcessTree(state: RuntimeState): void {
  markTreeTerminationRequested(state);
  try {
    state.child?.kill("SIGKILL");
    recordTreeKillResult(state, state.child?.lastKillResult?.());
  } catch {
    // The process group may already be gone. Without a verified bounded-tree disposition the
    // generation remains owned and no replacement may start.
  }
}

function markTreeTerminationRequested(state: RuntimeState): void {
  markTreeContainmentUnconfirmed(state);
}

function markTreeContainmentUnconfirmed(state: RuntimeState): void {
  if (state.child !== undefined && state.treeContainment !== "confirmed") {
    state.treeContainment = "unconfirmed";
  }
}

function recordTreeKillResult(state: RuntimeState, result: LspProcessKillResult | undefined): void {
  if (result?.treeContainment === "confirmed") state.treeContainment = "confirmed";
}

function logChildOwnership(
  action:
    | "retained-unconfirmed"
    | "released-after-exit"
    | "durable-lease-acquired"
    | "durable-lease-released"
    | "durable-lease-restored"
    | "durable-state-unavailable",
  childPid: number | undefined,
  reason: OwnershipRetentionReason | LspRuntimeLeaseReason,
  generation?: number,
): void {
  processServerLogSink().write({
    category: "diagnostic",
    op: "lsp.process.ownership.changed",
    correlationId: UNKNOWN_CORRELATION_ID,
    extra: {
      action,
      reason,
      ...(generation === undefined ? {} : { generation }),
      ...(childPid === undefined ? {} : { childPid }),
    },
  });
}

function durableLeaseReason(reason: OwnershipRetentionReason): LspRuntimeLeaseReason {
  if (reason === "exit-unconfirmed") return "exit-unconfirmed";
  if (reason === "tree-unconfirmed") return "tree-unconfirmed";
  if (reason === "resource-cleanup-failed") return "resource-cleanup-failed";
  return "process-live";
}

function persistDurableRuntime(
  state: RuntimeState,
  nowMs: number,
  leaseState: "active" | "released",
  reason: LspRuntimeLeaseReason = "process-live",
): boolean {
  if (state.durableState === undefined) {
    state.durableLeaseActive = false;
    return true;
  }
  try {
    state.durableState.save({
      generation: state.childGeneration,
      leaseState,
      ...(leaseState === "active" ? { leaseReason: reason } : {}),
      crashTimestampsMs: state.crashTimestampsMs,
      restartCount: state.restartCount,
      updatedAtMs: nowMs,
    });
    state.durableLeaseActive = leaseState === "active";
    state.durableStateUnavailable = false;
    logChildOwnership(
      leaseState === "active" ? "durable-lease-acquired" : "durable-lease-released",
      undefined,
      leaseState === "active" ? reason : (state.ownershipRetentionReason ?? "process-live"),
      state.childGeneration,
    );
    return true;
  } catch {
    state.durableStateUnavailable = true;
    logChildOwnership(
      "durable-state-unavailable",
      undefined,
      "runtime-state-unavailable",
      state.childGeneration,
    );
    return false;
  }
}

function retainChildOwnership(state: RuntimeState, reason: OwnershipRetentionReason): void {
  if (state.ownershipRetentionReason === reason) return;
  logChildOwnership("retained-unconfirmed", state.child?.pid, reason);
  state.ownershipRetentionReason = reason;
  if (state.durableLeaseActive) {
    persistDurableRuntime(
      state,
      state.lastTransitionTimestampMs,
      "active",
      durableLeaseReason(reason),
    );
  }
}

function settleChildOwnership(state: RuntimeState): OwnershipSettlement {
  const retentionReason = childRetentionReason(state);
  if (retentionReason !== undefined) {
    retainChildOwnership(state, retentionReason);
    return "retained";
  }
  if (!cleanupSpawnResources(state)) {
    retainChildOwnership(state, "resource-cleanup-failed");
    return "cleanup-failed";
  }
  if (!persistDurableRuntime(state, state.lastTransitionTimestampMs, "released")) {
    retainChildOwnership(state, "runtime-state-unavailable");
    return "cleanup-failed";
  }
  const childPid = state.child?.pid;
  state.child = undefined;
  if (state.ownershipRetentionReason !== undefined) {
    logChildOwnership("released-after-exit", childPid, state.ownershipRetentionReason);
    state.ownershipRetentionReason = undefined;
  }
  return "released";
}

function settlementReleased(
  settlement: OwnershipSettlement,
  state: RuntimeState,
  transition: Transition,
  cleanupFailureStatus: LspProcessStatus = state.status,
): boolean {
  if (settlement === "cleanup-failed") {
    transition(cleanupFailureStatus, "RUNTIME_STATE_CLEANUP_FAILED");
  }
  return settlement === "released";
}

function childRetentionReason(state: RuntimeState): OwnershipRetentionReason | undefined {
  if (state.durableStateUnavailable) return "runtime-state-unavailable";
  if (state.durableLeaseOrphaned) return "durable-quarantine";
  if (state.child === undefined) return undefined;
  if (!state.exited) return "exit-unconfirmed";
  return state.treeContainment === "confirmed" ? undefined : "tree-unconfirmed";
}

function hasRetainedProcessOwnership(state: RuntimeState): boolean {
  if (state.ownershipRetentionReason !== undefined) return true;
  return (
    (state.disposed || state.terminationRequested) && childRetentionReason(state) !== undefined
  );
}

function beginTerminalTermination(state: RuntimeState): void {
  stopResourceBudgetMonitor(state);
  state.terminationRequested = true;
  state.restartPendingAfterExit = false;
  state.terminalTransitionRecorded = false;
}

function completeTerminalTermination(
  state: RuntimeState,
  transition: Transition,
  cleanupFailureStatus?: LspProcessStatus,
): boolean {
  state.terminalTransitionRecorded = true;
  return settlementReleased(settleChildOwnership(state), state, transition, cleanupFailureStatus);
}

function supervisorStart(ctx: SupervisorContext): void {
  if (ctx.state.disposed) return;
  const preflight = preflightOrFail(ctx.deps, ctx.transition);
  if (preflight === undefined) return;
  const executable = resolveOrFail(ctx.deps, ctx.transition);
  if (executable === undefined) {
    if (!safeCleanup(preflight.cleanup)) {
      ctx.transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    }
    return;
  }
  const prepared = prepareSpawnOrFail(ctx.deps, executable, preflight, ctx.transition);
  if (prepared === undefined) return;
  spawnAndInitialize({
    state: ctx.state,
    deps: ctx.deps,
    spawn: ctx.spawn,
    now: ctx.now,
    transition: ctx.transition,
    executable: prepared.executable,
    args: prepared.args,
    env: prepared.env,
    beforeSpawn: prepared.beforeSpawn,
    spawnResourceCleanup: prepared.cleanup,
    resourceBudgetSatisfied: prepared.resourceBudgetSatisfied,
    backgroundResourceBudgetSatisfied: prepared.backgroundResourceBudgetSatisfied,
    onCrash: (generation, terminateProcess, crashTransition) => {
      supervisorOnCrash(ctx, generation, terminateProcess, crashTransition);
    },
  });
}

function createManagerRuntime(deps: LspProcessManagerDeps): ManagerRuntime {
  const now = deps.now ?? Date.now;
  const loaded = loadDurableRuntimeState(deps.runtimeState);
  const state = initialRuntimeState(now(), deps.runtimeState, loaded);
  const transition: Transition = (status, code) => {
    state.status = status;
    state.lastTransitionTimestampMs = now();
    deps.onLifecycleEvent?.(
      buildLifecycleEvent(deps.config.managerId, state, state.lastTransitionTimestampMs, code),
    );
  };
  const throttle = createLspRestartThrottle(
    deps.config.restartWindowMs,
    deps.config.maxRestartsInWindow,
    {
      crashTimestampsMs: state.crashTimestampsMs,
      restartCount: state.restartCount,
    },
  );
  const ctx: SupervisorContext = {
    deps,
    state,
    now,
    spawn: deps.spawn ?? defaultLspSpawnFn,
    throttle,
    transition,
  };

  transition("STARTING");
  state.crashTimestampsMs = [...throttle.crashTimestamps(now())];
  if (state.durableStateUnavailable) {
    retainChildOwnership(state, "runtime-state-unavailable");
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
  } else if (state.durableLeaseOrphaned) {
    logChildOwnership(
      "durable-lease-restored",
      undefined,
      "durable-quarantine",
      state.childGeneration,
    );
    retainChildOwnership(state, "durable-quarantine");
    transition("CRASHED", "CRASHED");
  } else if (throttle.isThrottled(now())) {
    transition("RESTART_THROTTLED", "RESTART_THROTTLED");
  } else {
    supervisorStart(ctx);
  }
  return { state, now, transition };
}

function loadDurableRuntimeState(port: LspRuntimeStatePort | undefined): LspRuntimeStateLoadResult {
  if (port === undefined) return { state: "absent" };
  try {
    return port.load();
  } catch {
    return { state: "unavailable" };
  }
}

interface DurableInitialState {
  readonly ownershipRetentionReason: OwnershipRetentionReason | undefined;
  readonly restartCount: number;
  readonly childGeneration: number;
  readonly leaseActive: boolean;
  readonly stateUnavailable: boolean;
  readonly crashTimestampsMs: readonly number[];
}

function durableInitialState(loaded: LspRuntimeStateLoadResult): DurableInitialState {
  if (loaded.state === "unavailable") {
    return {
      ownershipRetentionReason: "runtime-state-unavailable",
      restartCount: 0,
      childGeneration: 0,
      leaseActive: false,
      stateUnavailable: true,
      crashTimestampsMs: [],
    };
  }
  if (loaded.state === "absent") {
    return {
      ownershipRetentionReason: undefined,
      restartCount: 0,
      childGeneration: 0,
      leaseActive: false,
      stateUnavailable: false,
      crashTimestampsMs: [],
    };
  }
  const active = loaded.snapshot.leaseState === "active";
  return {
    ownershipRetentionReason: active ? "durable-quarantine" : undefined,
    restartCount: loaded.snapshot.restartCount,
    childGeneration: loaded.snapshot.generation,
    leaseActive: active,
    stateUnavailable: false,
    crashTimestampsMs: loaded.snapshot.crashTimestampsMs,
  };
}

function initialRuntimeState(
  timestampMs: number,
  durableState: LspRuntimeStatePort | undefined,
  loaded: LspRuntimeStateLoadResult,
): RuntimeState {
  const durable = durableInitialState(loaded);
  return {
    status: "STARTING",
    transport: undefined,
    child: undefined,
    exited: false,
    terminationRequested: false,
    treeContainment: "not-required",
    restartPendingAfterExit: false,
    terminalTransitionRecorded: false,
    ownershipRetentionReason: durable.ownershipRetentionReason,
    restartCount: durable.restartCount,
    disposed: false,
    childGeneration: durable.childGeneration,
    startAttempt: 0,
    preSpawnAttempt: undefined,
    protocol: undefined,
    lastTransitionTimestampMs: timestampMs,
    requestCount: 0,
    successCount: 0,
    timeoutCount: 0,
    cancellationCount: 0,
    failureCount: 0,
    latencyTotalMs: 0,
    latencyMaximumMs: 0,
    latencyBuckets: [0, 0, 0, 0, 0],
    spawnResourceCleanup: undefined,
    resourceBudgetSatisfied: undefined,
    backgroundResourceBudgetSatisfied: undefined,
    resourceBudgetTimer: undefined,
    durableState,
    durableLeaseActive: durable.leaseActive,
    durableLeaseOrphaned: durable.leaseActive,
    durableStateUnavailable: durable.stateUnavailable,
    crashTimestampsMs: [...durable.crashTimestampsMs],
  };
}

export function createLspProcessManager(deps: LspProcessManagerDeps): LspProcessManager {
  const { state, now, transition } = createManagerRuntime(deps);

  return {
    getLspProcessStatus: (): LspProcessStatus => state.status,
    getChildGeneration: (): number => state.childGeneration,
    hasRetainedProcessOwnership: (): boolean => hasRetainedProcessOwnership(state),
    getNegotiatedCapabilities: (): ManagedLspNegotiatedCapabilitySnapshot | undefined =>
      state.protocol?.snapshot(),
    getHealthSnapshot: (): ManagedLspProcessHealthSnapshot | undefined =>
      buildHealthSnapshot(state, deps),
    getSemanticTokenNegotiation: (): LspSemanticTokenNegotiation | undefined =>
      state.protocol?.semanticTokenNegotiation(),
    asLanguageProvider: (languages, operations): LspManagerLanguageProvider =>
      buildLanguageProvider(deps.config.managerId, languages, operations, () => state.status),
    sendRequest: <T>(method: string, params: unknown, signal: AbortSignal): Promise<T> =>
      sendRequest<T>(state, deps, now, transition, method, params, signal),
    sendNotification: (method, params): void => {
      if (state.status === "READY") state.transport?.client.notify(method, params);
    },
    onNotification: (handler): (() => void) =>
      state.transport?.client.onNotification(handler) ?? ((): void => undefined),
    dispose: (): Promise<void> => disposeManager(state, deps, now, transition),
  };
}

function buildHealthSnapshot(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
): ManagedLspProcessHealthSnapshot | undefined {
  const protocol = deps.protocol;
  if (protocol === undefined) return undefined;
  const negotiated = state.protocol?.snapshot().negotiatedOperations ?? [];
  return {
    schemaVersion: "1",
    managerId: deps.config.managerId,
    language: protocol.language,
    status: state.status,
    restartCount: state.restartCount,
    configurationRevision: protocol.configurationRevision,
    negotiatedOperations: negotiated,
    lastTransitionTimestampMs: state.lastTransitionTimestampMs,
    pendingRequestCount: state.transport?.client.pendingCount() ?? 0,
    requestCount: state.requestCount,
    successCount: state.successCount,
    timeoutCount: state.timeoutCount,
    cancellationCount: state.cancellationCount,
    failureCount: state.failureCount,
    latency: {
      count: state.requestCount,
      totalMs: state.latencyTotalMs,
      maximumMs: state.latencyMaximumMs,
      lessThanOrEqual10Ms: state.latencyBuckets[0],
      lessThanOrEqual50Ms: state.latencyBuckets[1],
      lessThanOrEqual250Ms: state.latencyBuckets[2],
      lessThanOrEqual1Second: state.latencyBuckets[3],
      greaterThan1Second: state.latencyBuckets[4],
    },
  };
}

function buildLifecycleEvent(
  managerId: string,
  state: RuntimeState,
  timestampMs: number,
  errorCode: LspProcessErrorCode | undefined,
): LspLifecycleEvent {
  return {
    schemaVersion: "1",
    managerId,
    status: state.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    timestampMs,
    pendingRequestCount: state.transport?.client.pendingCount() ?? 0,
    restartCount: state.restartCount,
    stderrBytesSeen: state.transport?.stderrBytesSeen() ?? 0,
    // The join key toward the spawn adapter's per-kill activity line (see the contract comment on
    // LspLifecycleEvent.childPid): the transition carries the REASON, the adapter line carries the
    // signal and the verified tree-kill disposition, and childPid ties them together.
    ...(state.child?.pid !== undefined ? { childPid: state.child.pid } : {}),
  };
}

interface SpawnAndInitializeInput {
  readonly state: RuntimeState;
  readonly deps: LspProcessManagerDeps;
  readonly spawn: LspSpawnFn;
  readonly now: () => number;
  readonly transition: Transition;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly beforeSpawn: ((signal: AbortSignal) => Promise<void>) | undefined;
  readonly spawnResourceCleanup: (() => void) | undefined;
  readonly resourceBudgetSatisfied: (() => boolean) | undefined;
  readonly backgroundResourceBudgetSatisfied: (() => boolean) | undefined;
  readonly onCrash: (
    generation: number,
    terminateProcess: boolean,
    crashTransition?: CrashTransition,
  ) => void;
}

function spawnAndInitialize(input: SpawnAndInitializeInput): void {
  const generation = beginSpawnGeneration(
    input.state,
    input.spawnResourceCleanup,
    input.transition,
  );
  if (generation === undefined) return;
  input.state.startAttempt += 1;
  const attempt = input.state.startAttempt;
  if (input.beforeSpawn === undefined) {
    spawnPreparedGeneration(input, generation, attempt);
    return;
  }
  startBeforeSpawn(input, generation, attempt, input.beforeSpawn);
}

function spawnPreparedGeneration(
  input: SpawnAndInitializeInput,
  generation: number,
  attempt: number,
): void {
  const { state, deps, spawn, now, transition, executable, args, env, onCrash } = input;
  if (!maySpawnPreparedGeneration(state, generation, attempt)) return;
  const child = trySpawn(spawn, executable, args, env, deps, transition);
  if (child === undefined) {
    if (!cleanupSpawnResources(state)) retainChildOwnership(state, "resource-cleanup-failed");
    else if (!persistDurableRuntime(state, state.lastTransitionTimestampMs, "released")) {
      retainChildOwnership(state, "runtime-state-unavailable");
    }
    return;
  }
  installSpawnedChild({
    state,
    deps,
    child,
    generation,
    onCrash,
    transition,
    resourceBudgetSatisfied: input.resourceBudgetSatisfied,
    backgroundResourceBudgetSatisfied: input.backgroundResourceBudgetSatisfied,
  });
  child.onExit(() => {
    onCrash(generation, false);
  });
  child.onError(() => {
    onCrash(generation, true);
  });
  transition("INITIALIZING");
  void runInitialize(state, deps, now, transition, generation, onCrash);
}

function maySpawnPreparedGeneration(
  state: RuntimeState,
  generation: number,
  attempt: number,
): boolean {
  return (
    !state.disposed &&
    !state.terminationRequested &&
    state.childGeneration === generation &&
    state.startAttempt === attempt
  );
}

function startBeforeSpawn(
  input: SpawnAndInitializeInput,
  generation: number,
  attempt: number,
  beforeSpawn: (signal: AbortSignal) => Promise<void>,
): void {
  const record: PreSpawnAttempt = {
    attempt,
    generation,
    controller: new AbortController(),
    settled: Promise.resolve(),
  };
  input.state.preSpawnAttempt = record;
  record.settled = Promise.resolve()
    .then(() => beforeSpawn(record.controller.signal))
    .then(
      () => {
        completeBeforeSpawn(input, record);
      },
      () => {
        failBeforeSpawn(input, record);
      },
    )
    .finally(() => {
      if (input.state.preSpawnAttempt === record) input.state.preSpawnAttempt = undefined;
    });
}

function currentBeforeSpawn(state: RuntimeState, record: PreSpawnAttempt): boolean {
  return (
    state.preSpawnAttempt === record &&
    maySpawnPreparedGeneration(state, record.generation, record.attempt)
  );
}

function completeBeforeSpawn(input: SpawnAndInitializeInput, record: PreSpawnAttempt): void {
  if (!currentBeforeSpawn(input.state, record) || record.controller.signal.aborted) return;
  spawnPreparedGeneration(input, record.generation, record.attempt);
}

function failBeforeSpawn(input: SpawnAndInitializeInput, record: PreSpawnAttempt): void {
  const { state, transition } = input;
  if (!currentBeforeSpawn(state, record) || record.controller.signal.aborted) return;
  if (!cleanupSpawnResources(state)) {
    retainChildOwnership(state, "resource-cleanup-failed");
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    return;
  }
  if (!persistDurableRuntime(state, state.lastTransitionTimestampMs, "released")) {
    retainChildOwnership(state, "runtime-state-unavailable");
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    return;
  }
  transition("SPAWN_FAILED", "SPAWN_FAILED");
}

function beginSpawnGeneration(
  state: RuntimeState,
  nextCleanup: (() => void) | undefined,
  transition: Transition,
): number | undefined {
  // Reject old pending requests immediately; the new generation then guards stale callbacks.
  state.transport?.dispose();
  if (!cleanupSpawnResources(state)) {
    safeCleanup(nextCleanup);
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    return undefined;
  }
  state.childGeneration += 1;
  if (!persistDurableRuntime(state, state.lastTransitionTimestampMs, "active")) {
    safeCleanup(nextCleanup);
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    return undefined;
  }
  state.spawnResourceCleanup = nextCleanup;
  state.exited = false;
  state.terminationRequested = false;
  state.treeContainment = "not-required";
  state.restartPendingAfterExit = false;
  state.terminalTransitionRecorded = false;
  state.ownershipRetentionReason = undefined;
  state.durableLeaseOrphaned = false;
  return state.childGeneration;
}

interface SpawnInstallation {
  readonly state: RuntimeState;
  readonly deps: LspProcessManagerDeps;
  readonly child: SpawnHandle;
  readonly generation: number;
  readonly onCrash: (
    generation: number,
    terminateProcess: boolean,
    crashTransition?: CrashTransition,
  ) => void;
  readonly transition: Transition;
  readonly resourceBudgetSatisfied: (() => boolean) | undefined;
  readonly backgroundResourceBudgetSatisfied: (() => boolean) | undefined;
}

function installSpawnedChild(input: SpawnInstallation): void {
  const { state, deps } = input;
  state.spawnResourceCleanup = combineCleanup(
    state.spawnResourceCleanup,
    runtimeResourceCleanup(input.child),
  );
  state.resourceBudgetSatisfied = input.resourceBudgetSatisfied;
  state.backgroundResourceBudgetSatisfied = input.backgroundResourceBudgetSatisfied;
  startResourceBudgetMonitor(state, input.transition);
  state.child = input.child;
  if (input.child.treeLifetimeBoundary === "os-owned") state.treeContainment = "confirmed";
  state.transport = createLspTransport(input.child, deps.config.maxFrameBytes, {
    onReaderError: () => {
      input.onCrash(input.generation, true);
    },
  });
  state.protocol = createProtocolSession(deps);
  if (state.protocol === undefined) return;
  state.transport.client.onRequest((method, params) =>
    state.protocol?.handleServerRequest(method, params),
  );
  state.transport.client.onNotification((method, params) => {
    state.protocol?.handleServerNotification(method, params);
  });
}

function runtimeResourceCleanup(child: SpawnHandle): (() => void) | undefined {
  if (child.releaseRuntimeResources === undefined) return undefined;
  return (): void => {
    child.releaseRuntimeResources?.();
  };
}

function preflightOrFail(
  deps: LspProcessManagerDeps,
  transition: Transition,
): { readonly env: Record<string, string>; readonly cleanup?: () => void } | undefined {
  try {
    const env = {
      ...preflightSpawnEnv(
        deps.commandRules,
        deps.config.executableName,
        deps.config.executableArgs ?? [],
        deps.processEnv,
        deps.config.envAllowlist,
      ),
      ...deps.fixedEnv,
    };
    const names = deps.approvedDescendantExecutables ?? [];
    if (names.length === 0) return { env };
    const approvedPath = createApprovedExecutablePath(
      names,
      deps.commandRules,
      deps.workspace,
      deps.processEnv,
    );
    return {
      env: { ...env, PATH: approvedPath.path },
      cleanup: (): void => {
        approvedPath.cleanup();
      },
    };
  } catch {
    transition("EXECUTABLE_NOT_FOUND", "EXECUTABLE_NOT_FOUND");
    return undefined;
  }
}

function stopResourceBudgetMonitor(state: RuntimeState): void {
  if (state.resourceBudgetTimer !== undefined) clearInterval(state.resourceBudgetTimer);
  state.resourceBudgetTimer = undefined;
}

function cleanupSpawnResources(state: RuntimeState): boolean {
  stopResourceBudgetMonitor(state);
  if (!safeCleanup(state.spawnResourceCleanup)) return false;
  state.spawnResourceCleanup = undefined;
  state.resourceBudgetSatisfied = undefined;
  state.backgroundResourceBudgetSatisfied = undefined;
  return true;
}

function safeCleanup(cleanup: (() => void) | undefined): boolean {
  try {
    cleanup?.();
    return true;
  } catch {
    return false;
  }
}

function startResourceBudgetMonitor(state: RuntimeState, transition: Transition): void {
  if (state.resourceBudgetSatisfied === undefined) return;
  state.resourceBudgetTimer = setInterval(() => {
    if (!backgroundResourceBudgetSatisfied(state)) failResourceBudget(state, transition);
  }, 2_000);
  state.resourceBudgetTimer.unref();
}

function backgroundResourceBudgetSatisfied(state: RuntimeState): boolean {
  try {
    return state.backgroundResourceBudgetSatisfied?.() ?? resourceBudgetSatisfied(state);
  } catch {
    return false;
  }
}

function combineCleanup(
  first: (() => void) | undefined,
  second: (() => void) | undefined,
): (() => void) | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  let firstPending: (() => void) | undefined = first;
  let secondPending: (() => void) | undefined = second;
  return (): void => {
    if (safeCleanup(secondPending)) secondPending = undefined;
    if (safeCleanup(firstPending)) firstPending = undefined;
    if (secondPending !== undefined || firstPending !== undefined) {
      throw new Error("LSP resource cleanup failed");
    }
  };
}

function prepareSpawnOrFail(
  deps: LspProcessManagerDeps,
  executable: string,
  preflight: { readonly env: Record<string, string>; readonly cleanup?: () => void },
  transition: Transition,
): LspSpawnPreparation | undefined {
  try {
    const prepared = deps.prepareSpawn?.({
      executable,
      args: deps.config.executableArgs ?? [],
      env: preflight.env,
      workspace: deps.workspace,
      processEnv: deps.processEnv,
      resourceBudget: deps.protocol?.resourceBudget,
    }) ?? {
      executable,
      args: deps.config.executableArgs ?? [],
      env: preflight.env,
    };
    return { ...prepared, cleanup: combineCleanup(preflight.cleanup, prepared.cleanup) };
  } catch {
    const cleanupSucceeded = safeCleanup(preflight.cleanup);
    transition("SPAWN_FAILED", cleanupSucceeded ? "SPAWN_FAILED" : "RUNTIME_STATE_CLEANUP_FAILED");
    return undefined;
  }
}

function resolveOrFail(deps: LspProcessManagerDeps, transition: Transition): string | undefined {
  try {
    return resolveExecutableOutsideWorkspace(
      deps.config.executableName,
      deps.workspace,
      deps.processEnv,
    );
  } catch {
    transition("EXECUTABLE_NOT_FOUND", "EXECUTABLE_NOT_FOUND");
    return undefined;
  }
}

function trySpawn(
  spawn: LspSpawnFn,
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  deps: LspProcessManagerDeps,
  transition: Transition,
): SpawnHandle | undefined {
  try {
    return spawn(executable, args, env, deps.workspace.root);
  } catch {
    transition("SPAWN_FAILED", "SPAWN_FAILED");
    return undefined;
  }
}

async function runInitialize(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  now: () => number,
  transition: Transition,
  generation: number,
  onCrash: SpawnAndInitializeInput["onCrash"],
): Promise<void> {
  const client = state.transport?.client;
  if (client === undefined) {
    return;
  }
  const networkPolicy: LspNetworkPolicy = deps.config.networkPolicy ?? "inherit";
  try {
    const result = await client.request<unknown>(
      "initialize",
      initializeParams(state, networkPolicy),
      {
        deadlineMs: deps.config.initializeTimeoutMs,
        now,
      },
    );
    if (isCurrentInitialization(state, generation)) {
      if (resourceBudgetSatisfied(state)) {
        completeInitialization(state, deps, client, result, transition);
      } else {
        failResourceBudget(state, transition);
      }
    }
  } catch (error) {
    if (isCurrentInitialization(state, generation)) {
      onCrash(generation, true, {
        status: "INITIALIZE_TIMEOUT",
        code: classifyInitFailure(error),
      });
    }
  }
}

// A crash DURING initialize disposes the transport, which rejects THIS call's pending request — but
// the rejection settles on a later microtask, by which point a restart may already have spawned and
// begun initializing the NEXT generation (`state.status` reads "INITIALIZING" again, just not for this
// call). Acting on status alone let a stale initialize outcome act on whatever child is current when it
// finally runs, not the one it was started for — deterministically killing a healthy restart mid
// handshake and stranding the manager. `state.childGeneration` is the same generation concept the
// crash/escalation path already tracks (FIX 4); guarding on it too makes a superseded call a no-op,
// symmetrically for both the success and the failure branch.
function isCurrentInitialization(state: RuntimeState, generation: number): boolean {
  return state.status === "INITIALIZING" && state.childGeneration === generation;
}

function initializeParams(state: RuntimeState, networkPolicy: LspNetworkPolicy): unknown {
  return state.protocol === undefined
    ? { capabilities: {}, networkPolicy }
    : state.protocol.initializeParams();
}

function completeInitialization(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  client: LspTransport["client"],
  result: unknown,
  transition: Transition,
): void {
  state.protocol?.acceptInitializeResult(result);
  client.notify("initialized", {});
  client.notify("workspace/didChangeConfiguration", {
    settings: deps.protocol?.configuration ?? {},
  });
  transition("READY");
}

function createProtocolSession(deps: LspProcessManagerDeps): LspProtocolSession | undefined {
  const protocol = deps.protocol;
  if (protocol === undefined) return undefined;
  return createLspProtocolSession({
    ...protocol,
    processId: process.pid,
    workspaceRoot: deps.workspace.root,
  });
}

function classifyInitFailure(error: unknown): LspProcessErrorCode {
  return error instanceof LspRpcTimeoutError ? "INITIALIZE_TIMEOUT" : "INITIALIZE_FAILED";
}

async function sendRequest<T>(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  now: () => number,
  transition: Transition,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<T> {
  if (state.disposed || state.status === "DISPOSED") {
    throw new LspProcessError("DISPOSED");
  }
  if (!resourceBudgetSatisfied(state)) {
    failResourceBudget(state, transition);
    throw new LspProcessError("RESOURCE_BUDGET_EXCEEDED");
  }
  const client = state.transport?.client;
  if (client === undefined || state.status !== "READY") {
    throw new LspProcessError("CRASHED");
  }
  const startedAt = now();
  state.requestCount += 1;
  try {
    const result = await client.request<T>(method, params, {
      signal,
      deadlineMs: deps.config.requestTimeoutMs,
      now,
    });
    if (!resourceBudgetSatisfied(state)) {
      failResourceBudget(state, transition);
      throw new LspProcessError("RESOURCE_BUDGET_EXCEEDED");
    }
    state.successCount += 1;
    recordLatency(state, Math.max(0, now() - startedAt));
    return result;
  } catch (error) {
    const mapped = mapRequestError(error);
    recordRequestFailure(state, mapped);
    recordLatency(state, Math.max(0, now() - startedAt));
    throw mapped;
  }
}

function resourceBudgetSatisfied(state: RuntimeState): boolean {
  try {
    return state.resourceBudgetSatisfied?.() ?? true;
  } catch {
    return false;
  }
}

function failResourceBudget(state: RuntimeState, transition: Transition): void {
  if (state.exited || state.status === "CRASHED") return;
  beginTerminalTermination(state);
  state.transport?.dispose();
  terminateProcessTree(state);
  transition("CRASHED", "RESOURCE_BUDGET_EXCEEDED");
  completeTerminalTermination(state, transition);
}

function recordRequestFailure(state: RuntimeState, error: LspProcessError): void {
  if (error.code === "REQUEST_TIMED_OUT") state.timeoutCount += 1;
  else if (error.code === "CANCELLED") state.cancellationCount += 1;
  else state.failureCount += 1;
}

function recordLatency(state: RuntimeState, durationMs: number): void {
  state.latencyTotalMs += durationMs;
  state.latencyMaximumMs = Math.max(state.latencyMaximumMs, durationMs);
  state.latencyBuckets[latencyBucketIndex(durationMs)] += 1;
}

function latencyBucketIndex(durationMs: number): 0 | 1 | 2 | 3 | 4 {
  if (durationMs <= 10) return 0;
  if (durationMs <= 50) return 1;
  if (durationMs <= 250) return 2;
  if (durationMs <= 1_000) return 3;
  return 4;
}

function mapRequestError(error: unknown): LspProcessError {
  if (error instanceof LspProcessError) {
    return error;
  }
  if (error instanceof LspRpcTimeoutError) {
    return new LspProcessError("REQUEST_TIMED_OUT");
  }
  if (error instanceof LspRpcCancelledError) {
    return new LspProcessError("CANCELLED");
  }
  if (error instanceof LspRpcDisposedError) {
    return new LspProcessError("DISPOSED");
  }
  // RESPONSE_TOO_LARGE is reserved for an ACTUAL frame-size rejection, never a generic RPC failure
  // (FIX 9). A frame reject for an oversized body keeps that code; any other frame reject (malformed
  // header) poisons the channel and surfaces as CRASHED. A plain server-side RPC error (the
  // `new Error("LSP error")` raised in `settleResponse`) is a transport/protocol fault for that
  // request, mapped to CRASHED — honest and content-free, never echoing the server's message text.
  if (error instanceof LspFrameRejectError) {
    return new LspProcessError(
      error.reason === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : "CRASHED",
    );
  }
  return new LspProcessError("CRASHED");
}

async function disposeManager(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  now: () => number,
  transition: Transition,
): Promise<void> {
  if (state.disposed) {
    await cancelAndWaitForBeforeSpawn(state);
    settlementReleased(settleChildOwnership(state), state, transition);
    return;
  }
  state.disposed = true;
  beginTerminalTermination(state);
  transition("SHUTDOWN");
  await cancelAndWaitForBeforeSpawn(state);
  const shutdownGeneration = state.childGeneration;
  const transport = state.transport;
  await requestGracefulShutdown(transport, deps, now);
  const child =
    !state.exited && state.childGeneration === shutdownGeneration ? state.child : undefined;
  transport?.client.notify("exit", null);
  if (child !== undefined) {
    markTreeTerminationRequested(state);
    if (child.treeLifetimeBoundary === "os-owned") {
      const killResult = await escalateKill(
        child,
        deps.config.shutdownTimeoutMs,
        () => state.exited,
        undefined,
        (onExit) => {
          child.onExit(onExit);
        },
      );
      recordTreeKillResult(state, killResult);
    } else {
      // A protocol-level `exit` only speaks for the immediate process. Force the already-bounded
      // process group/tree while its handle is still live so cleanup never relies on
      // `treeContainment: not-required` and never signals a possibly recycled pid later.
      terminateProcessTree(state);
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  transport?.dispose();
  // A kill request is not exit confirmation. Keep the handle as a background reaper while exit is
  // unconfirmed; a failed tree kill also remains retained fail-closed. DISPOSED deliberately keeps
  // childPid in either unconfirmed case.
  completeTerminalTermination(state, transition, "CRASHED");
  transition("DISPOSED", "DISPOSED");
}

async function cancelAndWaitForBeforeSpawn(state: RuntimeState): Promise<void> {
  const pending = state.preSpawnAttempt;
  if (pending === undefined) return;
  pending.controller.abort();
  await pending.settled;
}

async function requestGracefulShutdown(
  transport: LspTransport | undefined,
  deps: LspProcessManagerDeps,
  now: () => number,
): Promise<void> {
  const client = transport?.client;
  if (client === undefined) {
    return;
  }
  try {
    await client.request("shutdown", null, { deadlineMs: deps.config.shutdownTimeoutMs, now });
  } catch {
    // A server that never answers shutdown is forced down by the verified tree-reap path above.
  }
}
