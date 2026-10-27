import type { AtlassianConnectorWriteFailureReason } from "./atlassian-connectors.js";

/** Remote effects remain separate from the enclosing MCP/catalog terminal status. */
export const JIRA_MUTATION_OPERATIONS = [
  "jira.create",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.transition",
] as const;
export type JiraMutationOperation = (typeof JIRA_MUTATION_OPERATIONS)[number];
/** Rejected means a known local refusal before dispatch; non-2xx status alone remains unknown. */
export const JIRA_MUTATION_OUTCOMES = [
  "not-dispatched",
  "rejected",
  "succeeded",
  "succeeded-unconfirmed",
  "unknown",
] as const;
export type JiraMutationOutcome = (typeof JIRA_MUTATION_OUTCOMES)[number];

/** Pending means no authoritative final outcome is available, including orphaned records after
 * restart. It neither asserts an active executor nor permits takeover or another dispatch. */
export const JIRA_MUTATION_RESULT_STATES = [...JIRA_MUTATION_OUTCOMES, "pending"] as const;
export type JiraMutationResultState = (typeof JIRA_MUTATION_RESULT_STATES)[number];

/** Validated Jira identities only; remote bodies and headers never become a mutation receipt. */
export interface JiraMutationReceipt {
  readonly issueKey?: string;
  readonly issueId?: string;
  readonly commentId?: string;
  readonly transitionId?: string;
}
export type JiraMutationAttempt =
  | { readonly ok: true; readonly receipt: JiraMutationReceipt }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };
