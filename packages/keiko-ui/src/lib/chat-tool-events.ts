import type {
  ChatMessage,
  ChatToolExchange,
  DesktopChatStreamWriteApprovalEvent,
} from "@oscharko-dev/keiko-contracts/bff-wire";

function mergeExchange(
  exchanges: readonly ChatToolExchange[],
  event: DesktopChatStreamWriteApprovalEvent["data"],
): readonly ChatToolExchange[] {
  const current = exchanges.find((entry) => entry.call.id === event.call.id);
  if (current?.result !== undefined || current?.mutationOutcome !== undefined) return exchanges;
  if (current?.approval !== undefined && current.approval.state !== "pending") return exchanges;
  const next = { ...current, call: event.call, approval: event.approval };
  return current === undefined
    ? [...exchanges, next]
    : exchanges.map((entry) => (entry.call.id === event.call.id ? next : entry));
}
/** A canonical event provides the reviewable call; a late approval never replaces its outcome. */
export function applyChatWriteApproval(
  message: ChatMessage,
  event: DesktopChatStreamWriteApprovalEvent["data"],
): ChatMessage {
  if (message.chatId !== event.approval.chatId) return message;
  if (message.turnState !== undefined && message.turnState !== "pending") return message;
  return {
    ...message,
    id: event.messageId,
    turnState: "pending",
    toolTranscript: {
      ...message.toolTranscript,
      schemaVersion: 1,
      exchanges: mergeExchange(message.toolTranscript?.exchanges ?? [], event),
    },
  };
}
