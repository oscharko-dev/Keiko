import type { CodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import { createProductionOpenCodeQuestionPort } from "./productionOpenCodeQuestionPort.js";
import type {
  CodingRuntimeManager,
  CodingRuntimeManagerDeps,
  CodingRuntimeStartResult,
} from "./codingRuntimeManager.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { createNativeRuntimeRecoveryPort } from "./nativeRuntimeProcessBackend.js";
import type { OpenCodeRuntimeComposition } from "./opencodeRuntimeComposition.js";
import type { QualifiedProductionCodingRuntime } from "./productionCodingRuntimeHost.js";
import type {
  CodingRuntimeAuthorityService,
  CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";

export interface ProductionRuntimeRunRecord {
  readonly context: CodingRuntimeTrustedContext;
  readonly composition: OpenCodeRuntimeComposition;
  readonly invocationRegistry: CodingToolInvocationRegistry;
  readonly leases: CodingRuntimeEditorMutationLeaseCoordinator;
  readonly controller: AbortController;
}

export function createProductionRuntimeManager(
  runs: Map<string, ProductionRuntimeRunRecord>,
  authority: CodingRuntimeAuthorityService,
): CodingRuntimeManager {
  let activeRunId: string | undefined;
  const active = (): CodingRuntimeManager | undefined =>
    activeRunId === undefined ? undefined : runs.get(activeRunId)?.composition.manager;
  return {
    start: (request) =>
      startRun(runs, authority, request, activeRunId, (runId) => {
        activeRunId = runId;
      }),
    issueApproval: (request) =>
      active()?.issueApproval(request) ?? {
        ok: false,
        failureCode: "runtime-stopped",
        retryable: false,
      },
    stop: (runId) =>
      settleActive(runs, active(), activeRunId, runId, "stop", (settledRunId) => {
        if (activeRunId === settledRunId) activeRunId = undefined;
      }),
    takeover: (runId) =>
      settleActive(runs, active(), activeRunId, runId, "takeover", (settledRunId) => {
        if (activeRunId === settledRunId) activeRunId = undefined;
      }),
    reconcile: (runId) =>
      settleActive(runs, active(), activeRunId, runId, "reconcile", (settledRunId) => {
        if (activeRunId === settledRunId) activeRunId = undefined;
      }),
    health: () => active()?.health() ?? { status: "stopped" },
  };
}

async function startRun(
  runs: Map<string, ProductionRuntimeRunRecord>,
  authority: CodingRuntimeAuthorityService,
  request: Parameters<CodingRuntimeManager["start"]>[0],
  activeRunId: string | undefined,
  setActive: (runId: string | undefined) => void,
): Promise<CodingRuntimeStartResult> {
  const record = runs.get(request.runId);
  if (record === undefined || activeRunId !== undefined) return startMismatch();
  setActive(request.runId);
  const result = await record.composition.manager.start(request);
  if (result.ok) {
    authority.transition(request.runId, "ready", new Date().toISOString());
    authority.transition(request.runId, "running", new Date().toISOString());
  } else if (record.composition.manager.health().status === "stopped") {
    authority.abandonUnlaunched(request.runId, new Date().toISOString());
    cleanupProductionRuntimeRun(runs, request.runId);
    setActive(undefined);
  }
  return result;
}

async function settleActive(
  runs: Map<string, ProductionRuntimeRunRecord>,
  manager: CodingRuntimeManager | undefined,
  activeRunId: string | undefined,
  runId: string,
  action: "reconcile" | "stop" | "takeover",
  clearActive: (runId: string) => void,
): ReturnType<CodingRuntimeManager["stop"]> {
  if (manager === undefined || activeRunId !== runId) return stoppedRun();
  const result = await manager[action](runId);
  if (result.ok) {
    cleanupProductionRuntimeRun(runs, runId);
    clearActive(runId);
  }
  return result;
}

export function createProductionRuntimeTaskDispatcher(
  runs: Map<string, ProductionRuntimeRunRecord>,
): QualifiedProductionCodingRuntime["taskDispatcher"] & CodingRuntimeQuestionPort {
  return {
    dispatch: async (runId, taskIntent) => dispatchTask(runs, runId, taskIntent),
    abort: async (runId): Promise<boolean> => {
      const record = runs.get(runId);
      record?.controller.abort();
      return record === undefined ? false : record.composition.runPort.abortTask(runId);
    },
    ...createProductionOpenCodeQuestionPort(runs),
  };
}

async function dispatchTask(
  runs: Map<string, ProductionRuntimeRunRecord>,
  runId: string,
  taskIntent: string,
): Promise<Awaited<ReturnType<QualifiedProductionCodingRuntime["taskDispatcher"]["dispatch"]>>> {
  const record = runs.get(runId);
  if (record === undefined || !(await record.composition.runPort.submitTask(runId, taskIntent))) {
    return { ok: false };
  }
  const completion = record.composition.runPort
    .waitForTerminal(runId, record.controller.signal)
    .then((settled) =>
      settled ? "succeeded" : record.controller.signal.aborted ? "cancelled" : "failed",
    );
  return { ok: true, completion };
}

export function createProductionRuntimeRecoveryPort(portable: {
  readonly nativeHelperPath: string;
}): QualifiedProductionCodingRuntime["recovery"] {
  const recovery = createNativeRuntimeRecoveryPort({ helperPath: portable.nativeHelperPath });
  return {
    reconcile: async (_runId, recoveryHandle) =>
      (await recovery.reconcile(recoveryHandle, 5_000))
        ? { status: "reaped", recoveryHandle }
        : { status: "unreaped" },
  };
}

export function createProductionAuthorityLifecycle(
  authority: CodingRuntimeAuthorityService,
  invocations: CodingToolInvocationRegistry,
  leases: CodingRuntimeEditorMutationLeaseCoordinator,
  controller: AbortController,
): Pick<
  CodingRuntimeManagerDeps,
  | "revokeRuntime"
  | "abortInFlightActions"
  | "markRuntimeRecoveryRequired"
  | "releaseRuntimeAfterReap"
> {
  return {
    revokeRuntime: (runId): boolean => {
      controller.abort();
      invocations.revokeRun(runId);
      leases.revokeRun(runId);
      return authority.revokeBeforeTerminate(runId);
    },
    abortInFlightActions: (runId) => invocations.revokeRun(runId) >= 0,
    markRuntimeRecoveryRequired: (runId) =>
      authority.markRecoveryRequired(runId, new Date().toISOString()),
    releaseRuntimeAfterReap: (runId, receipt) =>
      authority.confirmReaped(runId, receipt, new Date().toISOString()),
  };
}

function cleanupProductionRuntimeRun(
  runs: Map<string, ProductionRuntimeRunRecord>,
  runId: string,
): void {
  const record = runs.get(runId);
  record?.controller.abort();
  record?.leases.dispose();
  record?.invocationRegistry.dispose();
  runs.delete(runId);
}

function startMismatch(): Promise<CodingRuntimeStartResult> {
  return Promise.resolve({
    ok: false,
    failureCode: "runtime-run-mismatch",
    retryable: false,
  });
}

function stoppedRun(): ReturnType<CodingRuntimeManager["stop"]> {
  return Promise.resolve({
    ok: false,
    failureCode: "runtime-run-mismatch",
    retryable: false,
  });
}
