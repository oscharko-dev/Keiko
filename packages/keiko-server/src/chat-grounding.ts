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

/** The buffered grounded owner also runs Jira tools when both source kinds are bound. */
export function hasMixedJiraGroundingScope(chat: Chat): boolean {
  return chat.jiraPodBinding !== undefined && hasGroundingScope(chat);
}

/** Mixed tool/source turns share the existing buffered grounding and synthesis budget owner. */
export function hasMixedToolGroundingScope(chat: Chat, configuredMcp: boolean): boolean {
  return hasGroundingScope(chat) && (chat.jiraPodBinding !== undefined || configuredMcp);
}
