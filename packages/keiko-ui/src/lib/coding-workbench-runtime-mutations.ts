import {
  isCodingWorkbenchModeWidening,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeApprovalDecision,
  type CodingWorkbenchRuntimeResearchGrant,
  type CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  acknowledgeCodingWorkbenchRuntimeRecovery,
  codingWorkbenchRuntimeActionError,
  decideCodingWorkbenchRuntimeApproval,
  newCodingWorkbenchRuntimeRequestId,
  pauseCodingWorkbenchRuntime,
  resumeCodingWorkbenchRuntime,
  retryCodingWorkbenchRuntime,
  revokeCodingWorkbenchRuntimeResearchGrant,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  submitCodingWorkbenchRuntimeFollowUp,
  takeOverCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";
import type { CodingWorkbenchRuntimeState } from "./coding-workbench-live-state";

export interface CodingWorkbenchMutationCommand {
  readonly requestId: string;
  readonly expected?: { readonly runId: string; readonly revision: number } | undefined;
  readonly mayInstallNewRun: boolean;
  readonly run: () => Promise<CodingWorkbenchRuntimeSnapshot>;
}

type RuntimeModelSelection = {
  readonly modelId?: string | undefined;
  readonly reasoningEffort?:
    NonNullable<CodingWorkbenchRuntimeState["reasoningEffort"]> | undefined;
};

function managedGatewayModelSelection(current: CodingWorkbenchRuntimeState): RuntimeModelSelection {
  if (current.runtimePreference !== "managed-gateway") return {};
  return {
    ...(current.selectedModelId === null ? {} : { modelId: current.selectedModelId }),
    ...(current.reasoningEffort === null ? {} : { reasoningEffort: current.reasoningEffort }),
  };
}

export function mutationResultMatchesCurrentTruth(
  command: CodingWorkbenchMutationCommand,
  current: CodingWorkbenchRuntimeSnapshot | null,
  result: CodingWorkbenchRuntimeSnapshot,
): boolean {
  if (command.expected === undefined) return command.mayInstallNewRun;
  if (current?.runId !== command.expected.runId || current.revision !== command.expected.revision) {
    return false;
  }
  return command.mayInstallNewRun || result.runId === command.expected.runId;
}

export function createStartMutation(
  taskIntent: string,
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  if (!current.canStart)
    throw codingWorkbenchRuntimeActionError("The runtime is not ready to start.");
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    mayInstallNewRun: true,
    run: () =>
      startCodingWorkbenchRuntime({
        requestId: id,
        taskIntent,
        requestedMode: current.requestedMode,
        runtimePreference: current.runtimePreference,
        ...managedGatewayModelSelection(current),
      }),
  };
}

export function createApprovalMutation(
  decision: CodingWorkbenchRuntimeApprovalDecision,
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const permission = snapshot?.pendingPermission;
  if (!snapshot?.runId || snapshot.state !== "awaiting-approval" || !permission)
    throw codingWorkbenchRuntimeActionError("No current approval request is available.");
  return {
    requestId: permission.requestId,
    expected: { runId: snapshot.runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      decideCodingWorkbenchRuntimeApproval(snapshot.runId!, {
        requestId: permission.requestId,
        expectedRevision: snapshot.revision,
        decision,
      }),
  };
}

export function createRunBoundMutation(
  kind: "stop" | "takeover",
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  if (!runId || snapshot === null)
    throw codingWorkbenchRuntimeActionError("No current runtime run is available.");
  return {
    requestId: runId,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      kind === "stop"
        ? stopCodingWorkbenchRuntime(runId, { requestId: runId })
        : takeOverCodingWorkbenchRuntime(runId, { requestId: runId }),
  };
}

export function createLifecycleMutation(
  kind: "pause" | "resume",
  current: CodingWorkbenchRuntimeState,
  requestedMode?: CodingWorkbenchMode,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  const admissible =
    kind === "pause" ? snapshot?.state === "running" : snapshot?.state === "paused";
  if (!runId || snapshot === null || !admissible)
    throw codingWorkbenchRuntimeActionError("The run cannot change lifecycle state right now.");
  const resumeMode =
    kind === "resume" ? validatedResumeMode(snapshot.effectiveMode, requestedMode) : undefined;
  return {
    requestId: runId,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      kind === "pause"
        ? pauseCodingWorkbenchRuntime(runId, { requestId: runId })
        : resumeCodingWorkbenchRuntime(runId, { requestId: runId, requestedMode: resumeMode }),
  };
}

function validatedResumeMode(
  currentMode: CodingWorkbenchMode | undefined,
  requestedMode: CodingWorkbenchMode | undefined,
): CodingWorkbenchMode {
  if (
    currentMode === undefined ||
    requestedMode === undefined ||
    isCodingWorkbenchModeWidening(currentMode, requestedMode)
  ) {
    throw codingWorkbenchRuntimeActionError("Resume requires the current or a narrower mode.");
  }
  return requestedMode;
}

export function createFollowUpMutation(
  taskIntent: string,
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  // No hidden prompt queue: a drafted follow-up is only ever admitted against a paused run.
  if (!runId || snapshot?.state !== "paused" || taskIntent.length === 0)
    throw codingWorkbenchRuntimeActionError(
      "A follow-up can only be sent while the run is paused.",
    );
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      submitCodingWorkbenchRuntimeFollowUp(runId, {
        requestId: id,
        expectedRevision: snapshot.revision,
        taskIntent,
      }),
  };
}

export function createRetryMutation(
  taskIntent: string,
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  if (!runId || snapshot === null || !current.canRetry)
    throw codingWorkbenchRuntimeActionError("Recovery must be acknowledged before retry.");
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: true,
    run: () =>
      retryCodingWorkbenchRuntime(runId, {
        requestId: id,
        taskIntent,
        requestedMode: current.requestedMode,
        runtimePreference: current.runtimePreference,
        ...managedGatewayModelSelection(current),
      }),
  };
}

export function createResearchRevokeMutation(
  current: CodingWorkbenchRuntimeState,
  grant: CodingWorkbenchRuntimeResearchGrant,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  // Fail closed: the authenticated-channel grant is bound to the exact observed run revision. A
  // stale click after the server drops it is still rejected by the server-side registry check.
  if (!runId || snapshot === null)
    throw codingWorkbenchRuntimeActionError("No internet research grant is available to revoke.");
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      revokeCodingWorkbenchRuntimeResearchGrant(runId, {
        requestId: id,
        expectedRevision: snapshot.revision,
        grantId: grant.grantId,
      }),
  };
}

export function createRecoveryAcknowledgementMutation(
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  if (!snapshot?.runId || snapshot.state !== "recovery-required")
    throw codingWorkbenchRuntimeActionError("No recovery acknowledgement is available.");
  return {
    requestId: snapshot.runId,
    expected: { runId: snapshot.runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      acknowledgeCodingWorkbenchRuntimeRecovery(snapshot.runId!, {
        requestId: snapshot.runId!,
        acknowledged: true,
      }),
  };
}
