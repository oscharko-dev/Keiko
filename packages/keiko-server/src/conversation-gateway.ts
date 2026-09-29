import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import { isLegacyEmptyAssistantPlaceholder } from "./assistant-response.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatMessageContentPart } from "@oscharko-dev/keiko-contracts";

export interface GatewayConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly contentParts?: readonly ChatMessageContentPart[] | undefined;
}

export const MAX_CONTEXT_MESSAGES = 24;

export function withGatewayConversationImages(
  messages: GatewayConversationMessage[],
  imageParts: readonly ChatMessageContentPart[],
): GatewayConversationMessage[] {
  if (imageParts.length === 0) return messages;
  return messages.map((message, index) =>
    index === messages.length - 1
      ? { ...message, contentParts: [{ type: "text", text: message.content }, ...imageParts] }
      : message,
  );
}

/** Accounting-only shape; attachment bytes are resolved at the authorized provider boundary. */
export function gatewayConversationImageAccounting(
  messages: GatewayConversationMessage[],
  imageCount = 0,
): GatewayConversationMessage[] {
  return withGatewayConversationImages(
    messages,
    Array.from({ length: imageCount }, () => ({
      type: "image_url",
      image_url: { url: "" },
    })),
  );
}

function messageForGateway(
  message: ChatMessage,
): { role: "user" | "assistant"; content: string; stableId: string } | null {
  if (isLegacyEmptyAssistantPlaceholder(message)) {
    return null;
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  return { role: message.role, content: message.content, stableId: message.id };
}

export function usableGatewayTurns(
  messages: readonly ChatMessage[],
): { role: "user" | "assistant"; content: string; stableId: string }[] {
  return messages
    .map(messageForGateway)
    .filter(
      (message): message is NonNullable<ReturnType<typeof messageForGateway>> => message !== null,
    );
}

export function usableGatewayMessages(
  messages: readonly ChatMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return usableGatewayTurns(messages).map(({ role, content }) => ({ role, content }));
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
