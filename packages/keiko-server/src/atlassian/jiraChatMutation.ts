import {
  isJiraIssueLinkWrite,
  JIRA_ISSUE_LINKS_MAX,
  JIRA_ISSUE_LINKS_PER_REQUEST_MAX,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpRequest,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraMutationAttempt,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  JiraChatToolMutationIntent as ChatToolMutationIntent,
  ChatToolMutationRecord,
  ChatToolMutationStore,
} from "../store/chatToolMutationTypes.js";
import { definitiveRejectionStatus } from "../store/chatToolMutationState.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { recordJiraTemplateAttempt } from "./jiraTemplateLog.js";
import {
  jiraAttemptToolResult,
  jiraLinkCounts,
  jiraMutationToolResult as result,
  validJiraMutationAttempt,
} from "./jiraMutationResult.js";

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
const FAILED: JiraMutationAttempt = { ok: false, reason: "unavailable" };
function confirmed(value: unknown): boolean {
  return value === true;
}
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
function observedOutcome(record: ChatToolMutationRecord | undefined): JiraMutationOutcome {
  if (record === undefined) return "unknown";
  if (record.outcome !== null) return record.outcome;
  if (record.phase === "prepared") return "not-dispatched";
  return record.phase === "acknowledged" ? "succeeded-unconfirmed" : "unknown";
}
/**
 * Jira takes one `issuelinks` operation per create/edit, so a request with several links is that
 * request plus one `POST /rest/api/2/issueLink` per further link (#4176). Those calls are the same
 * approved mutation, not new ones: they dispatch only after this invocation's own write was
 * acknowledged, under the same current-authority and approval guards, at most once each and at
 * most the approved count. They leave the journal record as the primary write set it; a failure or
 * a lost answer leaves it acknowledged, which settles as succeeded-unconfirmed, never as a retry.
 */
function mutationTransport(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
): AtlassianHttpBodyPort {
  const { intent } = input;
  let furtherLinks = 0;
  let continuing = false;
  const admitsContinuation = (request: AtlassianHttpRequest | AtlassianHttpBodyRequest): boolean =>
    isJiraIssueLinkWrite(request) &&
    furtherLinks < JIRA_ISSUE_LINKS_MAX - JIRA_ISSUE_LINKS_PER_REQUEST_MAX &&
    journal.find(intent.invocationId)?.phase === "acknowledged";
  return input.httpPortFactory({
    beforeDispatch: (request): boolean => {
      continuing = false;
      if (request.method === "GET") return confirmed(input.beforeEffect());
      if (admitsContinuation(request)) {
        if (!confirmed(input.beforeEffect()) || !confirmed(input.beforeMutation())) return false;
        furtherLinks += 1;
        continuing = true;
        return true;
      }
      return journal.beginDispatch(
        intent.invocationId,
        () => confirmed(input.beforeEffect()) && confirmed(input.beforeMutation()),
      );
    },
    onResponse: (
      request: AtlassianHttpRequest | AtlassianHttpBodyRequest,
      status: number,
    ): boolean => {
      if (request.method !== "GET" && !continuing) journal.acknowledge(intent.invocationId, status);
      return true;
    },
  });
}
async function attempt(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
): Promise<JiraMutationAttempt> {
  try {
    const result = validJiraMutationAttempt(
      await input.execute(mutationTransport(input, journal)),
      input.intent.operation,
    );
    recordJiraTemplateAttempt(input.intent.correlationId, input.intent.operation, result);
    return result;
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(input.intent, error));
    return FAILED;
  }
}
/**
 * Jira refused the whole request with its own error document: nothing was applied, so the turn may
 * go on and the model gets the field errors to correct. Anything less stays an uncertain write.
 */
function jiraRejectedWithoutEffect(
  record: ChatToolMutationRecord,
  attempt: JiraMutationAttempt,
): boolean {
  if (attempt.ok || !definitiveRejectionStatus(record.httpStatus)) return false;
  const detail = attempt.detail;
  return (detail?.fieldErrors?.length ?? 0) > 0 || (detail?.messages?.length ?? 0) > 0;
}
/** The outcome to settle, and whether it rests on Jira's own error document. */
function settlement(
  current: ChatToolMutationRecord | undefined,
  attempt: JiraMutationAttempt,
): { readonly outcome: JiraMutationOutcome; readonly errorDocument: boolean } {
  if (current?.phase === "prepared" && !attempt.ok)
    return { outcome: "rejected", errorDocument: false };
  if (current?.phase === "dispatched" && jiraRejectedWithoutEffect(current, attempt))
    return { outcome: "rejected", errorDocument: true };
  if (current?.phase === "acknowledged" && attempt.ok)
    return { outcome: "succeeded", errorDocument: false };
  return { outcome: observedOutcome(current), errorDocument: false };
}
function finish(
  input: JiraChatMutationExecution,
  journal: ChatToolMutationStore,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  const current = journal.find(input.intent.invocationId);
  const { outcome, errorDocument } = settlement(current, attempt);
  try {
    journal.settle(
      input.intent.invocationId,
      outcome,
      jiraLinkCounts(attempt),
      errorDocument ? { jiraErrorDocument: true } : undefined,
    );
  } catch (error) {
    emitServerDiagnostic(undefined, mutationDiagnostic(input.intent, error));
    return result(observedOutcome(current), "unavailable");
  }
  return jiraAttemptToolResult(outcome, attempt);
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
