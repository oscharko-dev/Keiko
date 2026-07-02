import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import { isLegacyEmptyAssistantPlaceholder } from "./assistant-response.js";
import type { ChatMessage } from "./store/index.js";

export interface GatewayConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export const MAX_CONTEXT_MESSAGES = 24;

function messageForGateway(
  message: ChatMessage,
): { role: "user" | "assistant"; content: string } | null {
  if (isLegacyEmptyAssistantPlaceholder(message)) {
    return null;
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  return { role: message.role, content: message.content };
}

export function usableGatewayMessages(
  messages: readonly ChatMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return messages
    .map(messageForGateway)
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } => message !== null,
    );
}

export function conversationForGateway(
  messages: readonly ChatMessage[],
): GatewayConversationMessage[] {
  const usable = usableGatewayMessages(messages).slice(-MAX_CONTEXT_MESSAGES);
  return [
    {
      role: "system",
      content: CONVERSATION_SYSTEM_PROMPT,
    },
    ...usable,
  ];
}
