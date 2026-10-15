"use client";

import type { ChatDraft, ChatDraftUpdate } from "@oscharko-dev/keiko-contracts/bff-wire";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

export async function readChatDraft(chatId: string): Promise<ChatDraft> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(`/api/chats/${encodeURIComponent(chatId)}/draft`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function writeChatDraft(chatId: string, update: ChatDraftUpdate): Promise<ChatDraft> {
  await codingAppSessionPairingSettled();
  const body = JSON.stringify(update);
  return bffFetchJson(`/api/chats/${encodeURIComponent(chatId)}/draft`, {
    method: "PUT",
    body,
    // Let an admitted save survive page teardown. Oversized drafts retain normal transport
    // and the existing unsaved-change guard instead of exceeding fetch's 64 KiB body cap.
    keepalive: new Blob([body]).size <= 60 * 1024,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}
