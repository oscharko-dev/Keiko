"use client";

import type { ChatDraft, ChatDraftUpdate } from "@oscharko-dev/keiko-contracts/bff-wire";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

/** The private, revision-checked draft owners the server keeps (ADR-0114 D1). */
export type PrivateDraftSurface = "chat" | "coding-workbench";

function draftPath(surface: PrivateDraftSurface, key: string): string {
  const id = encodeURIComponent(key);
  return surface === "chat" ? `/api/chats/${id}/draft` : `/api/coding-workbench/drafts/${id}`;
}

async function readPrivateDraft(surface: PrivateDraftSurface, key: string): Promise<ChatDraft> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(draftPath(surface, key), {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

async function writePrivateDraft(
  surface: PrivateDraftSurface,
  key: string,
  update: ChatDraftUpdate,
): Promise<ChatDraft> {
  await codingAppSessionPairingSettled();
  const body = JSON.stringify(update);
  return bffFetchJson(draftPath(surface, key), {
    method: "PUT",
    body,
    // Let an admitted save survive page teardown. Oversized drafts retain normal transport
    // and the existing unsaved-change guard instead of exceeding fetch's 64 KiB body cap.
    keepalive: new Blob([body]).size <= 60 * 1024,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

export function readChatDraft(chatId: string): Promise<ChatDraft> {
  return readPrivateDraft("chat", chatId);
}

export function writeChatDraft(chatId: string, update: ChatDraftUpdate): Promise<ChatDraft> {
  return writePrivateDraft("chat", chatId, update);
}

export function readCodingWorkbenchDraft(windowId: string): Promise<ChatDraft> {
  return readPrivateDraft("coding-workbench", windowId);
}

export function writeCodingWorkbenchDraft(
  windowId: string,
  update: ChatDraftUpdate,
): Promise<ChatDraft> {
  return writePrivateDraft("coding-workbench", windowId, update);
}
