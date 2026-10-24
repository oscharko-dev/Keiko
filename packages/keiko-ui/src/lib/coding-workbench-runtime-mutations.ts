import type { CodingWorkbenchStartOptions } from "./coding-workbench-runtime-actions";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchMode,
  CodingWorkbenchPromptDelivery,
  CodingWorkbenchPromptReference,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";
import { isCodingWorkbenchModeWidening } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  CodingWorkbenchCommandRequest,
  CodingWorkbenchRuntimeForkRequest,
  CodingWorkbenchRuntimeRevertAction,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  acknowledgeCodingWorkbenchRuntimeRecovery,
  codingWorkbenchRuntimeActionError,
  decideCodingWorkbenchRuntimeApproval,
  newCodingWorkbenchRuntimeRequestId,
  pauseCodingWorkbenchRuntime,
  resumeCodingWorkbenchRuntime,
  retryCodingWorkbenchRuntime,
  revertCodingWorkbenchRuntime,
  revokeCodingWorkbenchRuntimeResearchGrant,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  submitCodingWorkbenchRuntimeFollowUp,
  takeOverCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";
import {
  offeredCodingWorkbenchAgents,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";

export interface CodingWorkbenchMutationCommand {
  readonly requestId: string;
  readonly expected?: { readonly runId: string; readonly revision: number };
  readonly mayInstallNewRun: boolean;
  readonly run: () => Promise<CodingWorkbenchRuntimeSnapshot>;
}

type RuntimeModelSelection = {
  readonly modelId?: string;
  readonly reasoningEffort?: NonNullable<CodingWorkbenchRuntimeState["reasoningEffort"]>;
};

function managedGatewayModelSelection(current: CodingWorkbenchRuntimeState): RuntimeModelSelection {
  if (current.runtimePreference !== "managed-gateway") return {};
  return {
    ...(current.selectedModelId === null ? {} : { modelId: current.selectedModelId }),
    ...(current.reasoningEffort === null ? {} : { reasoningEffort: current.reasoningEffort }),
  };
}

/**
 * The agent is sent only where the server offers a choice, so a deployment that offers the default
 * alone keeps its request bodies exactly as before. Where the choice exists the selection is always
 * stated, including `build`: a follow-up after a `plan` turn has to be able to switch back.
 */
function agentSelection(current: CodingWorkbenchRuntimeState): {
  readonly agent?: CodingWorkbenchAgent;
} {
  return offeredCodingWorkbenchAgents(current).length > 1 ? { agent: current.agent } : {};
}

/**
 * What the first prompt carries beside its text (ADR-0137 D10): the files it references with `@`, the
 * slash command it starts with, and the task it forks (S03). All are absent for the ordinary start,
 * which keeps its request body exactly as it was.
 */
function startPromptInputs(options: CodingWorkbenchStartOptions): {
  readonly references?: readonly CodingWorkbenchPromptReference[];
  readonly command?: CodingWorkbenchCommandRequest;
  readonly fork?: CodingWorkbenchRuntimeForkRequest;
} {
  const references = options.references ?? [];
  return {
    ...(references.length === 0 ? {} : { references }),
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.fork === undefined ? {} : { fork: options.fork }),
  };
}

function startRequest(
  id: string,
  taskIntent: string,
  current: CodingWorkbenchRuntimeState,
  options: CodingWorkbenchStartOptions,
): CodingWorkbenchRuntimeStartRequest {
  const request = {
    requestId: id,
    taskIntent,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    requestedMode: current.requestedMode,
    runtimePreference: current.runtimePreference,
    projectMemory: { enabled: options.projectMemoryEnabled },
    ...managedGatewayModelSelection(current),
    ...agentSelection(current),
    ...startPromptInputs(options),
  };
  if (options.issue === undefined) return request;
  return {
    ...request,
    issueRef: options.issue.issueRef,
    expectedIssueBindingDigest: options.issue.expectedIssueBindingDigest,
    issuePurpose: "context" as const,
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
  options: CodingWorkbenchStartOptions,
): CodingWorkbenchMutationCommand {
  if (!current.canStart)
    throw codingWorkbenchRuntimeActionError("The runtime is not ready to start.");
  // A command turn carries none of an issue's context; the server refuses the pair, so never send it.
  if (options.command !== undefined && options.issue !== undefined)
    throw codingWorkbenchRuntimeActionError("A slash command cannot start a task from an issue.");
  // A fork begins a new task, so it never also continues one; the server refuses the pair.
  if (options.fork !== undefined && options.conversationId !== undefined)
    throw codingWorkbenchRuntimeActionError("A fork cannot continue a task.");
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    mayInstallNewRun: true,
    run: () => startCodingWorkbenchRuntime(startRequest(id, taskIntent, current, options)),
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

/** What a follow-up carries beside its text; all fields are absent for the ordinary follow-up. */
export interface CodingWorkbenchFollowUpInputs {
  /** Makes the message join the turn that is running; it never starts one (ADR-0137 D10). */
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  /** Workspace files the human referenced with `@`, by path relative to the run's workspace. */
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /**
   * Runs the turn as one of the runtime's slash commands; the text is then the command's arguments
   * and may be empty. A command starts a turn, so it is never a delivery.
   */
  readonly command?: CodingWorkbenchCommandRequest | undefined;
}

interface FollowUpTarget {
  readonly runId: string;
  readonly snapshot: CodingWorkbenchRuntimeSnapshot;
}

/** Whether the follow-up has anything to send: a text, or a command, which may take none. */
function followUpHasText(taskIntent: string, inputs: CodingWorkbenchFollowUpInputs): boolean {
  return taskIntent.length > 0 || inputs.command !== undefined;
}

/**
 * The run a follow-up is admitted against, or the refusal. An ordinary follow-up is only ever
 * admitted against a paused run; a delivered message (`steer` or `queue`) is the one thing a running
 * run takes, and it takes it for the turn in flight. Only a command may carry an empty text, and a
 * command starts a turn, so it is never a delivery.
 */
function followUpTarget(
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  taskIntent: string,
  inputs: CodingWorkbenchFollowUpInputs,
): FollowUpTarget {
  const { delivery, command } = inputs;
  if (command !== undefined && delivery !== undefined) {
    throw codingWorkbenchRuntimeActionError("A slash command cannot be delivered into a turn.");
  }
  const admissible = delivery === undefined ? "paused" : "running";
  if (snapshot?.state !== admissible || !followUpHasText(taskIntent, inputs) || !snapshot.runId) {
    throw codingWorkbenchRuntimeActionError(
      delivery === undefined
        ? "A follow-up can only be sent while the run is paused."
        : "A message can only be sent to a task while its turn is running.",
    );
  }
  return { runId: snapshot.runId, snapshot };
}

export function createFollowUpMutation(
  taskIntent: string,
  current: CodingWorkbenchRuntimeState,
  inputs: CodingWorkbenchFollowUpInputs = {},
): CodingWorkbenchMutationCommand {
  const { runId, snapshot } = followUpTarget(current.run.value, taskIntent, inputs);
  const id = newCodingWorkbenchRuntimeRequestId();
  const { delivery, command } = inputs;
  const references = inputs.references ?? [];
  return {
    requestId: id,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      submitCodingWorkbenchRuntimeFollowUp(runId, {
        requestId: id,
        expectedRevision: snapshot.revision,
        taskIntent,
        // A delivered message joins the turn that runs under its agent and never switches it.
        ...(delivery === undefined ? agentSelection(current) : { delivery }),
        ...(references.length === 0 ? {} : { references }),
        ...(command === undefined ? {} : { command }),
      }),
  };
}

const REVERT_STATES: ReadonlySet<string> = new Set(["running", "paused"]);

/**
 * Undo or restore of the run's newest turn (B3, S04): bound to the observed revision like a
 * follow-up, and only against a live run. The server refuses everything else; this keeps the
 * browser from sending a request it knows cannot be admitted.
 */
export function createRevertMutation(
  action: CodingWorkbenchRuntimeRevertAction,
  current: CodingWorkbenchRuntimeState,
): CodingWorkbenchMutationCommand {
  const snapshot = current.run.value;
  const runId = snapshot?.runId;
  if (!runId || snapshot === null || !REVERT_STATES.has(snapshot.state))
    throw codingWorkbenchRuntimeActionError(
      "The last turn can only be undone while the run is open.",
    );
  const id = newCodingWorkbenchRuntimeRequestId();
  return {
    requestId: id,
    expected: { runId, revision: snapshot.revision },
    mayInstallNewRun: false,
    run: () =>
      revertCodingWorkbenchRuntime(runId, {
        requestId: id,
        expectedRevision: snapshot.revision,
        action,
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
        ...agentSelection(current),
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
