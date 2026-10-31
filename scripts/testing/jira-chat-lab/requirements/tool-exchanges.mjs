/**
 * Whether a stored tool exchange is a completed call of the managed Jira `operation`. The call name
 * is the model-facing alias (`jira_draft`), so the result's canonical tool id is what identifies it.
 */
export const completedToolExchange = (exchange, operation) =>
  exchange?.result?.toolRef?.canonicalId === `keiko.${operation}` &&
  exchange.result.status === "completed";
