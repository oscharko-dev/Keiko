import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_RESULT_STATES,
  type JiraMutationResultState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { actionTypeLabelKey } from "./widgets/connectors/connector-labels";

const OUTCOME_KEYS: Readonly<Record<JiraMutationResultState, WidgetMessageKey>> = {
  "not-dispatched": "chat.jira.write.notDispatched",
  rejected: "chat.jira.write.rejected",
  succeeded: "chat.jira.write.succeeded",
  "succeeded-unconfirmed": "chat.jira.write.unconfirmed",
  unknown: "chat.jira.write.unknown",
  pending: "chat.jira.write.pending",
};
const MANAGED_TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];

export function jiraToolLabel(exchange: ChatToolExchange): WidgetMessageKey {
  const operation = MANAGED_TOOLS.find(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
  return operation === undefined
    ? "chat.jira.tool"
    : actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[operation]);
}
function mutationOutcome(exchange: ChatToolExchange): JiraMutationResultState | undefined {
  const data = exchange.result?.data;
  const value =
    data !== null && typeof data === "object" && "outcome" in data ? data.outcome : undefined;
  return JIRA_MUTATION_RESULT_STATES.find(
    (outcome) => outcome === (exchange.mutationOutcome ?? value),
  );
}
function isMutation(exchange: ChatToolExchange): boolean {
  return JIRA_MUTATION_OPERATIONS.some(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
}
export function jiraToolState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): WidgetMessageKey {
  if (isMutation(exchange)) {
    const outcome = mutationOutcome(exchange);
    if (outcome !== undefined) return OUTCOME_KEYS[outcome];
    return exchange.result === undefined && turnState === "pending"
      ? OUTCOME_KEYS.pending
      : OUTCOME_KEYS.unknown;
  }
  if (exchange.result === undefined)
    return turnState === "pending" ? "chat.jira.running" : "chat.jira.resultUnavailable";
  return exchange.result.status === "completed" ? "chat.jira.complete" : "chat.jira.unavailable";
}
export function jiraToolOutcomeHelp(state: WidgetMessageKey): WidgetMessageKey | undefined {
  switch (state) {
    case "chat.jira.write.unconfirmed":
      return "chat.jira.write.unconfirmedHelp";
    case "chat.jira.write.unknown":
      return "chat.jira.write.unknownHelp";
    case "chat.jira.write.pending":
      return "chat.jira.write.pendingHelp";
    default:
      return undefined;
  }
}
