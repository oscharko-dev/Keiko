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
const MCP_OUTCOME_KEYS: Readonly<Record<JiraMutationResultState, WidgetMessageKey>> = {
  "not-dispatched": "chat.mcp.write.notDispatched",
  rejected: "chat.mcp.write.rejected",
  succeeded: "chat.mcp.write.succeeded",
  "succeeded-unconfirmed": "chat.mcp.write.unconfirmed",
  unknown: "chat.mcp.write.unknown",
  pending: "chat.mcp.write.pending",
};
const MANAGED_TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
/** The Chat alias of the local `knowledge.requirements` read (#4179). */
const REQUIREMENTS_TOOL_ALIAS = "knowledge_requirements";
const REQUIREMENTS_CUT_COUNTS = ["unitsOmitted", "documentsOmitted", "documentsNotExtracted"];

/** A draft and an attachment are governed like a create and an edit, but are neither to the human. */
const OPERATION_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  "jira.draft": "chat.jira.draft.operation",
  "jira.attach": "chat.jira.attach.operation",
};
function jiraOperationLabel(operation: keyof typeof JIRA_MANAGED_ACTION_TYPES): WidgetMessageKey {
  return OPERATION_LABELS[operation] ?? actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[operation]);
}
const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0);
/** An edit carrying nothing but links updates no field of the issue. */
function onlyLinks(args: ChatToolExchange["call"]["arguments"]): boolean {
  const links = args.links;
  return Array.isArray(links) && links.length > 0 && isEmpty(args.fields) && isEmpty(args.updates);
}
/** What this one call does to the human, where the operation alone would say something else. */
export function jiraCallLabel(
  operation: keyof typeof JIRA_MANAGED_ACTION_TYPES,
  args: ChatToolExchange["call"]["arguments"],
): WidgetMessageKey {
  return operation === "jira.edit" && onlyLinks(args)
    ? "chat.jira.link.operation"
    : jiraOperationLabel(operation);
}
export function jiraToolLabel(exchange: ChatToolExchange): WidgetMessageKey {
  if (exchange.call.name === REQUIREMENTS_TOOL_ALIAS) return "chat.requirements.tool";
  const operation = MANAGED_TOOLS.find(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
  return operation === undefined
    ? "chat.jira.tool"
    : jiraCallLabel(operation, exchange.call.arguments);
}
export function jiraToolRegionLabel(exchange: ChatToolExchange): WidgetMessageKey {
  if (exchange.call.name === REQUIREMENTS_TOOL_ALIAS) return "chat.requirements.tool";
  return exchange.call.name.startsWith("mcp_") ? "chat.mcp.tool" : "chat.jira.tool";
}
export function jiraToolDetailsLabel(exchange: ChatToolExchange): WidgetMessageKey {
  if (exchange.call.name === REQUIREMENTS_TOOL_ALIAS) return "chat.requirements.details";
  return exchange.call.name.startsWith("mcp_") ? "chat.mcp.details" : "chat.jira.details";
}
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
/** The inventory is cut when the tool's own totals name an omission, or a further page remains. */
type CompletedResult = Extract<NonNullable<ChatToolExchange["result"]>, { status: "completed" }>;
function requirementsCut(result: CompletedResult): boolean {
  const totals = plainRecord(plainRecord(result.data)?.totals);
  const reasons = totals?.cutReasons;
  return (
    result.page.truncated ||
    (Array.isArray(reasons) && reasons.length > 0) ||
    REQUIREMENTS_CUT_COUNTS.some((name) => {
      const value = totals?.[name];
      return typeof value === "number" && value > 0;
    })
  );
}
/** The note a completed read of a partial result carries, or undefined for a complete one. */
export function jiraToolPartialNotice(exchange: ChatToolExchange): WidgetMessageKey | undefined {
  if (exchange.call.name.startsWith("mcp_") || exchange.result?.status !== "completed")
    return undefined;
  if (exchange.call.name === REQUIREMENTS_TOOL_ALIAS)
    return requirementsCut(exchange.result) ? "chat.requirements.partial" : undefined;
  return exchange.result.page.truncated ? "chat.jira.partial" : undefined;
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
  if (exchange.call.name.startsWith("mcp_") && exchange.mutationOutcome !== undefined)
    return MCP_OUTCOME_KEYS[exchange.mutationOutcome];
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
    case "chat.mcp.write.unconfirmed":
      return "chat.mcp.write.unconfirmedHelp";
    case "chat.mcp.write.unknown":
      return "chat.mcp.write.unknownHelp";
    case "chat.mcp.write.pending":
      return "chat.mcp.write.pendingHelp";
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
