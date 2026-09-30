import {
  CLIENT_STAGE_DURATION_MS_MAX,
  type ClientChatHistoryDeletionCounts,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { deleteChat } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { Chat } from "@/lib/types";
import { notifyChatDeleted } from "../../hooks/useChatSession";

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

async function deleteBatch(
  chats: readonly Chat[],
  correlationId: string,
): Promise<ChatHistoryDeletionResult> {
  const failedIds: string[] = [];
  let detail: string | undefined;
  const results = await Promise.allSettled(
    chats.map((chat): Promise<void> => deleteChat(chat.id, chat.projectPath, correlationId)),
  );
  for (const [index, result] of results.entries()) {
    const chat = chats[index];
    if (chat === undefined) continue;
    if (result.status === "fulfilled") {
      notifyChatDeleted(chat.id);
    } else {
      failedIds.push(chat.id);
      detail = recordFailedDeletion(result.reason, correlationId);
    }
  }
  return { requestedCount: chats.length, failedIds, detail };
}

async function deleteBatches(
  chats: readonly Chat[],
  correlationId: string,
  failedIds: string[],
  offset: number,
  detail: string | undefined,
): Promise<string | undefined> {
  const result = await deleteBatch(chats.slice(offset, offset + DELETE_CONCURRENCY), correlationId);
  failedIds.push(...result.failedIds);
  const settledDetail = result.detail ?? detail;
  const nextOffset = offset + DELETE_CONCURRENCY;
  return nextOffset < chats.length
    ? deleteBatches(chats, correlationId, failedIds, nextOffset, settledDetail)
    : settledDetail;
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
    requestedCount: chats.length,
    deletedCount: 0,
    failedCount: 0,
  });
  const detail = await deleteBatches(chats, correlationId, failedIds, 0, undefined);
  reportDeletion(
    correlationId,
    ordinal,
    {
      requestedCount: chats.length,
      deletedCount: chats.length - failedIds.length,
      failedCount: failedIds.length,
    },
    startedAt,
  );
  return { requestedCount: chats.length, failedIds, detail };
}
