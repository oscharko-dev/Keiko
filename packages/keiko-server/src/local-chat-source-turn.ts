import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import type { CatalogConsumerPort } from "./tool-catalog/catalogToolPorts.js";
import type {
  JiraChatCatalogConsumer,
  JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { admitChatToolModelCall } from "./chat-tool-approvals.js";
import { ChatToolTurn, bindChatToolCatalog, type ChatToolTurnOptions } from "./chat-tool-turn.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import {
  createLocalChatSourceAdmission,
  type LocalChatSourceOwner,
} from "./local-chat-source-consumer.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";

export interface LocalChatSourceTurnOptions {
  readonly deps: UiHandlerDeps;
  readonly message: ChatMessage;
  readonly authority: {
    readonly envelope: {
      readonly runId: string;
      readonly expiresAt: string;
      readonly budget: ChatToolTurnOptions<JiraChatCatalogContext>["budget"];
    };
    readonly reference: EditorAgentGovernedAuthorityReference;
  };
  readonly managed: ManagedProviderCatalog<JiraChatCatalogConsumer>;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export function localChatSourceTurnContext(
  options: LocalChatSourceTurnOptions,
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

/** What a local source adds to the shared turn: its catalog identity, owner and turn extras. */
export interface LocalChatSourceTurnBinding {
  readonly consumerPort: CatalogConsumerPort<JiraChatCatalogConsumer>;
  readonly owner: LocalChatSourceOwner;
  /** Server-private fields the source's tools read from the invocation context. */
  readonly context?: Partial<JiraChatCatalogContext>;
  readonly turn?: Pick<ChatToolTurnOptions<JiraChatCatalogContext>, "guidance" | "finalizeTurn">;
}

/** One read-only tool turn over a local source's managed catalog. */
export class LocalChatSourceToolTurn extends ChatToolTurn<JiraChatCatalogContext> {
  constructor(
    private readonly sourceOptions: LocalChatSourceTurnOptions,
    private readonly binding: LocalChatSourceTurnBinding,
  ) {
    const { deps, message, managed, correlationId, authority } = sourceOptions;
    super({
      deps,
      message,
      managed,
      correlationId,
      context: { ...localChatSourceTurnContext(sourceOptions), ...binding.context },
      budget: authority.envelope.budget,
      ...binding.turn,
      bind: (context, budgetPort) =>
        bindChatToolCatalog<JiraChatCatalogConsumer>({
          deps,
          managed,
          context,
          budgetPort,
          consumerPort: binding.consumerPort,
          admission: createLocalChatSourceAdmission(
            { deps, context: () => context, now: Date.now },
            binding.owner,
          ),
        }),
    });
  }
  protected override observedMutation(): undefined {
    return undefined;
  }
  protected override admitAuthorityModelCall(): boolean {
    return admitChatToolModelCall(this.sourceOptions, this.binding.owner.reserve);
  }
}
