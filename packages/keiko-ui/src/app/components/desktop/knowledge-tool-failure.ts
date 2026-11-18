import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isCanonicalKnowledgeToolRef,
  knowledgeStaleSourceReason,
  type KnowledgeStaleSourceReason,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";

const SOURCE_TOOLS: ReadonlySet<string> = new Set(["knowledge_documents", "knowledge_review"]);
const SOURCE_REFUSAL_MESSAGES = {
  "cursor-stale": "chat.knowledge.failure.cursorStale",
  "document-or-cursor-stale": "chat.knowledge.failure.documentOrCursorStale",
  "document-stale-or-out-of-scope": "chat.knowledge.failure.documentStaleOrOutOfScope",
  "source-changed": "chat.knowledge.failure.sourceChanged",
} as const satisfies Readonly<Record<KnowledgeStaleSourceReason, WidgetMessageKey>>;

interface KnowledgeToolFailureView {
  readonly reason: WidgetMessageKey;
  readonly recovery: WidgetMessageKey;
}

/** A canonical refusal earns code-owned guidance, never arbitrary provider nextStep prose. */
export function knowledgeToolFailureView(
  exchange: ChatToolExchange,
): KnowledgeToolFailureView | undefined {
  const { result, call } = exchange;
  if (
    !SOURCE_TOOLS.has(call.name) ||
    !isCanonicalKnowledgeToolRef(call.name, result?.toolRef) ||
    result?.status !== "failed" ||
    result.reason !== "provider-reported-error"
  )
    return undefined;
  const data = result.data;
  if (data?.outcome !== "failed") return undefined;
  const reason = knowledgeStaleSourceReason(data.reason);
  return reason === undefined
    ? undefined
    : { reason: SOURCE_REFUSAL_MESSAGES[reason], recovery: "chat.knowledge.failure.restartSource" };
}
