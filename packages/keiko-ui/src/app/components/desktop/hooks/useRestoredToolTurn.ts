"use client";

import { useEffect, useRef } from "react";
import type { Chat, ChatMessage } from "@/lib/types";
import { fetchChatMessages } from "@/lib/api";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";

/** A saved canonical turn is observed only; restoring it never resends a tool or grants consent. */
export function restoredPendingToolTurn(
  messages: readonly ChatMessage[],
  chatId: string | undefined,
): ChatMessage | undefined {
  return messages.findLast(
    (message) =>
      message.chatId === chatId &&
      message.role === "user" &&
      message.turnState === "pending" &&
      message.canonicalTurnRef !== undefined &&
      message.toolTranscript?.exchanges.some(({ approval }) => approval?.chatId === chatId),
  );
}
type Publish = (message: ChatMessage, persisted?: readonly ChatMessage[]) => void;

interface RestoredTurnSnapshot {
  readonly message: ChatMessage;
  readonly persisted?: readonly ChatMessage[];
}
async function restoredTurnSnapshot(
  chat: Chat,
  reference: string,
  signal: AbortSignal,
): Promise<RestoredTurnSnapshot | undefined> {
  const owns = (entry: ChatMessage): boolean =>
    entry.chatId === chat.id && entry.canonicalTurnRef === reference;
  const recent = await fetchChatMessages(chat.id, chat.projectPath, signal, 8);
  let message = recent.messages.find((entry) => owns(entry) && entry.role === "user");
  let full: Awaited<ReturnType<typeof fetchChatMessages>> | undefined;
  if (message === undefined) {
    full = await fetchChatMessages(chat.id, chat.projectPath, signal);
    message = full.messages.find((entry) => owns(entry) && entry.role === "user");
  }
  if (message === undefined) return undefined;
  if (message.turnState === "pending") return { message };
  full ??= await fetchChatMessages(chat.id, chat.projectPath, signal);
  const canonical = full.messages.find((entry) => owns(entry) && entry.role === "user");
  if (canonical?.turnState === undefined || canonical.turnState === "pending") return undefined;
  if (
    canonical.turnState === "completed" &&
    !full.messages.some((entry) => owns(entry) && entry.role === "assistant")
  )
    return undefined;
  return { message: canonical, persisted: full.messages };
}
function observeRestoredTurn(chat: Chat, reference: string, publish: Publish): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let terminal = false;
  const poll = async (): Promise<void> => {
    try {
      const snapshot = await restoredTurnSnapshot(chat, reference, controller.signal);
      if (snapshot !== undefined && !controller.signal.aborted) {
        terminal = snapshot.persisted !== undefined;
        publish(snapshot.message, snapshot.persisted);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        reportClientDiagnostic("Restored chat turn observation failed.", {
          kind: "other",
          correlationId: correlationIdOf(error),
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
    } finally {
      if (!terminal && !controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 1000);
    }
  };
  timer = setTimeout(() => {
    void poll();
  }, 500);
  return (): void => {
    controller.abort();
    clearTimeout(timer);
  };
}

export function useRestoredToolTurn(
  chat: Chat | undefined,
  messages: readonly ChatMessage[],
  ownsSend: boolean,
  publish: Publish,
): void {
  const pending = restoredPendingToolTurn(messages, chat?.id);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const reference = pending?.canonicalTurnRef;
  useEffect(() => {
    if (chat === undefined || reference === undefined || ownsSend) return;
    const initial = pendingRef.current;
    if (initial !== undefined) publish(initial);
    return observeRestoredTurn(chat, reference, publish);
  }, [chat, reference, ownsSend, publish]);
}
