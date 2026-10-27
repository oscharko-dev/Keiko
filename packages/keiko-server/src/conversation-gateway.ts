import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import { isLegacyEmptyAssistantPlaceholder } from "./assistant-response.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatMessageContentPart } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";

export type GatewayConversationMessage = import("@oscharko-dev/keiko-contracts").ChatMessage;
export interface GatewayConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly stableId: string;
  readonly verbatim?: readonly GatewayConversationMessage[] | undefined;
}

/** A stored human turn is the indivisible selection unit, including every call/result pair. */
export function gatewayMessagesForTurn(
  turn: Pick<GatewayConversationTurn, "role" | "content" | "verbatim">,
): GatewayConversationMessage[] {
  return turn.verbatim === undefined
    ? [{ role: turn.role, content: turn.content }]
    : [...turn.verbatim];
}

/** Historical observations never redispatch a call. Keep its remote outcome separate from the
 * catalog settlement, since cancellation cannot roll back an already acknowledged mutation. */
export function gatewayMessagesForToolExchange(
  exchange: ChatToolExchange,
): GatewayConversationMessage[] {
  const result = exchange.result ?? {
    status: "unavailable",
    reason: "observation-unavailable",
    effect: "unknown",
  };
  return [
    { role: "assistant", content: "", toolCalls: [exchange.call] },
    {
      role: "tool",
      toolCallId: exchange.call.id,
      content: JSON.stringify(
        exchange.mutationOutcome === undefined
          ? result
          : { result, mutationOutcome: exchange.mutationOutcome },
      ),
    },
  ];
}

function transcriptMessages(message: ChatMessage): GatewayConversationMessage[] | undefined {
  const exchanges = message.toolTranscript?.exchanges;
  if (exchanges === undefined || exchanges.length === 0) return undefined;
  return [
    { role: message.role, content: message.content },
    ...exchanges.flatMap(gatewayMessagesForToolExchange),
  ];
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

function messageForGateway(message: ChatMessage): GatewayConversationTurn | null {
  if (isLegacyEmptyAssistantPlaceholder(message)) {
    return null;
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  const verbatim = transcriptMessages(message);
  return {
    role: message.role,
    stableId: message.id,
    content:
      verbatim === undefined
        ? message.content
        : `${message.content}\n\n[Untrusted tool observations]\n${JSON.stringify(verbatim.slice(1))}`,
    ...(verbatim === undefined ? {} : { verbatim }),
  };
}

export function usableGatewayTurns(messages: readonly ChatMessage[]): GatewayConversationTurn[] {
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
  const usable = usableGatewayTurns(messages)
    .slice(-MAX_CONTEXT_MESSAGES)
    .flatMap(gatewayMessagesForTurn);
  return [
    {
      role: "system",
      content: CONVERSATION_SYSTEM_PROMPT,
    },
    ...usable,
  ];
}
