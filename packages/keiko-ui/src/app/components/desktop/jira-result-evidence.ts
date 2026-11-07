import { useEffect, useRef } from "react";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ClientJiraResultFailure,
  ClientJiraResultPresentation,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { sha256Hex } from "./hooks/canonical-voice-hasher-runtime";
import { jiraToolOutcomeView, JIRA_OUTCOME_ITEMS_SHOWN } from "./jira-tool-outcome";

const FAILURE_KEYS: Readonly<Record<string, ClientJiraResultFailure>> = {
  "chat.jira.outcome.failure.auth": "auth",
  "chat.jira.outcome.failure.permission": "permission",
  "chat.jira.outcome.failure.notFound": "not-found",
  "chat.jira.outcome.failure.rateLimited": "rate-limited",
  "chat.jira.outcome.failure.conflict": "conflict",
  "chat.jira.outcome.failure.transition": "transition",
  "chat.jira.outcome.failure.bounds": "bounds",
  "chat.jira.outcome.failure.response": "response",
  "chat.jira.outcome.failure.fields": "fields",
  "chat.jira.outcome.failure.unavailable": "unavailable",
};
type Counts = Omit<ClientJiraResultPresentation, "messageDigest" | "restored">;
function presentationCounts(exchange: ChatToolExchange): Counts {
  const view = jiraToolOutcomeView(exchange);
  return {
    exchangeCount: 1,
    itemCount: view.items.length,
    shownCount: Math.min(view.items.length, JIRA_OUTCOME_ITEMS_SHOWN),
    returnedCount: view.returnedCount ?? view.items.length,
    unreadableCount: view.unreadableCount,
    problemCount: view.problems.length,
    ruleCount: view.rules.length,
    failure: view.failure === undefined ? "none" : (FAILURE_KEYS[view.failure] ?? "unavailable"),
  };
}
interface ObservedPresentation {
  readonly messageId: string | undefined;
  readonly states: Set<string>;
  live: boolean;
}
function isReadableResult(exchange: ChatToolExchange): boolean {
  return (
    exchange.call.name.startsWith("jira_") &&
    exchange.call.name !== "jira_report" &&
    (exchange.result !== undefined || exchange.draftProgress !== undefined)
  );
}

/** One counted line per distinct live state. Restored terminal history is never replayed. */
export function useJiraResultEvidence(
  transcript: ChatToolTranscript | undefined,
  turnState: ChatTurnState | undefined,
  messageId: string | undefined,
): void {
  const observed = useRef<ObservedPresentation>({
    messageId,
    states: new Set(),
    live: false,
  });
  useEffect(() => {
    if (messageId === undefined || transcript === undefined) return;
    if (observed.current.messageId !== messageId)
      observed.current = { messageId, states: new Set(), live: false };
    const previous = observed.current;
    if (turnState === "pending") previous.live = true;
    const restored = !previous.live;
    const changed = transcript.exchanges.filter(isReadableResult).flatMap((exchange) => {
      const counts = presentationCounts(exchange);
      const state = JSON.stringify([
        exchange.call.id,
        exchange.result?.status,
        exchange.mutationOutcome,
        counts,
      ]);
      if (previous.states.has(state)) return [];
      previous.states.add(state);
      return [counts];
    });
    if (restored) return;
    for (const counts of changed) {
      reportClientDiagnostic("Jira results presented.", {
        jiraResultPresentation: { ...counts, messageDigest: sha256Hex(messageId), restored },
      });
    }
  }, [transcript, turnState, messageId]);
}
