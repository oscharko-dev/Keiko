import type {
  CatalogConsumerPort,
  CatalogToolBinderInput,
} from "./tool-catalog/catalogToolPorts.js";
import type { JiraChatCatalogConsumer } from "./atlassian/jiraChatCatalogConsumer.js";
import { KNOWLEDGE_CHAT_TOOLS } from "./requirementsToolName.js";
import {
  resolveCurrentKnowledgeChatAuthority,
  reserveCurrentKnowledgeChatAuthority,
} from "./knowledge-chat-authority.js";
import {
  createLocalChatSourceAdmission,
  localChatSourceConsumerPort,
  type LocalChatSourceAdmissionOptions,
  type LocalChatSourceOwner,
} from "./local-chat-source-consumer.js";

/** Same action/binder contract as the existing local reads, with its own authority owner. */
export const knowledgeChatConsumerPort: CatalogConsumerPort<JiraChatCatalogConsumer> =
  localChatSourceConsumerPort("knowledge-chat");

export const KNOWLEDGE_CHAT_SOURCE_OWNER: LocalChatSourceOwner = {
  reads: new Set<string>(KNOWLEDGE_CHAT_TOOLS),
  resolve: resolveCurrentKnowledgeChatAuthority,
  reserve: reserveCurrentKnowledgeChatAuthority,
};

export function createKnowledgeChatAdmission(
  options: LocalChatSourceAdmissionOptions,
): Pick<CatalogToolBinderInput<JiraChatCatalogConsumer>, "authorityPort" | "approvalPort"> {
  return createLocalChatSourceAdmission(options, KNOWLEDGE_CHAT_SOURCE_OWNER);
}
