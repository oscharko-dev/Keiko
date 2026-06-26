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
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { createLspTransport } from "./lspTransport.js";
import type { LspTransport } from "./lspTransport.js";
import { LspFrameRejectError } from "./lspFrameCodec.js";
import {
  LspProcessError,
  defaultLspSpawnFn,
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

export interface LspProcessManagerDeps {
  readonly config: LspProcessConfig;
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly commandRules: readonly CommandRule[];
  readonly spawn?: LspSpawnFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly onLifecycleEvent?: ((event: LspLifecycleEvent) => void) | undefined;
}

export interface LspProcessManager {
  getLspProcessStatus(): LspProcessStatus;
  asLanguageProvider(
    languages: readonly string[],
    operations: readonly LanguageServiceOperation[],
  ): LspManagerLanguageProvider;
  sendRequest<T>(method: string, params: unknown, signal: AbortSignal): Promise<T>;
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

function supervisorOnCrash(ctx: SupervisorContext, crashGeneration: number): void {
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
  if (ctx.state.disposed) {
    return;
  }
  ctx.transition("CRASHED", "CRASHED");
  if (ctx.throttle.recordCrashAndMayRestart(ctx.now())) {
    ctx.state.restartCount = ctx.throttle.restartCount();
    supervisorStart(ctx);
  } else {
    ctx.transition("RESTART_THROTTLED", "RESTART_THROTTLED");
  }
}

function supervisorStart(ctx: SupervisorContext): void {
  if (ctx.state.disposed) {
    return;
  }
  const env = preflightOrFail(ctx.deps, ctx.transition);
  if (env === undefined) {
    return;
  }
  const executable = resolveOrFail(ctx.deps, ctx.transition);
  if (executable === undefined) {
    return;
  }
  spawnAndInitialize(
    ctx.state,
    ctx.deps,
    ctx.spawn,
    ctx.now,
    ctx.transition,
    executable,
    env,
    (generation) => {
      supervisorOnCrash(ctx, generation);
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
  };
  const transition: Transition = (status, code) => {
    state.status = status;
    deps.onLifecycleEvent?.(buildLifecycleEvent(deps.config.managerId, state, now(), code));
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
    asLanguageProvider: (languages, operations): LspManagerLanguageProvider =>
      buildLanguageProvider(deps.config.managerId, languages, operations, () => state.status),
    sendRequest: <T>(method: string, params: unknown, signal: AbortSignal): Promise<T> =>
      sendRequest<T>(state, deps, now, method, params, signal),
    dispose: (): Promise<void> => disposeManager(state, deps, now, transition),
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
  env: Record<string, string>,
  onCrash: (generation: number) => void,
): void {
  // On a restart, reject any request still pending against the dead transport IMMEDIATELY instead of
  // letting it linger until requestTimeoutMs: dispose rejects pending with LspRpcDisposedError, which
  // maps to DISPOSED (FIX 3). The new generation guards stale callbacks from the superseded child.
  state.transport?.dispose();
  state.childGeneration += 1;
  const generation = state.childGeneration;
  state.exited = false;
  const child = trySpawn(spawn, executable, env, deps, transition);
  if (child === undefined) {
    return;
  }
  state.child = child;
  state.transport = createLspTransport(child, deps.config.maxFrameBytes, {
    onReaderError: () => {
      onCrash(generation);
    },
  });
  child.onExit(() => {
    onCrash(generation);
  });
  child.onError(() => {
    onCrash(generation);
  });
  transition("INITIALIZING");
  void runInitialize(state, deps, now, transition);
}

function preflightOrFail(
  deps: LspProcessManagerDeps,
  transition: Transition,
): Record<string, string> | undefined {
  try {
    return preflightSpawnEnv(
      deps.commandRules,
      deps.config.executableName,
      deps.config.executableArgs ?? [],
      deps.processEnv,
      deps.config.envAllowlist,
    );
  } catch {
    transition("EXECUTABLE_NOT_FOUND", "EXECUTABLE_NOT_FOUND");
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
  env: Record<string, string>,
  deps: LspProcessManagerDeps,
  transition: Transition,
): SpawnHandle | undefined {
  try {
    return spawn(executable, deps.config.executableArgs ?? [], env, deps.workspace.root);
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
    await client.request(
      "initialize",
      { capabilities: {}, networkPolicy },
      { deadlineMs: deps.config.initializeTimeoutMs, now },
    );
    if (state.status === "INITIALIZING") {
      transition("READY");
    }
  } catch (error) {
    if (state.status === "INITIALIZING") {
      transition("INITIALIZE_TIMEOUT", classifyInitFailure(error));
    }
  }
}

function classifyInitFailure(error: unknown): LspProcessErrorCode {
  return error instanceof LspRpcTimeoutError ? "INITIALIZE_TIMEOUT" : "INITIALIZE_FAILED";
}

async function sendRequest<T>(
  state: RuntimeState,
  deps: LspProcessManagerDeps,
  now: () => number,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<T> {
  if (state.disposed || state.status === "DISPOSED") {
    throw new LspProcessError("DISPOSED");
  }
  const client = state.transport?.client;
  if (client === undefined || state.status !== "READY") {
    throw new LspProcessError("CRASHED");
  }
  try {
    return await client.request<T>(method, params, {
      signal,
      deadlineMs: deps.config.requestTimeoutMs,
      now,
    });
  } catch (error) {
    throw mapRequestError(error);
  }
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
