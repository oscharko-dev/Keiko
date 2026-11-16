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
export async function restoredTurnSnapshot(
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
/** Poll spacing is 1 s for 14 polls, then 2 s, 4 s and 8 s for 15 polls each, then holds at 10 s. */
const RESTORED_TURN_POLL_BASE_MS = 1000;
const RESTORED_TURN_POLL_MAX_DELAY_MS = 10_000;
const RESTORED_TURN_POLLS_PER_STEP = 15;
/**
 * Hard guard. The schedule above spans about 13.75 minutes, longer than the 10 minute approval
 * lifetime that bounds a held worker, so a live review is always observed to its end. The server
 * settles a turn whose worker died (database recovery fails every pending turn), which ends the
 * observation as a terminal state; this cap only covers an unreachable or silent server.
 */
export const RESTORED_TURN_POLL_MAX_ATTEMPTS = 120;

export function restoredTurnPollDelayMs(attempt: number): number {
  return Math.min(
    RESTORED_TURN_POLL_MAX_DELAY_MS,
    RESTORED_TURN_POLL_BASE_MS * 2 ** Math.floor(attempt / RESTORED_TURN_POLLS_PER_STEP),
  );
}

function reportObservationAbandoned(onAbandoned: () => void): void {
  reportClientDiagnostic("Restored chat turn observation gave up.", { kind: "other" });
  onAbandoned();
}

function observeRestoredTurn(
  chat: Chat,
  reference: string,
  publish: Publish,
  onAbandoned: () => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let terminal = false;
  let attempts = 0;
  const poll = async (): Promise<void> => {
    attempts += 1;
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
      if (!terminal && !controller.signal.aborted) {
        if (attempts >= RESTORED_TURN_POLL_MAX_ATTEMPTS) reportObservationAbandoned(onAbandoned);
        else
          timer = setTimeout(() => {
            void poll();
          }, restoredTurnPollDelayMs(attempts));
      }
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
  onAbandoned: () => void,
): void {
  const pending = restoredPendingToolTurn(messages, chat?.id);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const reference = pending?.canonicalTurnRef;
  useEffect(() => {
    if (chat === undefined || reference === undefined || ownsSend) return;
    const initial = pendingRef.current;
    if (initial !== undefined) publish(initial);
    return observeRestoredTurn(chat, reference, publish, onAbandoned);
  }, [chat, reference, ownsSend, publish, onAbandoned]);
}
