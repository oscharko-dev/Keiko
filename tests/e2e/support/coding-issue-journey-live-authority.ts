// #3390 — body-free authority evidence for one real live run. The producer consumes the exact
// activity-event tree already used for repository-search and verifier proof; it does not infer a
// mode from browser labels or manufacture approval outcomes that the log does not record.

import type {
  CodeTaskQualificationAuthorityObservationV1,
  CodeTaskQualificationApprovalRequestObservationV1,
  CodeTaskQualificationApprovedProposalObservationV1,
  CodeTaskQualificationEffectToolObservationV1,
  CodeTaskQualificationProposalActionKind,
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
  CodingWorkbenchSupervisedActionKind,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  permissionKindForSupervisedCodingAction,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

type ActivityEvent = Readonly<Record<string, unknown>>;

interface AuthorityObservationBinding {
  readonly runId: string;
  readonly mode: CodingWorkbenchMode;
}

const TOOL_SETTLEMENT_STATUSES = new Set([
  "completed",
  "denied",
  "invalid",
  "busy",
  "cancelled",
  "timeout",
  "failed",
]);
const PROPOSAL_ACTION_KINDS = ["git-stage", "commit", "push", "pull-request"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function exactlyOne(
  events: readonly ActivityEvent[],
  op: string,
  description: string,
): ActivityEvent {
  const matches = events.filter((event) => event.op === op);
  if (matches.length !== 1) {
    throw new Error(`qualification authority observation requires one ${description}`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error(`qualification authority ${description} is unavailable`);
  return match;
}

function uniqueIds(events: readonly ActivityEvent[], field: string, description: string): void {
  const values = events.map((event) => event[field]);
  if (
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`qualification authority observation has invalid ${description} identities`);
  }
}

function runIdentity(events: readonly ActivityEvent[], binding: AuthorityObservationBinding): void {
  const started = exactlyOne(events, "coding-runtime.run.started", "run-started event");
  const settled = exactlyOne(events, "coding-runtime.run.settled", "run-settled event");
  if (
    started.runId !== binding.runId ||
    settled.runId !== binding.runId ||
    started.requestedMode !== binding.mode ||
    started.effectiveMode !== binding.mode ||
    settled.state !== "succeeded"
  ) {
    throw new Error("qualification authority observation does not match the successful run mode");
  }
}

function statusCount(events: readonly ActivityEvent[], status: string): number {
  return events.filter((event) => event.status === status).length;
}

interface ObservedApprovalRequest {
  readonly requestId: string;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
}

function approvalRequestFromEvent(
  event: ActivityEvent,
  binding: AuthorityObservationBinding,
): ObservedApprovalRequest {
  const { requestId, permissionKind, actionClass, actionKind } = event;
  if (
    event.runId !== binding.runId ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    !isOneOf(actionClass, CODING_WORKBENCH_ACTION_CLASSES) ||
    !isOneOf(actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS) ||
    permissionKind !== actionClass ||
    permissionKindForSupervisedCodingAction(actionKind) !== actionClass
  ) {
    throw new Error("qualification authority observation contains an invalid approval request");
  }
  return { requestId, actionClass, actionKind };
}

function assertStableApprovalRequest(
  prior: Omit<ObservedApprovalRequest, "requestId"> | undefined,
  current: Omit<ObservedApprovalRequest, "requestId">,
): void {
  if (
    prior !== undefined &&
    (prior.actionClass !== current.actionClass || prior.actionKind !== current.actionKind)
  ) {
    throw new Error("qualification authority observation has changed approval request metadata");
  }
}

function approvalRequests(
  events: readonly ActivityEvent[],
  binding: AuthorityObservationBinding,
): readonly CodeTaskQualificationApprovalRequestObservationV1[] {
  const approvals = events.filter((event) => event.op === "coding-runtime.approval.waiting");
  const byRequest = new Map<
    string,
    { actionClass: CodingWorkbenchActionClass; actionKind: CodingWorkbenchSupervisedActionKind }
  >();
  for (const event of approvals) {
    const { requestId, ...current } = approvalRequestFromEvent(event, binding);
    assertStableApprovalRequest(byRequest.get(requestId), current);
    byRequest.set(requestId, current);
  }
  const grouped = new Map<string, CodeTaskQualificationApprovalRequestObservationV1>();
  for (const approval of byRequest.values()) {
    const key = `${approval.actionClass}\u0000${approval.actionKind}`;
    const prior = grouped.get(key);
    grouped.set(key, { ...approval, requestCount: (prior?.requestCount ?? 0) + 1 });
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.actionClass}:${left.actionKind}`.localeCompare(
      `${right.actionClass}:${right.actionKind}`,
    ),
  );
}

function approvedProposalActions(
  events: readonly ActivityEvent[],
): readonly CodeTaskQualificationApprovedProposalObservationV1[] {
  const approvals = events.filter(
    (event) =>
      event.op === "coding-runtime.tool-result" &&
      event.state === "approval-wait-settled" &&
      event.reason === "approved",
  );
  const byProposal = new Map<string, CodeTaskQualificationProposalActionKind>();
  for (const event of approvals) {
    const { proposalId, actionKind } = event;
    if (
      typeof proposalId !== "string" ||
      proposalId.length === 0 ||
      !isOneOf(actionKind, PROPOSAL_ACTION_KINDS)
    ) {
      throw new Error("qualification authority observation has invalid approved proposal evidence");
    }
    const prior = byProposal.get(proposalId);
    if (prior !== undefined && prior !== actionKind) {
      throw new Error("qualification authority observation has changed approved proposal metadata");
    }
    byProposal.set(proposalId, actionKind);
  }
  const counts = new Map<CodeTaskQualificationProposalActionKind, number>();
  for (const actionKind of byProposal.values()) {
    counts.set(actionKind, (counts.get(actionKind) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actionKind, approvalCount]) => ({ actionKind, approvalCount }));
}

function effectStartedTools(
  settlements: readonly ActivityEvent[],
): readonly CodeTaskQualificationEffectToolObservationV1[] {
  const counts = new Map<string, CodeTaskQualificationEffectToolObservationV1>();
  for (const event of settlements.filter((candidate) => candidate.effectStarted === true)) {
    const toolRef = event.toolRef;
    if (!isRecord(toolRef)) {
      throw new Error("qualification authority observation has invalid effectful tool reference");
    }
    const { canonicalId, contractVersion } = toolRef;
    if (
      typeof canonicalId !== "string" ||
      !Number.isSafeInteger(contractVersion) ||
      Number(contractVersion) <= 0
    ) {
      throw new Error("qualification authority observation has invalid effectful tool reference");
    }
    const key = `${canonicalId}\u0000${String(contractVersion)}`;
    const prior = counts.get(key);
    counts.set(key, {
      canonicalId,
      contractVersion: Number(contractVersion),
      invocationCount: (prior?.invocationCount ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((left, right) =>
    `${left.canonicalId}:${String(left.contractVersion)}`.localeCompare(
      `${right.canonicalId}:${String(right.contractVersion)}`,
    ),
  );
}

function assertSettlementPairing(
  starts: readonly ActivityEvent[],
  settlements: readonly ActivityEvent[],
): void {
  uniqueIds(starts, "invocationId", "started tool invocation");
  uniqueIds(settlements, "invocationId", "settled tool invocation");
  const startedIds = new Set(starts.map((event) => event.invocationId));
  const settledIds = new Set(settlements.map((event) => event.invocationId));
  // Catalog admission can settle before execution starts. Only a non-completed,
  // no-effect settlement may lack a start; every actual start still needs a settlement.
  if (
    starts.some((event) => !settledIds.has(event.invocationId)) ||
    settlements.some(
      (event) =>
        !startedIds.has(event.invocationId) &&
        (event.status === "completed" || event.effectStarted !== false),
    )
  ) {
    throw new Error("qualification authority observation has unmatched tool invocations");
  }
}

function settlementCounts(
  starts: readonly ActivityEvent[],
  settlements: readonly ActivityEvent[],
): Pick<
  CodeTaskQualificationAuthorityObservationV1,
  | "toolInvocationCount"
  | "effectStartedCount"
  | "completedToolCount"
  | "deniedToolCount"
  | "failedToolCount"
  | "otherToolCount"
> {
  if (
    settlements.length === 0 ||
    settlements.some(
      (event) =>
        !TOOL_SETTLEMENT_STATUSES.has(String(event.status)) ||
        typeof event.effectStarted !== "boolean",
    )
  ) {
    throw new Error("qualification authority observation has invalid tool settlement evidence");
  }
  assertSettlementPairing(starts, settlements);
  const completedToolCount = statusCount(settlements, "completed");
  const deniedToolCount = statusCount(settlements, "denied");
  const failedToolCount = statusCount(settlements, "failed");
  return {
    toolInvocationCount: settlements.length,
    effectStartedCount: settlements.filter((event) => event.effectStarted === true).length,
    completedToolCount,
    deniedToolCount,
    failedToolCount,
    otherToolCount: settlements.length - completedToolCount - deniedToolCount - failedToolCount,
  };
}

export function observeQualificationFlowAuthority(
  events: readonly ActivityEvent[],
  binding: AuthorityObservationBinding,
): CodeTaskQualificationAuthorityObservationV1 {
  runIdentity(events, binding);
  const approvalRequestObservations = approvalRequests(events, binding);
  const starts = events.filter((event) => event.op === "tool-catalog.invocation-started");
  const settlements = events.filter((event) => event.op === "tool-catalog.invocation-settled");
  const counts = settlementCounts(starts, settlements);
  return {
    requestedMode: binding.mode,
    effectiveMode: binding.mode,
    approvalRequestCount: approvalRequestObservations.reduce(
      (count, observation) => count + observation.requestCount,
      0,
    ),
    approvalRequests: approvalRequestObservations,
    approvedProposalActions: approvedProposalActions(events),
    effectStartedTools: effectStartedTools(settlements),
    ...counts,
  };
}
