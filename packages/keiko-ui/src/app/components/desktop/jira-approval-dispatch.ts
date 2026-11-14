import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";

/**
 * Whether a write approval's card may say that nothing was changed in Jira (#4355 AC5). Only closed
 * evidence that no write was dispatched counts: the producer's own not-dispatched refusal, or a turn
 * that ended while the stored approval still waited and nothing ran. The clock never decides it: a
 * stored `approved` or `claimed` approval may belong to a write that ran, whatever `expiresAt` says.
 */
export type JiraApprovalDispatch = "not-dispatched" | "unknown";

function outcomeOf(result: NonNullable<ChatToolExchange["result"]>): unknown {
  const data: unknown = result.data;
  return typeof data === "object" && data !== null && "outcome" in data ? data.outcome : undefined;
}
/** Stored states a write can never have followed: the approval ended before any dispatch. */
const NEVER_DISPATCHED: ReadonlySet<string> = new Set(["expired", "rejected", "revoked"]);

export function jiraApprovalDispatch(input: {
  readonly approval: ChatToolWriteApprovalView;
  readonly result: ChatToolExchange["result"];
  readonly turnState: ChatTurnState | undefined;
}): JiraApprovalDispatch {
  const { approval, result, turnState } = input;
  if (result !== undefined)
    return outcomeOf(result) === "not-dispatched" ? "not-dispatched" : "unknown";
  if (approval.state === "pending")
    return turnState !== undefined && turnState !== "pending" ? "not-dispatched" : "unknown";
  return NEVER_DISPATCHED.has(approval.state) ? "not-dispatched" : "unknown";
}
