import type { ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import type {
  ChatMessage,
  ChatToolExchange,
  ChatToolTranscript,
  DesktopChatStreamReadConsentEvent,
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

/** Older persisted turns carry only one grant; a current list is authoritative. */
export function chatToolReadGrants(
  transcript: ChatToolTranscript | undefined,
): readonly ChatToolReadGrantView[] {
  return (
    transcript?.readGrants ?? (transcript?.readGrant === undefined ? [] : [transcript.readGrant])
  );
}

function updatedReadGrants(
  current: readonly ChatToolReadGrantView[],
  grant: ChatToolReadGrantView,
): readonly ChatToolReadGrantView[] {
  return current.some((entry) => entry.kind === grant.kind)
    ? current.map((entry) => (entry.kind === grant.kind ? grant : entry))
    : [...current, grant];
}

function isStaleReadConsent(
  existing: ChatToolReadGrantView | undefined,
  incoming: ChatToolReadGrantView,
): boolean {
  if (existing === undefined || existing.state === "pending") return false;
  return (
    incoming.state === "pending" || (existing.state !== "granted" && incoming.state === "granted")
  );
}

/** Independent sources retain independent consent; late pending events never reopen consent. */
export function applyChatReadConsent(
  message: ChatMessage,
  event: DesktopChatStreamReadConsentEvent["data"],
): ChatMessage {
  if (message.chatId !== event.grant.chatId) return message;
  if (message.turnState !== undefined && message.turnState !== "pending") return message;
  const grants = chatToolReadGrants(message.toolTranscript);
  const existing = grants.find(
    (grant) => grant.kind === event.grant.kind && grant.grantId === event.grant.grantId,
  );
  if (isStaleReadConsent(existing, event.grant)) return message;
  return {
    ...message,
    id: event.messageId,
    toolTranscript: {
      ...message.toolTranscript,
      schemaVersion: 1,
      exchanges: message.toolTranscript?.exchanges ?? [],
      readGrant: event.grant,
      readGrants: updatedReadGrants(grants, event.grant),
    },
  };
}
