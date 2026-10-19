import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Chat, ChatCreationIntent } from "./types.js";
import { UiStoreError } from "./errors.js";
import { findChatById } from "./chats.js";
import { withImmediateTransaction } from "./transaction.js";
import { isDesktopChatCreationRequestId } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { correlationIdOrUnknown } from "../correlation.js";

const CHAT_CREATION_INTENT = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.creation.intent",
  category: "setup",
  owner: "keiko-server",
  emitter: "store.chatCreationIntents.logChatCreationIntent",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["created", "reused", "refused", "failed"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-creation-intent"],
  proofIds: ["chat.creation.intent.decision"],
  releaseImpact: "patch",
});

export function logChatCreationIntent(
  outcome: "created" | "reused" | "refused" | "failed",
  correlationId: string | undefined,
): void {
  processServerLogSink().write(
    activityLogEvent(
      CHAT_CREATION_INTENT,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { outcome, completeness: "complete", loss: "none" },
    ),
  );
}

function digest(value: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function creationIdentity(intent: ChatCreationIntent): { key: string; fingerprint: string } {
  if (!isDesktopChatCreationRequestId(intent.requestId)) conflict();
  return {
    key: digest([intent.projectPath, intent.requestId]),
    fingerprint: digest([
      intent.projectPath,
      intent.title,
      intent.requestedModelId ?? null,
      intent.branchLabel ?? "",
    ]),
  };
}

function conflict(): never {
  throw new UiStoreError("INVALID_REQUEST", "The chat creation intent cannot be reused.", 409);
}

function existingChat(
  db: DatabaseSync,
  key: string,
  fingerprint: string,
  projectPath: string,
): Chat | undefined {
  const row = db
    .prepare("SELECT intent_sha256, chat_id FROM chat_creation_intents WHERE request_key = ?")
    .get(key);
  if (row === undefined) return undefined;
  if (row.intent_sha256 !== fingerprint || typeof row.chat_id !== "string") conflict();
  const chat = findChatById(db, row.chat_id);
  if (chat === undefined || chat.status === "closed" || chat.projectPath !== projectPath)
    conflict();
  return chat;
}

/** Recover an already accepted request without repeating current model election or admission. */
export function replayChatCreationIntent(
  db: DatabaseSync,
  intent: ChatCreationIntent,
): Chat | undefined {
  try {
    const { key, fingerprint } = creationIdentity(intent);
    const chat = withImmediateTransaction(db, () =>
      existingChat(db, key, fingerprint, intent.projectPath),
    );
    if (chat !== undefined) logChatCreationIntent("reused", intent.correlationId);
    return chat;
  } catch (error) {
    logChatCreationIntent(
      error instanceof UiStoreError ? "refused" : "failed",
      intent.correlationId,
    );
    throw error;
  }
}

/** Persist the accepted intent with its chat in the existing UiStore transaction. */
export function withChatCreationIntent(
  db: DatabaseSync,
  intent: ChatCreationIntent,
  create: () => Chat,
): Chat {
  try {
    return settleChatCreationIntent(db, intent, create);
  } catch (error) {
    logChatCreationIntent(
      error instanceof UiStoreError ? "refused" : "failed",
      intent.correlationId,
    );
    throw error;
  }
}

function settleChatCreationIntent(
  db: DatabaseSync,
  intent: ChatCreationIntent,
  create: () => Chat,
): Chat {
  const { key, fingerprint } = creationIdentity(intent);
  let outcome: "created" | "reused" = "created";
  const result = withImmediateTransaction(db, () => {
    const existing = existingChat(db, key, fingerprint, intent.projectPath);
    if (existing !== undefined) {
      outcome = "reused";
      return existing;
    }
    const chat = create();
    db.prepare(
      "INSERT INTO chat_creation_intents (request_key, intent_sha256, chat_id) VALUES (?, ?, ?)",
    ).run(key, fingerprint, chat.id);
    return chat;
  });
  logChatCreationIntent(outcome, intent.correlationId);
  return result;
}
