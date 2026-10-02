import type { Chat } from "@oscharko-dev/keiko-contracts/bff-wire";

/** Whether a chat answers from bound sources (folders or Knowledge Pods) instead of the model alone. */
export function hasGroundingScope(chat: Chat): boolean {
  return (
    chat.connectedScope !== undefined ||
    (chat.connectedScopes?.length ?? 0) > 0 ||
    chat.localKnowledgeScope !== undefined ||
    (chat.localKnowledgeScopes?.length ?? 0) > 0
  );
}
