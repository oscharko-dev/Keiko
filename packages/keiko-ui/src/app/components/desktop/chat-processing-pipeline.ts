import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  type ChatToolExchange,
  type ChatToolTranscript,
  type ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraToolLabel, jiraToolState } from "./jira-tool-presentation";
import { batchStepCount } from "./jira-tool-progress";

export type ChatProcessingState =
  "done" | "active" | "upcoming" | "approval" | "input" | "failed" | "cancelled" | "attention" | "blocked";

export interface ChatProcessingStep {
  readonly id: string;
  readonly label: WidgetMessageKey;
  readonly state: ChatProcessingState;
  readonly toolName?: string;
  /** A counted progress such as `24/131`, shown beside the label while a call counts its work. */
  readonly progress?: string;
}

export const CHAT_PROCESSING_STATE_LABELS: Readonly<Record<ChatProcessingState, WidgetMessageKey>> =
  {
    done: "chat.processing.done",
    active: "chat.processing.active",
    upcoming: "chat.processing.upcoming",
    approval: "chat.processing.approval",
    input: "chat.processing.input",
    failed: "chat.processing.failed",
    cancelled: "chat.processing.cancelled",
    attention: "chat.processing.attention",
    blocked: "chat.processing.blocked",
  };

function approvalState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): ChatProcessingState | undefined {
  if (exchange.result !== undefined || exchange.mutationOutcome !== undefined) return undefined;
  switch (exchange.approval?.state) {
    case "pending":
      return turnState === "pending" ? "approval" : "blocked";
    case "rejected":
    case "expired":
    case "revoked":
      return "blocked";
    default:
      return undefined;
  }
}

const MUTATION_STATES: Partial<Readonly<Record<WidgetMessageKey, ChatProcessingState>>> = {
  "chat.jira.write.succeeded": "done",
  "chat.mcp.write.succeeded": "done",
  "chat.jira.write.unconfirmed": "attention",
  "chat.mcp.write.unconfirmed": "attention",
  "chat.jira.write.unknown": "attention",
  "chat.mcp.write.unknown": "attention",
  "chat.jira.write.notDispatched": "blocked",
  "chat.mcp.write.notDispatched": "blocked",
  "chat.jira.write.rejected": "blocked",
  "chat.mcp.write.rejected": "blocked",
};

function mutationState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): ChatProcessingState | undefined {
  // Remote-effect knowledge wins over an interrupted transport envelope.
  const state = jiraToolState(exchange, turnState);
  const outcome = MUTATION_STATES[state];
  if (outcome !== undefined) return outcome;
  if (
    state === "chat.jira.write.pending" ||
    state === "chat.mcp.write.pending" ||
    exchange.approval?.kind === "mcp-chat-write"
  )
    return turnState === "pending" && exchange.result === undefined ? "active" : "attention";
  return undefined;
}

const PAUSED_INPUT_STATES: ReadonlySet<string | undefined> = new Set(["awaiting-input", "cancelled", "expired"]);
function humanInputState(exchange: ChatToolExchange, turnState: ChatTurnState | undefined): ChatProcessingState | undefined {
  if (exchange.result !== undefined || exchange.mutationOutcome !== undefined) return undefined;
  const state = exchange.humanInput?.state;
  if (!PAUSED_INPUT_STATES.has(state)) return undefined;
  if (turnState === "cancelled" || turnState === "failed") return turnState;
  if (state === "cancelled") return "cancelled";
  return state === "awaiting-input" && turnState === "pending" ? "input" : "blocked";
}

function exchangeState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): ChatProcessingState {
  const governedState = humanInputState(exchange, turnState) ?? approvalState(exchange, turnState) ?? mutationState(exchange, turnState);
  if (governedState !== undefined) return governedState;
  if (exchange.result !== undefined) {
    if (exchange.result.status === "completed") return "done";
    if (exchange.result.status === "denied") return "blocked";
    return exchange.result.status === "cancelled" ? "cancelled" : "failed";
  }
  if (turnState === "pending") return "active";
  return turnState === "cancelled" ? "cancelled" : "attention";
}

const RESPONSE_STATES: Readonly<Record<ChatTurnState, ChatProcessingState>> = {
  pending: "upcoming",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const REQUIREMENTS_VIEWS = new Map<string, WidgetMessageKey>([
  ["documents", "chat.processing.documents"],
  ["change-queries", "chat.processing.changeQueries"],
  ["changes", "chat.processing.changes"],
]);
const DOCUMENT_VIEWS = new Map<string, WidgetMessageKey>([
  ["read", "chat.processing.source"],
  ["search", "chat.processing.search"],
]);

function exchangeLabel(exchange: ChatToolExchange): WidgetMessageKey {
  const view = exchange.call.arguments.view;
  const viewKey = typeof view === "string" ? view : "";
  if (exchange.call.name === "knowledge_requirements")
    return REQUIREMENTS_VIEWS.get(viewKey) ?? "chat.processing.requirements";
  if (exchange.call.name === "knowledge_documents")
    return DOCUMENT_VIEWS.get(viewKey) ?? "chat.processing.documents";
  if (exchange.call.name === "knowledge_review") return "chat.processing.review";
  if (exchange.call.name === CHAT_TOOL_BATCH_TOOL_NAME) return "chat.processing.draftBatch";
  return exchange.call.name.startsWith("mcp_") ? "chat.mcp.tool" : jiraToolLabel(exchange);
}

function needsContinuation(exchanges: readonly ChatToolExchange[], steps: readonly ChatProcessingStep[], turnState: ChatTurnState | undefined): boolean {
  return turnState === "pending" &&
    !steps.some((step) => step.state === "active" || step.state === "approval" || step.state === "input") &&
    !exchanges.some((exchange) => humanInputState(exchange, turnState) !== undefined);
}

/** Only observed calls and the turn lifecycle become steps; a draft never implies a Jira write. */
export function chatProcessingSteps(
  transcript: ChatToolTranscript | undefined,
  turnState: ChatTurnState | undefined,
  showPending: boolean,
  waitingForDecision?: boolean,
): readonly ChatProcessingStep[] {
  const exchanges = transcript?.exchanges ?? [];
  if (exchanges.length === 0 && !(showPending && turnState === "pending")) return [];
  const steps: ChatProcessingStep[] = [
    { id: "request", label: "chat.processing.request", state: "done" },
    ...exchanges.map((exchange): ChatProcessingStep => {
      const state = exchangeState(exchange, turnState);
      const progress = batchStepCount(exchange);
      return {
        ...(progress === undefined ? {} : { progress }),
        id: `tool:${exchange.call.id}`,
        label: exchangeLabel(exchange),
        toolName: exchange.call.name,
        state: waitingForDecision && state === "active" ? "upcoming" : state,
      };
    }),
  ];
  if (needsContinuation(exchanges, steps, turnState))
    steps.push(
      waitingForDecision
        ? { id: "decision", label: "chat.processing.approval", state: "approval" }
        : { id: "continuing", label: "chat.processing.continuing", state: "active" },
    );
  if (turnState !== undefined)
    steps.push({
      id: "response",
      label: "chat.processing.response",
      state: RESPONSE_STATES[turnState],
    });
  return steps;
}
