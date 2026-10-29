import type {
  JiraChatToolAuthoritySubject,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage } from "../store/index.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import type { JiraChatCatalogAction } from "./jiraChatCatalogConsumer.js";
import { jiraChatWriteAction } from "./jiraChatCatalogWrite.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";

export function createJiraChatMutationIntent(
  message: ChatMessage,
  subject: JiraChatToolAuthoritySubject,
  authority: EditorAgentGovernedAuthorityReference,
  action: JiraChatCatalogAction,
  correlationId: string,
): ChatToolMutationIntent {
  const write = jiraChatWriteAction(action);
  requireDispatch(
    write !== undefined &&
      message.chatId === subject.chatId &&
      message.canonicalTurnRef !== undefined,
    "denied",
    "authority-invalid",
  );
  return {
    invocationId: write.invocationId,
    chatId: message.chatId,
    userMessageId: message.id,
    turnRef: message.canonicalTurnRef,
    actorId: subject.actorDigest,
    podId: subject.podId,
    bindingGeneration: subject.bindingGeneration,
    credentialGeneration: subject.authenticationGeneration,
    authorityDigest: authority.envelopeDigest,
    actionDigest: write.actionDigest,
    operation: write.operation,
    correlationId,
  };
}
