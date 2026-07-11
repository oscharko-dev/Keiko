// Governed LSP process manager (Issue #1381, Epic #1491, ADR-0069 D2/D4/D5). A long-lived supervisor
// for one external language-server child over stdio JSON-RPC: it runs the deny-by-default preflight,
// spawns through the injected `LspSpawnFn`, drives the `initialize` handshake under a timeout, serves
// requests under a per-request deadline plus AbortSignal cancellation, restarts on crash within a
// rolling throttle window, and shuts the process down gracefully on dispose. Every state transition
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
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createLspRestartThrottle } from "./lspRestartThrottle.js";
import {
  LspRpcCancelledError,
  LspRpcDisposedError,
  LspRpcTimeoutError,
} from "./lspJsonRpcClient.js";
import { buildLanguageProvider } from "./lspLanguageProvider.js";
import type { LspManagerLanguageProvider } from "./lspLanguageProvider.js";
import { createLspProtocolSession, type LspProtocolSession } from "./lspProtocolSession.js";
import type { LspSemanticTokenNegotiation } from "./lspSemanticTokens.js";

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
  readonly resourceBudget?: LspRuntimeResourceBudget | undefined;
}

export interface LspSpawnPreparation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
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
}

export interface LspProcessManager {
  getLspProcessStatus(): LspProcessStatus;
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

interface RuntimeState {
  status: LspProcessStatus;
  transport: LspTransport | undefined;
  child: SpawnHandle | undefined;
  exited: boolean;
  restartCount: number;
  disposed: boolean;
  // Monotonic counter incremented per spawned child. Each crash callback captures the generation it
  // was registered for; a callback whose captured generation no longer matches belongs to a superseded
  // child (a late `exit`/`error` arriving after a restart) and is discarded (ADR-0069 D4 — no spurious
  // CRASHED transition or throttle debit on a stale child event).
  childGeneration: number;
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
): void {
  // A late `exit`/`error` from a child already superseded by a restart carries a stale generation;
  // discard it so it cannot debit the throttle or re-enter CRASHED (FIX 4). The same-generation
  // error+exit pair coalesces because the first call advances `exited`/`childGeneration` so the second
  // is caught here (stale generation after a restart) or by the `exited` guard below (no restart).
  if (crashGeneration !== ctx.state.childGeneration || ctx.state.exited) {
    return;
  }
  // Marking the child exited BEFORE the disposed early-return lets `escalateKill`'s stop-predicate
  // (`() => state.exited`) observe a prompt exit during dispose and resolve without waiting the full
  // grace window (FIX 2).
  ctx.state.exited = true;
  if (terminateProcess) terminateProcessTree(ctx.state);
  const cleanupSucceeded = cleanupSpawnResources(ctx.state);
  if (ctx.state.disposed) {
    return;
  }
  ctx.transition("CRASHED", cleanupSucceeded ? "CRASHED" : "RUNTIME_STATE_CLEANUP_FAILED");
  if (ctx.throttle.recordCrashAndMayRestart(ctx.now())) {
    ctx.state.restartCount = ctx.throttle.restartCount();
    supervisorStart(ctx);
  } else {
    ctx.transition("RESTART_THROTTLED", "RESTART_THROTTLED");
  }
}

function terminateProcessTree(state: RuntimeState): void {
  try {
    state.child?.kill("SIGKILL");
  } catch {
    // The process group may already be gone; the state remains failed closed and is superseded.
  }
}

function supervisorStart(ctx: SupervisorContext): void {
  if (ctx.state.disposed) {
    return;
  }
  const preflight = preflightOrFail(ctx.deps, ctx.transition);
  if (preflight === undefined) {
    return;
  }
  const executable = resolveOrFail(ctx.deps, ctx.transition);
  if (executable === undefined) {
    if (!safeCleanup(preflight.cleanup)) {
      ctx.transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    }
    return;
  }
  const prepared = prepareSpawnOrFail(ctx.deps, executable, preflight, ctx.transition);
  if (prepared === undefined) return;
  spawnAndInitialize(
    ctx.state,
    ctx.deps,
    ctx.spawn,
    ctx.now,
    ctx.transition,
    prepared.executable,
    prepared.args,
    prepared.env,
    prepared.cleanup,
    prepared.resourceBudgetSatisfied,
    prepared.backgroundResourceBudgetSatisfied,
    (generation, terminateProcess) => {
      supervisorOnCrash(ctx, generation, terminateProcess);
    },
  );
}

function createManagerRuntime(deps: LspProcessManagerDeps): ManagerRuntime {
  const now = deps.now ?? Date.now;
  const state: RuntimeState = {
    status: "STARTING",
    transport: undefined,
    child: undefined,
    exited: false,
    restartCount: 0,
    disposed: false,
    childGeneration: 0,
    protocol: undefined,
    lastTransitionTimestampMs: now(),
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
  };
  const transition: Transition = (status, code) => {
    state.status = status;
    state.lastTransitionTimestampMs = now();
    deps.onLifecycleEvent?.(
      buildLifecycleEvent(deps.config.managerId, state, state.lastTransitionTimestampMs, code),
    );
  };
  const ctx: SupervisorContext = {
    deps,
    state,
    now,
    spawn: deps.spawn ?? defaultLspSpawnFn,
    throttle: createLspRestartThrottle(
      deps.config.restartWindowMs,
      deps.config.maxRestartsInWindow,
    ),
    transition,
  };

  transition("STARTING");
  supervisorStart(ctx);
  return { state, now, transition };
}

export function createLspProcessManager(deps: LspProcessManagerDeps): LspProcessManager {
  const { state, now, transition } = createManagerRuntime(deps);

  return {
    getLspProcessStatus: (): LspProcessStatus => state.status,
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
  };
}

function spawnAndInitialize(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  spawn: LspSpawnFn,
  now: () => number,
  transition: Transition,
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  spawnResourceCleanup: (() => void) | undefined,
  resourceBudgetSatisfied: (() => boolean) | undefined,
  backgroundResourceBudgetSatisfied: (() => boolean) | undefined,
  onCrash: (generation: number, terminateProcess: boolean) => void,
): void {
  // On a restart, reject any request still pending against the dead transport IMMEDIATELY instead of
  // letting it linger until requestTimeoutMs: dispose rejects pending with LspRpcDisposedError, which
  // maps to DISPOSED (FIX 3). The new generation guards stale callbacks from the superseded child.
  state.transport?.dispose();
  if (!cleanupSpawnResources(state)) {
    safeCleanup(spawnResourceCleanup);
    transition("SPAWN_FAILED", "RUNTIME_STATE_CLEANUP_FAILED");
    return;
  }
  state.childGeneration += 1;
  const generation = state.childGeneration;
  state.exited = false;
  const child = trySpawn(spawn, executable, args, env, deps, transition);
  if (child === undefined) {
    safeCleanup(spawnResourceCleanup);
    return;
  }
  installSpawnedChild({
    state,
    deps,
    child,
    generation,
    onCrash,
    transition,
    spawnResourceCleanup,
    resourceBudgetSatisfied,
    backgroundResourceBudgetSatisfied,
  });
  child.onExit(() => {
    onCrash(generation, false);
  });
  child.onError(() => {
    onCrash(generation, true);
  });
  transition("INITIALIZING");
  void runInitialize(state, deps, now, transition);
}

interface SpawnInstallation {
  readonly state: RuntimeState;
  readonly deps: LspProcessManagerDeps;
  readonly child: SpawnHandle;
  readonly generation: number;
  readonly onCrash: (generation: number, terminateProcess: boolean) => void;
  readonly transition: Transition;
  readonly spawnResourceCleanup: (() => void) | undefined;
  readonly resourceBudgetSatisfied: (() => boolean) | undefined;
  readonly backgroundResourceBudgetSatisfied: (() => boolean) | undefined;
}

function installSpawnedChild(input: SpawnInstallation): void {
  const { state, deps } = input;
  state.spawnResourceCleanup = input.spawnResourceCleanup;
  state.resourceBudgetSatisfied = input.resourceBudgetSatisfied;
  state.backgroundResourceBudgetSatisfied = input.backgroundResourceBudgetSatisfied;
  startResourceBudgetMonitor(state, input.transition);
  state.child = input.child;
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

function cleanupSpawnResources(state: RuntimeState): boolean {
  if (state.resourceBudgetTimer !== undefined) clearInterval(state.resourceBudgetTimer);
  state.resourceBudgetTimer = undefined;
  const succeeded = safeCleanup(state.spawnResourceCleanup);
  state.spawnResourceCleanup = undefined;
  state.resourceBudgetSatisfied = undefined;
  state.backgroundResourceBudgetSatisfied = undefined;
  return succeeded;
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
  return (): void => {
    const secondSucceeded = safeCleanup(second);
    const firstSucceeded = safeCleanup(first);
    if (!secondSucceeded || !firstSucceeded) throw new Error("LSP resource cleanup failed");
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
    if (state.status === "INITIALIZING") {
      if (resourceBudgetSatisfied(state)) {
        completeInitialization(state, deps, client, result, transition);
      } else {
        failResourceBudget(state, transition);
      }
    }
  } catch (error) {
    if (state.status === "INITIALIZING") {
      failInitialization(state, transition, classifyInitFailure(error));
    }
  }
}

function failInitialization(
  state: RuntimeState,
  transition: Transition,
  code: LspProcessErrorCode,
): void {
  state.transport?.dispose();
  terminateProcessTree(state);
  const cleanupSucceeded = cleanupSpawnResources(state);
  transition("INITIALIZE_TIMEOUT", cleanupSucceeded ? code : "RUNTIME_STATE_CLEANUP_FAILED");
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
  state.exited = true;
  state.transport?.dispose();
  terminateProcessTree(state);
  const cleanupSucceeded = cleanupSpawnResources(state);
  transition("CRASHED", "RESOURCE_BUDGET_EXCEEDED");
  if (!cleanupSucceeded) transition("CRASHED", "RUNTIME_STATE_CLEANUP_FAILED");
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
    return;
  }
  state.disposed = true;
  transition("SHUTDOWN");
  const child = state.child;
  const transport = state.transport;
  await requestGracefulShutdown(transport, deps, now);
  transport?.dispose();
  if (child !== undefined) {
    await escalateKill(
      child,
      deps.config.shutdownTimeoutMs,
      () => state.exited,
      undefined,
      (onExit) => {
        child.onExit(onExit);
      },
    );
  }
  const cleanupSucceeded = cleanupSpawnResources(state);
  if (!cleanupSucceeded) transition("CRASHED", "RUNTIME_STATE_CLEANUP_FAILED");
  transition("DISPOSED", "DISPOSED");
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
    // A server that never answers shutdown is forced down by escalateKill (ADR-0069 D4).
  }
  client.notify("exit", null);
}
