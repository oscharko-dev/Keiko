/** Remote effects remain separate from the enclosing MCP/catalog terminal status. */
export const JIRA_MUTATION_OPERATIONS = [
  "jira.create",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.transition",
] as const;
export type JiraMutationOperation = (typeof JIRA_MUTATION_OPERATIONS)[number];
export const JIRA_MUTATION_OUTCOMES = [
  "not-dispatched",
  "rejected",
  "succeeded",
  "succeeded-unconfirmed",
  "unknown",
] as const;
export type JiraMutationOutcome = (typeof JIRA_MUTATION_OUTCOMES)[number];
