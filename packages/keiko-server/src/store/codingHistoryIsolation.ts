import type { Chat, ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatTurnAdmission, UiStore } from "./types.js";
import type { CodingHistoryStore } from "./codingHistory.js";
import { notFound } from "./errors.js";

/** Generic chat routes cannot read or modify content behind the paired Coding History channel. */
export function isolateCodingHistory(store: UiStore, history: CodingHistoryStore): UiStore {
  const ordinary = (id: string): boolean => history.get(id) === undefined;
  const requireOrdinary = (id: string): void => {
    if (!ordinary(id)) throw notFound("Chat");
  };
  return {
    ...store,
    codingHistory: history,
    findChatById: (id) => (ordinary(id) ? store.findChatById(id) : undefined),
    listMessages: (id, limit) => (ordinary(id) ? store.listMessages(id, limit) : []),
    listMessagesPrefix: (id, limit) => (ordinary(id) ? store.listMessagesPrefix(id, limit) : []),
    listGatewayMessages: (id, current, limit) =>
      ordinary(id) ? store.listGatewayMessages(id, current, limit) : [],
    countMessages: (id) => (ordinary(id) ? store.countMessages(id) : 0),
    findMessageById: (id): ChatMessage | undefined => {
      const message = store.findMessageById(id);
      return message === undefined || !ordinary(message.chatId) ? undefined : message;
    },
    updateChat: (id, patch, options): Chat => {
      requireOrdinary(id);
      return store.updateChat(id, patch, options);
    },
    deleteChat: (id): void => {
      requireOrdinary(id);
      store.deleteChat(id);
    },
    createMessage: (message): ChatMessage => {
      requireOrdinary(message.chatId);
      return store.createMessage(message);
    },
    createMessages: (messages): readonly ChatMessage[] => {
      messages.forEach((message) => {
        requireOrdinary(message.chatId);
      });
      return store.createMessages(messages);
    },
    admitChatTurn: (id, message, options): ChatTurnAdmission => {
      requireOrdinary(message.chatId);
      return store.admitChatTurn(id, message, options);
    },
  };
}
