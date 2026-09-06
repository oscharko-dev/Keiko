// #3390 — body-free authority evidence for one real live run. The producer consumes the exact
// activity-event tree already used for repository-search and verifier proof; it does not infer a
// mode from browser labels or manufacture approval outcomes that the log does not record.

import type {
  CodeTaskQualificationAuthorityObservationV1,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

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
  const approvals = events.filter((event) => event.op === "coding-runtime.approval.waiting");
  if (approvals.some((event) => event.runId !== binding.runId)) {
    throw new Error("qualification authority observation contains a foreign approval request");
  }
  uniqueIds(approvals, "requestId", "approval request");
  const starts = events.filter((event) => event.op === "tool-catalog.invocation-started");
  const settlements = events.filter((event) => event.op === "tool-catalog.invocation-settled");
  return {
    requestedMode: binding.mode,
    effectiveMode: binding.mode,
    approvalRequestCount: approvals.length,
    ...settlementCounts(starts, settlements),
  };
}
