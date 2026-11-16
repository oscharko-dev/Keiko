import { admitChatToolModelCall } from "./chat-tool-approvals.js";
import { ChatToolTurn, bindChatToolCatalog, mintAndBoundChatTurn } from "./chat-tool-turn.js";
import {
  mintAcceptedKnowledgeChatAuthority,
  reserveCurrentKnowledgeChatAuthority,
} from "./knowledge-chat-authority.js";
import {
  createKnowledgeChatAdmission,
  knowledgeChatConsumerPort,
} from "./knowledge-chat-consumer.js";
import type {
  JiraChatCatalogConsumer,
  JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
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
  const { authority, message, signal, correlationId } = options;
  return {
    runId: authority.envelope.runId,
    correlationId,
    chatId: message.chatId,
    userMessageId: message.id,
    authority: authority.reference.envelopeDigest,
    authorityReference: authority.reference,
    authorityExpiresAt: authority.envelope.expiresAt,
    deadlineAt: authority.envelope.expiresAt,
    signal,
  };
}
export class KnowledgeChatToolTurn extends ChatToolTurn<JiraChatCatalogContext> {
  constructor(private readonly knowledgeOptions: KnowledgeChatTurnOptions) {
    const { deps, message, managed, correlationId, authority } = knowledgeOptions;
    super({
      deps,
      message,
      managed,
      correlationId,
      context: knowledgeChatTurnContext(knowledgeOptions),
      budget: authority.envelope.budget,
      bind: (context, budgetPort) =>
        bindChatToolCatalog<JiraChatCatalogConsumer>({
          deps,
          managed,
          context,
          budgetPort,
          consumerPort: knowledgeChatConsumerPort,
          admission: createKnowledgeChatAdmission({ deps, context: () => context, now: Date.now }),
        }),
    });
  }
  protected override observedMutation(): undefined {
    return undefined;
  }
  protected override admitAuthorityModelCall(): boolean {
    return admitChatToolModelCall(this.knowledgeOptions, reserveCurrentKnowledgeChatAuthority);
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
