import { createHash } from "node:crypto";
import {
  parseCodingWorkbenchRuntimeStartRequest,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type {
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeTaskDispatchResult,
  CodingRuntimeTaskOutcome,
} from "./codingRuntimeOrchestratorTypes.js";

const RECOVERY_HANDLE = /^[a-f0-9]{32}$/u;

export interface ExecutionContext {
  readonly deps: CodingRuntimeOrchestratorDeps;
  readonly now: () => Date;
  readonly newRunId: () => string;
  readonly activeRunId: () => string | undefined;
  readonly setActiveRunId: (runId: string | undefined) => void;
  readonly current: () => CodingRuntimeSnapshot | undefined;
  readonly fail: (
    failureCode: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
  readonly publish: (snapshot: CodingRuntimeSnapshot) => boolean;
  readonly transition: (
    current: CodingRuntimeSnapshot,
    state: CodingRuntimeSnapshot["state"],
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
  readonly transitionActive: (
    state: CodingRuntimeSnapshot["state"],
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
  readonly terminateAndSettle: (
    current: CodingRuntimeSnapshot,
    state: Extract<CodingRuntimeSnapshot["state"], "cancelled" | "failed" | "succeeded">,
    failureCode: CodingWorkbenchRuntimeFailureCode | undefined,
    abortTask: boolean,
  ) => Promise<CodingRuntimeOrchestratorResult>;
  readonly serial: <T>(work: () => Promise<T>) => Promise<T>;
}

interface PreparedStart {
  readonly runId: string;
  readonly taskIntent: string;
  readonly requestedMode: CodingWorkbenchRuntimeStartRequest["requestedMode"];
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly principal: string;
  readonly now: string;
  readonly launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>;
}

export async function startFreshRuntime(
  context: ExecutionContext,
  input: unknown,
  predecessorRunId?: string,
): Promise<CodingRuntimeOrchestratorResult> {
  const parsed = parseCodingWorkbenchRuntimeStartRequest(input);
  if (!parsed.ok || context.activeRunId())
    return context.fail(parsed.ok ? "active-run-conflict" : "invalid-intent");
  const prepared = prepareStart(context, parsed.value);
  if (!prepared) return context.fail("authority-resolution-failed");
  const snapshot = createStartingSnapshot(prepared, predecessorRunId);
  context.deps.snapshots.create(snapshot);
  context.setActiveRunId(prepared.runId);
  if (!context.publish(snapshot))
    return context.transition(snapshot, "recovery-required", "recovery-required");
  return startManagedRuntime(context, prepared);
}

function prepareStart(
  context: ExecutionContext,
  request: CodingWorkbenchRuntimeStartRequest,
): PreparedStart | undefined {
  const active = context.deps.workspaceLifecycle.getActive();
  const principal = context.deps.serverPrincipal();
  if (!active || !principal) return undefined;
  const runId = context.newRunId();
  try {
    const launch = context.deps.launchResolver.resolve({
      runId,
      requestId: request.requestId,
      taskIntent: request.taskIntent,
      requestedMode: request.requestedMode,
      ...(request.runtimePreference ? { runtimePreference: request.runtimePreference } : {}),
      workspaceId: active.instance.workspaceId,
      workspaceRoot: active.binding.activeRoot,
      serverPrincipal: principal,
    });
    if (!RECOVERY_HANDLE.test(launch.recoveryHandle)) return undefined;
    return {
      runId,
      taskIntent: request.taskIntent,
      requestedMode: request.requestedMode,
      workspaceId: active.instance.workspaceId,
      workspaceRoot: active.binding.activeRoot,
      principal,
      now: context.now().toISOString(),
      launch,
    };
  } catch {
    return undefined;
  }
}

function createStartingSnapshot(
  prepared: PreparedStart,
  predecessorRunId: string | undefined,
): CodingRuntimeSnapshot {
  return {
    schemaVersion: "1",
    runId: prepared.runId,
    state: "starting",
    revision: 1,
    requestedMode: prepared.requestedMode,
    runtimeSource: prepared.launch.runtimeSource,
    modelSource: prepared.launch.modelSource,
    createdAt: prepared.now,
    updatedAt: prepared.now,
    taskDigest: digest(prepared.launch.taskRef),
    workspaceDigest: digest(prepared.workspaceRoot),
    operatorDigest: digest(prepared.principal),
    authorityDigest: digest(prepared.launch.treeBindingId),
    bindingDigest: digest(prepared.workspaceId),
    provenanceDigest: digest(`${prepared.launch.adapterKind}:${prepared.launch.executablePath}`),
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
    recoveryHandle: prepared.launch.recoveryHandle,
    ...(predecessorRunId ? { predecessorRunId } : {}),
  };
}

async function startManagedRuntime(
  context: ExecutionContext,
  prepared: PreparedStart,
): Promise<CodingRuntimeOrchestratorResult> {
  let result: Awaited<ReturnType<CodingRuntimeOrchestratorDeps["manager"]["start"]>>;
  try {
    result = await context.deps.manager.start({
      ...prepared.launch,
      runId: prepared.runId,
      workspaceRoot: prepared.workspaceRoot,
      requestedMode: prepared.requestedMode,
    });
  } catch {
    await reconcileUntrustedStart(context, prepared.runId);
    return context.transitionActive("recovery-required", "recovery-required");
  }
  if (result.ok && result.runId !== prepared.runId) {
    await reconcileUntrustedStart(context, result.runId);
    return context.transitionActive("recovery-required", "recovery-required");
  }
  if (result.ok) return dispatchRuntimeTask(context, prepared.runId, prepared.taskIntent);
  const current = context.current();
  return current
    ? context.terminateAndSettle(current, "failed", "runtime-failed", true)
    : context.fail("runtime-failed");
}

async function reconcileUntrustedStart(context: ExecutionContext, runId: string): Promise<void> {
  try {
    await context.deps.manager.reconcile(runId);
  } catch {
    // Recovery-required remains the only safe projection when host containment cannot be proven.
  }
}

async function dispatchRuntimeTask(
  context: ExecutionContext,
  runId: string,
  taskIntent: string,
): Promise<CodingRuntimeOrchestratorResult> {
  const ready = context.transitionActive("ready");
  if (!ready.ok || ready.snapshot.state !== "ready") return ready;
  const dispatched = await dispatchTask(context, runId, taskIntent);
  if (!dispatched.ok) return settleFailedDispatch(context, runId);
  const running = context.transitionActive("running");
  if (!running.ok || running.snapshot.state !== "running")
    return settleInterruptedDispatch(context, runId, running);
  observeTaskCompletion(context, runId, dispatched.completion);
  return running;
}

async function dispatchTask(
  context: ExecutionContext,
  runId: string,
  taskIntent: string,
): Promise<CodingRuntimeTaskDispatchResult> {
  try {
    return await context.deps.taskDispatcher.dispatch(runId, taskIntent);
  } catch {
    return { ok: false };
  }
}

async function settleFailedDispatch(
  context: ExecutionContext,
  runId: string,
): Promise<CodingRuntimeOrchestratorResult> {
  const current = context.current();
  return current?.runId === runId
    ? context.terminateAndSettle(current, "failed", "runtime-failed", true)
    : context.fail("runtime-failed");
}

async function settleInterruptedDispatch(
  context: ExecutionContext,
  runId: string,
  running: CodingRuntimeOrchestratorResult,
): Promise<CodingRuntimeOrchestratorResult> {
  const current = context.current();
  if (current?.runId === runId && current.state !== "recovery-required")
    return context.terminateAndSettle(current, "failed", "runtime-failed", true);
  return running;
}

function observeTaskCompletion(
  context: ExecutionContext,
  runId: string,
  completion: Promise<CodingRuntimeTaskOutcome>,
): void {
  void completion.then(
    (outcome) => {
      void context.serial(() => settleTask(context, runId, outcome));
    },
    () => {
      void context.serial(() => settleTask(context, runId, "failed"));
    },
  );
}

async function settleTask(
  context: ExecutionContext,
  runId: string,
  outcome: CodingRuntimeTaskOutcome,
): Promise<void> {
  const current = context.current();
  if (current?.runId !== runId || current.state !== "running") return;
  await context.terminateAndSettle(
    current,
    outcome,
    outcome === "failed" ? "runtime-failed" : undefined,
    outcome !== "succeeded",
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
