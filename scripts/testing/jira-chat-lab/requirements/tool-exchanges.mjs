/**
 * Whether a stored tool exchange is a completed call of the managed Jira `operation`. The call name
 * is the model-facing alias (`jira_draft`), so the result's canonical tool id is what identifies it.
 */
export const completedToolExchange = (exchange, operation) =>
  exchange?.result?.toolRef?.canonicalId === `keiko.${operation}` &&
  exchange.result.status === "completed";

/**
 * Whether a stored tool exchange is any settled call of `operation`, whatever its overall status. A
 * draft that refused some items reports `failed`, yet the states of its other items (`created`,
 * `existing`) are the server's own verified outcomes.
 */
export const toolExchangeOf = (exchange, operation) =>
  exchange?.result?.toolRef?.canonicalId === `keiko.${operation}`;
