import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpRequest,
} from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
  type JiraMutationAttempt,
  type JiraMutationOutcome,
  type JiraMutationResultState,
  type JiraMutationReceipt,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  JiraChatToolMutationIntent as ChatToolMutationIntent,
  ChatToolMutationRecord,
  ChatToolMutationStore,
} from "../store/chatToolMutationTypes.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";

export interface JiraChatMutationExecution {
  readonly journal: ChatToolMutationStore | undefined;
  readonly intent: ChatToolMutationIntent;
  /** The custody owner keeps credentials private and composes the journal's final HTTP hooks. */
  readonly httpPortFactory: (lifecycle: AtlassianHttpLifecycleOptions) => AtlassianHttpBodyPort;
  /** Current binding, authority, approval and budget admission for metadata and confirmation reads. */
  readonly beforeEffect: () => boolean;
  /** Claim this exact mutation's approval inside the journal transaction, only before POST/PUT. */
  readonly beforeMutation: () => boolean;
  readonly execute: (http: AtlassianHttpBodyPort) => Promise<JiraMutationAttempt>;
}
const REASONS: ReadonlySet<string> = new Set(ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS);
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  "issueKey",
  "issueId",
  "commentId",
  "transitionId",
]);
const FAILED: JiraMutationAttempt = { ok: false, reason: "unavailable" };
const REQUIRED_RECEIPTS: Readonly<
  Record<JiraMutationOperation, readonly (keyof JiraMutationReceipt)[]>
> = {
  "jira.create": ["issueKey", "issueId"],
  "jira.edit": ["issueKey"],
  "jira.assign": ["issueKey"],
  "jira.comment": ["issueKey", "commentId"],
  "jira.transition": ["issueKey", "transitionId"],
};
function mutationDiagnostic(
  intent: ChatToolMutationIntent,
  error: unknown,
): ReturnType<typeof serverDiagnosticFromError> {
  return serverDiagnosticFromError({
    correlationId: intent.correlationId,
    operation: "jira.mutation-execution-failed",
    source: "jira-chat-mutation",
    error,
    redact: () => "server-operation-failed",
  });
}
function confirmed(value: unknown): boolean {
  return value === true;
}
function validAttempt(
  value: JiraMutationAttempt,
  operation: JiraMutationOperation,
): JiraMutationAttempt {
  if (!value.ok) {
    const reason = value.reason;
    return REASONS.has(reason) ? { ok: false, reason } : { ok: false, reason: "malformed-payload" };
  }
  const receipt = Object.freeze({ ...value.receipt });
  const valid =
    confirmed(value.ok) &&
    REQUIRED_RECEIPTS[operation].every((key) => receipt[key] !== undefined) &&
    Object.entries(receipt).every(
      ([key, id]) => RECEIPT_KEYS.has(key) && isSafeAtlassianIdentifier(id),
    );
  return valid ? { ok: true, receipt } : { ok: false, reason: "malformed-payload" };
}
function result(
  outcome: JiraMutationResultState,
  reason?: AtlassianConnectorWriteFailureReason,
  receipt: JiraMutationReceipt = {},
  replayed = false,
): ManagedMcpToolResult {
  return {
    data: {
      ...receipt,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(replayed ? { replayed: true } : {}),
    },
    ...(outcome === "succeeded" ? {} : { isError: true }),
  };
}
function observedOutcome(record: ChatToolMutationRecord | undefined): JiraMutationOutcome {
  if (record === undefined) return "unknown";
  if (record.outcome !== null) return record.outcome;
  if (record.phase === "prepared") return "not-dispatched";
  return record.phase === "acknowledged" ? "succeeded-unconfirmed" : "unknown";
}
function mutationTransport(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
): AtlassianHttpBodyPort {
  const { intent } = input;
  return input.httpPortFactory({
    beforeDispatch: (request): boolean => {
      if (request.method === "GET") return confirmed(input.beforeEffect());
      return journal.beginDispatch(
        intent.invocationId,
        () => confirmed(input.beforeEffect()) && confirmed(input.beforeMutation()),
      );
    },
    onResponse: (
      request: AtlassianHttpRequest | AtlassianHttpBodyRequest,
      status: number,
    ): boolean => {
      if (request.method !== "GET") journal.acknowledge(intent.invocationId, status);
      return true;
    },
  });
}
async function attempt(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
): Promise<JiraMutationAttempt> {
  try {
    return validAttempt(
      await input.execute(mutationTransport(input, journal)),
      input.intent.operation,
    );
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(input.intent, error));
    return FAILED;
  }
}
function finish(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  const current = journal.find(input.intent.invocationId);
  let outcome = observedOutcome(current);
  if (current?.phase === "prepared" && !attempt.ok) outcome = "rejected";
  if (current?.phase === "acknowledged" && attempt.ok) outcome = "succeeded";
  try {
    journal.settle(input.intent.invocationId, outcome);
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(input.intent, error));
    return result(observedOutcome(current), "unavailable");
  }
  return attemptResult(outcome, attempt);
}
function attemptResult(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  return result(
    outcome,
    attempt.ok ? undefined : attempt.reason,
    outcome === "succeeded" && attempt.ok ? attempt.receipt : {},
  );
}

/** One owner composes the existing journal and HTTP port; replay never executes provider code. */
export async function executeJiraChatMutation(
  source: JiraChatMutationExecution,
): Promise<ManagedMcpToolResult> {
  const input = {
    ...source,
    intent: Object.freeze({ ...source.intent }),
  };
  const { journal, intent } = input;
  if (journal === undefined) return result("pending", "unavailable");
  try {
    if (!confirmed(input.beforeEffect())) return result("pending", "permission-denied");
    const preparation = journal.prepare(intent);
    if (preparation.kind === "blocked")
      return result(
        "not-dispatched",
        preparation.reason === "capacity" ? "bounds-exceeded" : "conflict",
      );
    if (preparation.kind === "replayed")
      return result(preparation.record.outcome ?? "pending", undefined, {}, true);
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(intent, error));
    return result("pending", "unavailable");
  }
  try {
    return finish(input, journal, await attempt(input, journal));
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(intent, error));
    return result("unknown", "unavailable");
  }
}
