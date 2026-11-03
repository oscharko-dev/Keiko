import type { DatabaseSync } from "node:sqlite";
import {
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  MAX_DESKTOP_CHAT_INPUT_CHARS,
  type ChatDraft,
  type ChatDraftUpdate,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { invalidRequest, notFound, UiStoreError } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";

/** Reuses the private UiStore database; drafts never enter chat lists, messages or evidence. */
export function readChatDraft(db: DatabaseSync, chatId: string): ChatDraft {
  if (db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId) === undefined)
    throw notFound("Chat");
  const row = db.prepare("SELECT text, revision FROM chat_drafts WHERE chat_id = ?").get(chatId);
  if (row === undefined) return { text: "", revision: 0 };
  if (typeof row.text !== "string" || typeof row.revision !== "number")
    throw new UiStoreError("INTERNAL", "Stored chat draft is invalid.", 500);
  return { text: row.text, revision: row.revision };
}

export function updateChatDraft(
  db: DatabaseSync,
  chatId: string,
  update: ChatDraftUpdate,
): ChatDraft {
  if (
    !Number.isSafeInteger(update.expectedRevision) ||
    update.expectedRevision < 0 ||
    update.expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    throw invalidRequest("Invalid draft revision.");
  if (
    update.text.length > MAX_DESKTOP_CHAT_INPUT_CHARS ||
    Buffer.byteLength(update.text, "utf8") > MAX_DESKTOP_CHAT_INPUT_BYTES
  )
    throw invalidRequest("The draft exceeds the message size limit.");
  return withImmediateTransaction(db, () => {
    const current = readChatDraft(db, chatId);
    if (current.revision !== update.expectedRevision)
      throw new UiStoreError("INVALID_REQUEST", "The draft revision is stale.", 409);
    // Keep an empty row as a revision tombstone, so stale tabs cannot resurrect sent text.
    const revision = current.revision + 1;
    db.prepare(
      `INSERT INTO chat_drafts (chat_id, text, revision) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET text = excluded.text, revision = excluded.revision`,
    ).run(chatId, update.text, revision);
    return { text: update.text, revision };
  });
}
