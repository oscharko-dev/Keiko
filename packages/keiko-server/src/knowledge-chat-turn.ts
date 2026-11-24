import { mintAndBoundChatTurn } from "./chat-tool-turn.js";
import { mintAcceptedKnowledgeChatAuthority } from "./knowledge-chat-authority.js";
import {
  KNOWLEDGE_CHAT_SOURCE_OWNER,
  knowledgeChatConsumerPort,
} from "./knowledge-chat-consumer.js";
import type {
  JiraChatCatalogConsumer,
  JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { LocalChatSourceToolTurn, localChatSourceTurnContext } from "./local-chat-source-turn.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { chatKnowledgeScopes } from "./requirement-inventory.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";

export interface KnowledgeChatTurnOptions {
  readonly deps: UiHandlerDeps;
  readonly message: ChatMessage;
  readonly authority: Extract<ReturnType<typeof mintAcceptedKnowledgeChatAuthority>, { ok: true }>;
  readonly managed: ManagedProviderCatalog<JiraChatCatalogConsumer>;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}
export function knowledgeChatTurnContext(
  options: KnowledgeChatTurnOptions,
): JiraChatCatalogContext {
  return localChatSourceTurnContext(options);
}
export class KnowledgeChatToolTurn extends LocalChatSourceToolTurn {
  constructor(options: KnowledgeChatTurnOptions) {
    super(options, { consumerPort: knowledgeChatConsumerPort, owner: KNOWLEDGE_CHAT_SOURCE_OWNER });
  }
}
export async function createKnowledgeChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<KnowledgeChatToolTurn | undefined> {
  if (chatKnowledgeScopes(deps.store.findChatById(message.chatId)).length === 0) return undefined;
  if (deps.knowledgeChatCatalog === undefined) return undefined;
  const correlation = correlationIdOrUnknown(correlationId);
  const managed = await deps.knowledgeChatCatalog.get();
  const bound = mintAndBoundChatTurn<KnowledgeChatTurnOptions["authority"]>(
    deps,
    modelId,
    message,
    correlation,
    (turn) => mintAcceptedKnowledgeChatAuthority(deps, turn),
    [signal],
  );
  return new KnowledgeChatToolTurn({
    deps,
    message,
    ...bound,
    managed,
    correlationId: correlation,
  });
}
