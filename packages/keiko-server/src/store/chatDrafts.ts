import type { DatabaseSync } from "node:sqlite";
import {
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  MAX_DESKTOP_CHAT_INPUT_CHARS,
  type ChatDraft,
  type ChatDraftUpdate,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { invalidRequest, notFound, UiStoreError } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";

// A Coding Workbench window id as `nextWindowId` mints it (`coding-workbench-<base36>[-<n>]`). The
// draft key is a closed, bounded token, never a path or free text.
const CODING_WORKBENCH_WINDOW_ID = /^coding-workbench-[0-9a-z]{1,16}(?:-[0-9a-z]{1,8})?$/u;

function storedDraft(row: Record<string, unknown> | undefined, label: string): ChatDraft {
  if (row === undefined) return { text: "", revision: 0 };
  if (typeof row.text !== "string" || typeof row.revision !== "number")
    throw new UiStoreError("INTERNAL", `Stored ${label} is invalid.`, 500);
  return { text: row.text, revision: row.revision };
}

function assertDraftUpdate(update: ChatDraftUpdate): void {
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
}

/** One revision-checked write for every private draft owner (ADR-0114 D1). */
function compareAndSwapDraft(
  db: DatabaseSync,
  update: ChatDraftUpdate,
  read: () => ChatDraft,
  write: (text: string, revision: number) => void,
): ChatDraft {
  assertDraftUpdate(update);
  return withImmediateTransaction(db, () => {
    const current = read();
    if (current.revision !== update.expectedRevision)
      throw new UiStoreError("INVALID_REQUEST", "The draft revision is stale.", 409);
    // Keep an empty row as a revision tombstone, so stale tabs cannot resurrect sent text.
    const revision = current.revision + 1;
    write(update.text, revision);
    return { text: update.text, revision };
  });
}

/** Reuses the private UiStore database; drafts never enter chat lists, messages or evidence. */
export function readChatDraft(db: DatabaseSync, chatId: string): ChatDraft {
  if (db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId) === undefined)
    throw notFound("Chat");
  return storedDraft(
    db.prepare("SELECT text, revision FROM chat_drafts WHERE chat_id = ?").get(chatId),
    "chat draft",
  );
}

export function updateChatDraft(
  db: DatabaseSync,
  chatId: string,
  update: ChatDraftUpdate,
): ChatDraft {
  return compareAndSwapDraft(
    db,
    update,
    () => readChatDraft(db, chatId),
    (text, revision) => {
      db.prepare(
        `INSERT INTO chat_drafts (chat_id, text, revision) VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET text = excluded.text, revision = excluded.revision`,
      ).run(chatId, text, revision);
    },
  );
}

function assertCodingWorkbenchWindowId(windowId: string): void {
  if (!CODING_WORKBENCH_WINDOW_ID.test(windowId)) throw notFound("Coding Workbench draft");
}

/**
 * The unsent Coding Workbench composer text of one Workbench window, so a reload during a start
 * or before a follow-up restores it. Keyed by the window id the persisted workspace layout keeps.
 */
export function readCodingWorkbenchDraft(db: DatabaseSync, windowId: string): ChatDraft {
  assertCodingWorkbenchWindowId(windowId);
  return storedDraft(
    db
      .prepare("SELECT text, revision FROM coding_workbench_drafts WHERE window_id = ?")
      .get(windowId),
    "Coding Workbench draft",
  );
}

export function updateCodingWorkbenchDraft(
  db: DatabaseSync,
  windowId: string,
  update: ChatDraftUpdate,
): ChatDraft {
  return compareAndSwapDraft(
    db,
    update,
    () => readCodingWorkbenchDraft(db, windowId),
    (text, revision) => {
      db.prepare(
        `INSERT INTO coding_workbench_drafts (window_id, text, revision) VALUES (?, ?, ?)
        ON CONFLICT(window_id) DO UPDATE SET text = excluded.text, revision = excluded.revision`,
      ).run(windowId, text, revision);
    },
  );
}
