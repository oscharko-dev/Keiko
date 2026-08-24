import type { CodexRuntimeControl } from "./codexRuntimeComposition.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import type { CodingRuntimeManager, CodingRuntimeStartResult } from "./codingRuntimeManager.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import type {
  CodingRuntimeTaskDispatchResult,
  CodingRuntimeTaskDispatchRequest,
  CodingRuntimeTaskDispatcher,
  CodingRuntimeTaskOutcome,
  CodingRuntimeRunOperation,
} from "./productionCodingRuntimeHost.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";

const CODEX_CONTROL_TIMEOUT_MS = 30_000;
const CODEX_TERMINAL_POLL_MS = 25;

export interface ProductionRuntimeTurnPort {
  readonly submitTurn: (runId: string, text: string) => Promise<boolean>;
  readonly abortTurn: (runId: string) => Promise<boolean>;
  readonly waitForTerminal: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<CodingRuntimeTaskOutcome>;
}

export interface ProductionRuntimeRunRecord {
  readonly manager?: CodingRuntimeManager | undefined;
  readonly turnPort: ProductionRuntimeTurnPort;
  readonly controller: AbortController;
  readonly operationGuard: ProductionRuntimeOperationGuard;
  readonly waitForPendingMutations?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface ProductionRuntimeOperationGuard {
  readonly reserve: (
    request: CodingRuntimeRunOperation,
    mode?: "mutation" | "read",
  ) => ProductionRuntimeOperationReservation | undefined;
}

export interface ProductionRuntimeOperationReservation {
  /** Commits replay identity only after the productive adapter accepted the operation. */
  readonly commit: () => boolean;
  /** Releases a failed/non-productive attempt so the unchanged revision can be retried. */
  readonly release: () => void;
}

export function createProductionRuntimeOperationGuard(
  runId: string,
  live: () => boolean,
): ProductionRuntimeOperationGuard {
  const usedRequestIds = new Set<string>();
  let lastRevision = -1;
  let pending:
    { readonly requestId: string; readonly expectedRevision: number; active: boolean } | undefined;
  return {
    reserve: (request, mode = "mutation"): ProductionRuntimeOperationReservation | undefined => {
      if (
        inadmissibleOperation(request, runId, lastRevision) ||
        usedRequestIds.has(request.requestId) ||
        pending !== undefined
      ) {
        return undefined;
      }
      try {
        if (!live()) return undefined;
      } catch {
        return undefined;
      }
      const reservation = {
        requestId: request.requestId,
        expectedRevision: request.expectedRevision,
        active: true,
      };
      pending = reservation;
      const release = (): void => {
        if (!reservation.active) return;
        reservation.active = false;
        if (pending === reservation) pending = undefined;
      };
      return {
        commit: (): boolean => {
          if (!reservation.active || pending !== reservation) return false;
          usedRequestIds.add(reservation.requestId);
          // A read (question listing) never consumes the one-turn-per-revision slot: it must stay
          // repeatable at an unchanged revision, or background question refreshes would exhaust
          // the revision and race concurrent operator mutations into conflicts. Replay identity
          // (one-use request id) still applies, and anything older than a consumed revision stays
          // rejected above.
          if (mode === "mutation") lastRevision = reservation.expectedRevision;
          release();
          return true;
        },
        release,
      };
    },
  };
}

function inadmissibleOperation(
  request: CodingRuntimeRunOperation,
  runId: string,
  lastRevision: number,
): boolean {
  return (
    request.runId !== runId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    request.expectedRevision <= lastRevision
  );
}

interface ProductionRuntimeManagerContext {
  readonly slot: ProductionRuntimeSlot;
  readonly authority: CodingRuntimeAuthorityService;
  readonly now: () => Date;
  lastResult:
    | {
        readonly runId: string;
        readonly result: NonNullable<ReturnType<CodingRuntimeManager["result"]>>;
      }
    | undefined;
}

export function createProductionRuntimeManager(
  runs: Map<string, ProductionRuntimeRunRecord>,
  authority: CodingRuntimeAuthorityService,
  now: () => Date = () => new Date(),
): CodingRuntimeManager {
  const context: ProductionRuntimeManagerContext = {
    slot: createProductionRuntimeSlot(runs),
    authority,
    now,
    lastResult: undefined,
  };
  return buildProductionRuntimeManager(runs, context);
}

function buildProductionRuntimeManager(
  runs: Map<string, ProductionRuntimeRunRecord>,
  context: ProductionRuntimeManagerContext,
): CodingRuntimeManager {
  return {
    start: (request) => startProductionRuntime(runs, context, request),
    issueApproval: (request) =>
      context.slot.manager()?.issueApproval(request) ?? stoppedApprovalIssue(),
    pause: (runId) => pauseProductionRuntime(context, runId),
    resume: (runId, requestedMode) => resumeProductionRuntime(context, runId, requestedMode),
    stop: (runId, resultStatus) => stopProductionRuntime(context, runId, resultStatus),
    takeover: (runId) => settleProductionRuntime(context, runId, "takeover"),
    reconcile: (runId) => settleProductionRuntime(context, runId, "reconcile"),
    health: () => context.slot.manager()?.health() ?? { status: "stopped" },
    // Delegated to the slot's live manager and additionally slot-matched, so a review can never be
    // read from a run the slot no longer owns (#2802).
    pendingApprovalReview: (runId, requestId) =>
      context.slot.matches(runId)
        ? context.slot.manager()?.pendingApprovalReview(runId, requestId)
        : undefined,
    result: (runId) =>
      (context.slot.matches(runId) ? context.slot.manager()?.result(runId) : undefined) ??
      (context.lastResult?.runId === runId ? context.lastResult.result : undefined),
  };
}

async function startProductionRuntime(
  runs: Map<string, ProductionRuntimeRunRecord>,
  context: ProductionRuntimeManagerContext,
  request: Parameters<CodingRuntimeManager["start"]>[0],
): Promise<CodingRuntimeStartResult> {
  await context.slot.cleanupIfStopped();
  const record = runs.get(request.runId);
  if (record?.manager === undefined || !context.slot.claim(request.runId)) return startMismatch();
  const result = await record.manager.start(request);
  if (result.ok) {
    context.authority.transition(request.runId, "ready", context.now().toISOString());
    context.authority.transition(request.runId, "running", context.now().toISOString());
  } else if (record.manager.health().status === "stopped") {
    context.authority.abandonUnlaunched(request.runId, context.now().toISOString());
    await context.slot.cleanup(request.runId);
  }
  return result;
}

function pauseProductionRuntime(
  context: ProductionRuntimeManagerContext,
  runId: string,
): ReturnType<CodingRuntimeManager["pause"]> {
  const manager = context.slot.manager();
  if (manager === undefined || !context.slot.matches(runId)) return pauseRunMismatch();
  const admitted = context.authority.pause(runId, context.now().toISOString());
  return admitted.ok ? manager.pause(runId) : authorityBoundaryFailure(admitted.reason);
}

function resumeProductionRuntime(
  context: ProductionRuntimeManagerContext,
  runId: string,
  requestedMode: Parameters<CodingRuntimeManager["resume"]>[1],
): ReturnType<CodingRuntimeManager["resume"]> {
  const manager = context.slot.manager();
  if (manager === undefined || !context.slot.matches(runId) || requestedMode === undefined) {
    return pauseRunMismatch();
  }
  const admitted = context.authority.resume(runId, requestedMode, context.now().toISOString());
  return admitted.ok
    ? manager.resume(runId, admitted.effectiveMode)
    : authorityBoundaryFailure(admitted.reason);
}

function captureTerminalResult(
  context: ProductionRuntimeManagerContext,
  manager: CodingRuntimeManager,
  runId: string,
): void {
  const terminal = manager.result(runId);
  if (terminal !== undefined) context.lastResult = { runId, result: terminal };
}

async function settleProductionRuntime(
  context: ProductionRuntimeManagerContext,
  runId: string,
  action: "takeover" | "reconcile",
): ReturnType<CodingRuntimeManager["stop"]> {
  const manager = context.slot.manager();
  if (manager === undefined || !context.slot.matches(runId)) return stoppedRun();
  const result = await manager[action](runId);
  if (result.ok) {
    captureTerminalResult(context, manager, runId);
    await context.slot.cleanup(runId);
  }
  return result;
}

async function stopProductionRuntime(
  context: ProductionRuntimeManagerContext,
  runId: string,
  resultStatus?: Parameters<CodingRuntimeManager["stop"]>[1],
): ReturnType<CodingRuntimeManager["stop"]> {
  const manager = context.slot.manager();
  if (manager === undefined || !context.slot.matches(runId)) return stoppedRun();
  const result = await manager.stop(runId, resultStatus);
  if (result.ok) {
    captureTerminalResult(context, manager, runId);
    await context.slot.cleanup(runId);
  }
  return result;
}

function authorityBoundaryFailure(reason: string): ReturnType<CodingRuntimeManager["pause"]> {
  return {
    ok: false,
    failureCode: reason === "authority-expired" ? reason : "authority-resolution-failed",
    retryable: false,
  };
}

interface ProductionRuntimeSlot {
  readonly manager: () => CodingRuntimeManager | undefined;
  readonly matches: (runId: string) => boolean;
  readonly claim: (runId: string) => boolean;
  readonly cleanup: (runId: string) => Promise<void>;
  readonly cleanupIfStopped: () => Promise<void>;
}

function createProductionRuntimeSlot(
  runs: Map<string, ProductionRuntimeRunRecord>,
): ProductionRuntimeSlot {
  let activeRunId: string | undefined;
  let activeCleanup: { readonly runId: string; readonly completion: Promise<void> } | undefined;
  const manager = (): CodingRuntimeManager | undefined =>
    activeRunId === undefined ? undefined : runs.get(activeRunId)?.manager;
  const cleanup = async (runId: string): Promise<void> => {
    const pending = activeCleanup;
    if (pending?.runId === runId) {
      await pending.completion;
      return;
    }
    const completion = cleanupRun(runs, runId).then((): void => {
      if (activeRunId === runId) activeRunId = undefined;
    });
    activeCleanup = { runId, completion };
    try {
      await completion;
    } finally {
      activeCleanup = undefined;
    }
  };
  return {
    manager,
    matches: (runId): boolean => activeRunId === runId,
    claim: (runId): boolean => {
      if (activeRunId !== undefined) return false;
      activeRunId = runId;
      return true;
    },
    cleanup,
    cleanupIfStopped: async (): Promise<void> => {
      const runId = activeRunId;
      if (runId === undefined || manager()?.health().status !== "stopped") return;
      await cleanup(runId);
    },
  };
}

async function cleanupRun(
  runs: Map<string, ProductionRuntimeRunRecord>,
  runId: string,
): Promise<void> {
  const record = runs.get(runId);
  record?.controller.abort();
  await record?.dispose?.();
  runs.delete(runId);
}

function stoppedApprovalIssue(): ReturnType<CodingRuntimeManager["issueApproval"]> {
  return { ok: false, failureCode: "runtime-stopped", retryable: false };
}

function pauseRunMismatch(): ReturnType<CodingRuntimeManager["pause"]> {
  return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
}

function startMismatch(): CodingRuntimeStartResult {
  return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
}

function stoppedRun(): ReturnType<CodingRuntimeManager["stop"]> {
  return Promise.resolve({
    ok: false,
    failureCode: "runtime-run-mismatch",
    retryable: false,
  });
}

export function createOpenCodeRuntimeTurnPort(runPort: OpenCodeRunPort): ProductionRuntimeTurnPort {
  return {
    submitTurn: (runId, text) => runPort.submitTask(runId, text),
    abortTurn: (runId) => runPort.abortTask(runId),
    waitForTerminal: async (runId, signal): Promise<CodingRuntimeTaskOutcome> => {
      if (await runPort.waitForTerminal(runId, signal)) return "succeeded";
      return signal.aborted ? "cancelled" : "failed";
    },
  };
}

interface CodexRunTurnState {
  threadId?: string | undefined;
  turnId?: string | undefined;
}

export function createCodexRuntimeTurnPort(
  control: CodexRuntimeControl,
): ProductionRuntimeTurnPort {
  const runs = new Map<string, CodexRunTurnState>();
  return {
    submitTurn: (runId, text) => submitCodexTurn(control, runs, runId, text),
    abortTurn: (runId) => abortCodexTurn(control, runs, runId),
    waitForTerminal: async (runId, signal): Promise<CodingRuntimeTaskOutcome> => {
      const state = runs.get(runId);
      if (state?.turnId === undefined) return "failed";
      const turnId = state.turnId;
      const outcome = await waitForCodexTerminal(control, runId, turnId, signal);
      if (runs.get(runId)?.turnId === turnId) state.turnId = undefined;
      return outcome;
    },
  };
}

async function submitCodexTurn(
  control: CodexRuntimeControl,
  runs: Map<string, CodexRunTurnState>,
  runId: string,
  text: string,
): Promise<boolean> {
  const state = runs.get(runId) ?? {};
  if (state.turnId !== undefined) return false;
  const options = { timeoutMs: CODEX_CONTROL_TIMEOUT_MS };
  if (state.threadId === undefined) {
    const thread = await control.startThread(runId, options);
    if (!thread.ok) return false;
    state.threadId = thread.threadId;
    runs.set(runId, state);
  }
  const turn = await control.startTurn(runId, state.threadId, text, options);
  if (!turn.ok) return false;
  state.turnId = turn.turnId;
  return true;
}

async function abortCodexTurn(
  control: CodexRuntimeControl,
  runs: ReadonlyMap<string, CodexRunTurnState>,
  runId: string,
): Promise<boolean> {
  const state = runs.get(runId);
  if (state?.threadId === undefined || state.turnId === undefined) return false;
  return (
    await control.interruptTurn(runId, state.threadId, state.turnId, {
      timeoutMs: CODEX_CONTROL_TIMEOUT_MS,
    })
  ).ok;
}

async function waitForCodexTerminal(
  control: CodexRuntimeControl,
  runId: string,
  turnId: string,
  signal: AbortSignal,
): Promise<CodingRuntimeTaskOutcome> {
  while (!signal.aborted) {
    const status = control.terminalStatus(runId, turnId);
    if (status !== undefined) return terminalOutcome(status);
    await pollDelay(signal);
  }
  return "cancelled";
}

function terminalOutcome(
  status: NonNullable<ReturnType<CodexRuntimeControl["terminalStatus"]>>,
): CodingRuntimeTaskOutcome {
  if (status === "completed") return "succeeded";
  if (status === "interrupted") return "cancelled";
  return "failed";
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, CODEX_TERMINAL_POLL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createProductionRuntimeTaskDispatcher(
  runs: ReadonlyMap<string, ProductionRuntimeRunRecord>,
  diagnostics?: ServerDiagnosticSink,
): CodingRuntimeTaskDispatcher {
  return {
    dispatch: (request) => dispatchRuntimeTask(runs, request, diagnostics),
    abort: (request) => abortRuntimeTask(runs, request),
  };
}

async function dispatchRuntimeTask(
  runs: ReadonlyMap<string, ProductionRuntimeRunRecord>,
  request: CodingRuntimeTaskDispatchRequest,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<CodingRuntimeTaskDispatchResult> {
  const record = runs.get(request.runId);
  if (record === undefined) return rejectedDispatch(diagnostics, request.runId, "no-record");
  if (record.controller.signal.aborted)
    return rejectedDispatch(diagnostics, request.runId, "aborted");
  const reservation = record.operationGuard.reserve(request);
  if (reservation === undefined)
    return rejectedDispatch(diagnostics, request.runId, "no-reservation");
  try {
    if (!(await record.turnPort.submitTurn(request.runId, request.taskIntent))) {
      reservation.release();
      return rejectedDispatch(diagnostics, request.runId, "adapter-rejected");
    }
    if (!reservation.commit()) {
      return rejectedDispatch(diagnostics, request.runId, "commit-rejected");
    }
  } catch (error) {
    reservation.release();
    recordRuntimeDispatchFailure(diagnostics, request.runId, "exception", error);
    return { ok: false };
  }
  return { ok: true, completion: terminalCompletion(record, request.runId, diagnostics) };
}

function rejectedDispatch(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeDispatchFailureReason,
): CodingRuntimeTaskDispatchResult {
  recordRuntimeDispatchFailure(diagnostics, runId, reason);
  return { ok: false };
}

async function terminalCompletion(
  record: ProductionRuntimeRunRecord,
  runId: string,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<CodingRuntimeTaskOutcome> {
  try {
    const outcome = await record.turnPort.waitForTerminal(runId, record.controller.signal);
    if (outcome === "failed") recordRuntimeDispatchFailure(diagnostics, runId, "terminal-failed");
    if (outcome !== "succeeded" || record.waitForPendingMutations === undefined) return outcome;
    const settled = await record.waitForPendingMutations(record.controller.signal);
    if (settled) return "succeeded";
    if (!record.controller.signal.aborted) {
      recordRuntimeDispatchFailure(diagnostics, runId, "pending-mutations-unsettled");
    }
    return record.controller.signal.aborted ? "cancelled" : "failed";
  } catch (error) {
    recordRuntimeDispatchFailure(diagnostics, runId, "terminal-exception", error);
    // Consumers treat an unprovable terminal outcome as a failed turn; never leave it unhandled.
    return "failed";
  }
}

type RuntimeDispatchFailureReason =
  | "aborted"
  | "adapter-rejected"
  | "commit-rejected"
  | "exception"
  | "no-record"
  | "no-reservation"
  | "pending-mutations-unsettled"
  | "terminal-exception"
  | "terminal-failed";

function recordRuntimeDispatchFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeDispatchFailureReason,
  error?: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.task-dispatch",
    source: "runtime.dispatcher",
    errorClass: error === undefined ? "RuntimeTaskDispatchFailure" : contentFreeErrorClass(error),
    message: "runtime-turn-failed",
    code: `stage=dispatch:reason=${reason}`,
  });
}

async function abortRuntimeTask(
  runs: ReadonlyMap<string, ProductionRuntimeRunRecord>,
  request: CodingRuntimeRunOperation,
): Promise<boolean> {
  const record = runs.get(request.runId);
  const reservation = record?.operationGuard.reserve(request);
  if (record === undefined || reservation === undefined) return false;
  try {
    const accepted = await record.turnPort.abortTurn(request.runId);
    if (!accepted) {
      reservation.release();
      return false;
    }
    return reservation.commit();
  } catch {
    reservation.release();
    return false;
  } finally {
    record.controller.abort();
  }
}
