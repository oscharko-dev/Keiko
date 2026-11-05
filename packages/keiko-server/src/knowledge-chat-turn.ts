import { reserveChatToolPrompt } from "./chat-tool-approvals.js";
import { ChatToolTurn, bindChatToolCatalog, chatModelSupportsTools } from "./chat-tool-turn.js";
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
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { chatKnowledgeScopes } from "./requirement-inventory.js";
import { ConversationModelNotReadyError } from "./conversation-readiness-admission.js";
import { logConversationAdmission } from "./conversation-readiness-log.js";
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
  protected override reserveAuthorityPrompt(promptTokens: number): boolean {
    return reserveChatToolPrompt(
      this.knowledgeOptions,
      reserveCurrentKnowledgeChatAuthority,
      promptTokens,
    );
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
  const correlation = correlationIdOrUnknown(correlationId);
  if (!chatModelSupportsTools(deps, modelId)) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission("observation-unavailable", correlation, generation, generation);
    throw new ConversationModelNotReadyError("tool-calling");
  }
  const authority = mintAcceptedKnowledgeChatAuthority(deps, {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId: correlation,
  });
  requireDispatch(
    authority.ok && deps.knowledgeChatCatalog !== undefined,
    "denied",
    "authority-invalid",
  );
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  return new KnowledgeChatToolTurn({
    deps,
    message,
    authority,
    managed: await deps.knowledgeChatCatalog.get(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
    correlationId: correlation,
  });
}
