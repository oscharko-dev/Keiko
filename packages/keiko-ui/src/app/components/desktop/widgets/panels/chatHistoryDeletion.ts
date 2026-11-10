import {
  CLIENT_STAGE_DURATION_MS_MAX,
  type ClientChatHistoryDeletionCounts,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { deleteChat, updateChat } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { Chat } from "@/lib/types";
import { notifyChatDeleted, notifyChatUpsert } from "../../hooks/useChatSession";

const DELETE_CONCURRENCY = 4;
let nextDeletionOrdinal = 0;

export interface ChatHistoryDeletionResult {
  readonly requestedCount: number;
  readonly failedIds: readonly string[];
  readonly detail: string | undefined;
}

function reportDeletion(
  correlationId: string,
  ordinal: number,
  deletion: ClientChatHistoryDeletionCounts,
  startedAt?: number,
): void {
  const stage = "chat history deletion" as const;
  // i18n-exempt: body-free lifecycle evidence, never displayed as product copy.
  const message = `chat history deletion: ${startedAt === undefined ? "started" : "settled"}`;
  const stageReport =
    startedAt === undefined
      ? { stage, phase: "started" as const, ordinal, deletion }
      : {
          stage,
          phase: "settled" as const,
          ordinal,
          deletion,
          durationMs: Math.min(
            Math.round(performance.now() - startedAt),
            CLIENT_STAGE_DURATION_MS_MAX,
          ),
        };
  reportClientDiagnostic(message, { correlationId, stageReport });
}

function recordFailedDeletion(error: unknown, correlationId: string): string {
  // Never log the chat id, project, title, messages or server response body.
  reportClientDiagnostic(`chat history deletion: request failed (${clientErrorSummary(error)})`, {
    correlationId,
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
  return error instanceof Error ? error.message : "Request failed.";
}

/** At most `DELETE_CONCURRENCY` requests in flight; results keep the order of `chats`. */
async function settleBounded<T>(
  chats: readonly Chat[],
  run: (chat: Chat) => Promise<T>,
  offset = 0,
  settled: readonly PromiseSettledResult<T>[] = [],
): Promise<readonly PromiseSettledResult<T>[]> {
  const batch = await Promise.allSettled(chats.slice(offset, offset + DELETE_CONCURRENCY).map(run));
  const all = [...settled, ...batch];
  const nextOffset = offset + DELETE_CONCURRENCY;
  return nextOffset < chats.length ? settleBounded(chats, run, nextOffset, all) : all;
}

function chatsAndResults<T>(
  chats: readonly Chat[],
  results: readonly PromiseSettledResult<T>[],
): readonly (readonly [Chat, PromiseSettledResult<T>])[] {
  return results.flatMap((result, index) => {
    const chat = chats[index];
    return chat === undefined ? [] : [[chat, result] as const];
  });
}

async function deleteBatches(
  chats: readonly Chat[],
  correlationId: string,
  failedIds: string[],
): Promise<string | undefined> {
  const results = await settleBounded(chats, (chat) =>
    deleteChat(chat.id, chat.projectPath, correlationId),
  );
  let detail: string | undefined;
  for (const [chat, result] of chatsAndResults(chats, results)) {
    if (result.status === "fulfilled") {
      notifyChatDeleted(chat.id);
    } else {
      failedIds.push(chat.id);
      detail = recordFailedDeletion(result.reason, correlationId);
    }
  }
  return detail;
}

/** Reuses the scoped, confirmed purge API with bounded concurrency and per-chat settlement. */
export async function deleteHistoryChats(
  chats: readonly Chat[],
): Promise<ChatHistoryDeletionResult> {
  if (chats.length === 0) return { requestedCount: 0, failedIds: [], detail: undefined };
  const correlationId = newClientCorrelationId();
  const ordinal = ++nextDeletionOrdinal;
  const startedAt = performance.now();
  const failedIds: string[] = [];
  reportDeletion(correlationId, ordinal, {
    action: "purge",
    requestedCount: chats.length,
    deletedCount: 0,
    failedCount: 0,
  });
  const detail = await deleteBatches(chats, correlationId, failedIds);
  reportDeletion(
    correlationId,
    ordinal,
    {
      action: "purge",
      requestedCount: chats.length,
      deletedCount: chats.length - failedIds.length,
      failedCount: failedIds.length,
    },
    startedAt,
  );
  return { requestedCount: chats.length, failedIds, detail };
}

export interface ChatHistoryMoveResult {
  readonly moved: readonly Chat[];
  readonly failedIds: readonly string[];
  readonly detail: string | undefined;
}

/**
 * Reversible delete (#4335): marks chats closed so they move to the Deleted tab, where they can be
 * restored. Failures are reported on the existing client diagnostic path, body-free.
 */
export async function moveHistoryChatsToDeleted(
  chats: readonly Chat[],
): Promise<ChatHistoryMoveResult> {
  if (chats.length === 0) return { moved: [], failedIds: [], detail: undefined };
  const correlationId = newClientCorrelationId();
  const ordinal = ++nextDeletionOrdinal;
  const startedAt = performance.now();
  reportDeletion(correlationId, ordinal, {
    action: "move",
    requestedCount: chats.length,
    deletedCount: 0,
    failedCount: 0,
  });
  const results = await settleBounded(chats, (chat) => updateChat(chat.id, { status: "closed" }));
  const moved: Chat[] = [];
  const failedIds: string[] = [];
  let detail: string | undefined;
  for (const [chat, result] of chatsAndResults(chats, results)) {
    if (result.status === "fulfilled") {
      moved.push(result.value.chat);
      // Open windows learn the chat is closed through the existing upsert mutation, the same one
      // that carries every other chat change; the host already treats a closed chat as gone.
      notifyChatUpsert(result.value.chat);
    } else {
      failedIds.push(chat.id);
      detail = recordFailedDeletion(result.reason, correlationId);
    }
  }
  reportDeletion(
    correlationId,
    ordinal,
    {
      action: "move",
      requestedCount: chats.length,
      deletedCount: moved.length,
      failedCount: failedIds.length,
    },
    startedAt,
  );
  return { moved, failedIds, detail };
}
