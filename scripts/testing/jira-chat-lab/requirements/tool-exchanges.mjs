import { jiraMutationToolId } from "../../../../packages/keiko-server/dist/atlassian/jiraMutationToolId.js";

/**
 * The canonical tool id the product binds to a managed Jira or Knowledge operation. Reads and
 * mutations share the product's one formula (`jira.issue-types` is `keiko.jira.issue.types`), so
 * the lab derives it from the product instead of restating it.
 */
export const canonicalToolId = (operation) => jiraMutationToolId(operation);

/**
 * Whether a stored tool exchange is a completed call of the managed Jira `operation`. The call name
 * is the model-facing alias (`jira_draft`), so the result's canonical tool id is what identifies it.
 */
export const completedToolExchange = (exchange, operation) =>
  exchange?.result?.toolRef?.canonicalId === canonicalToolId(operation) &&
  exchange.result.status === "completed";

/**
 * Whether a stored tool exchange is any settled call of `operation`, whatever its overall status. A
 * draft that refused some items reports `failed`, yet the states of its other items (`created`,
 * `existing`) are the server's own verified outcomes.
 */
export const toolExchangeOf = (exchange, operation) =>
  exchange?.result?.toolRef?.canonicalId === canonicalToolId(operation);
