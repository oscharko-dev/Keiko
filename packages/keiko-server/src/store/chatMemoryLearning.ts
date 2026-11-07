import type { DatabaseSync } from "node:sqlite";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { ConversationMemoryCaptureSurfaceWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { invalidRequest } from "./errors.js";

// #4213: Keiko learns from a Chat later, in passes. The text stays where it is, in the Chat's own
// messages; this store keeps only what a pass needs besides it: whether memory was on when the
// person wrote a message, and how far the Chat has been learned.

/** Where the person's words came from, and the autonomy mode they asked for, when memory was on. */
export interface MemoryLearningMark {
  readonly surface: ConversationMemoryCaptureSurfaceWire;
  readonly mode?: CodingWorkbenchMode | undefined;
}

/** The order of a Chat's messages: by timestamp, then by insertion. */
export interface MemoryLearningPosition {
  readonly timestamp: number;
  readonly rowid: number;
}

/** A message after a Chat's learned position, in Chat order. */
export interface PendingLearningMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly position: MemoryLearningPosition;
  /** Present only when memory was on when the message was written. */
  readonly mark?: MemoryLearningMark | undefined;
}

export interface ChatMemoryLearningStore {
  /** Records that memory was on for this message. Returns false for no such message. */
  readonly markMessage: (messageId: string, mark: MemoryLearningMark) => boolean;
  readonly readPosition: (chatId: string) => MemoryLearningPosition | undefined;
  readonly listPending: (chatId: string, limit: number) => readonly PendingLearningMessage[];
  /** Moves the position forward only; an older position leaves it unchanged. */
  readonly advance: (chatId: string, position: MemoryLearningPosition) => void;
  /** Chats holding a message written with memory on after their position, oldest work first. */
  readonly listChatsWithPending: (limit: number) => readonly string[];
}

interface PendingRow {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
  readonly position_rowid: number;
  readonly memory_learning: string | null;
  readonly memory_learning_mode: string | null;
}

const SQL_MARK = `UPDATE chat_messages SET memory_learning = ?, memory_learning_mode = ? WHERE id = ?`;
const SQL_READ_POSITION = `SELECT learned_timestamp, learned_rowid FROM chat_memory_learning WHERE chat_id = ?`;
const SQL_LIST_PENDING = `
SELECT m.rowid AS position_rowid, m.id, m.role, m.content, m.timestamp, m.memory_learning,
  m.memory_learning_mode
FROM chat_messages m
LEFT JOIN chat_memory_learning l ON l.chat_id = m.chat_id
WHERE m.chat_id = ?
  AND (l.chat_id IS NULL OR m.timestamp > l.learned_timestamp
    OR (m.timestamp = l.learned_timestamp AND m.rowid > l.learned_rowid))
ORDER BY m.timestamp ASC, m.rowid ASC
LIMIT ?`;
// The position never moves back: a pass that finishes after a later one leaves the later position.
const SQL_ADVANCE = `
INSERT INTO chat_memory_learning (chat_id, learned_timestamp, learned_rowid)
SELECT id, ?, ? FROM chats WHERE id = ?
ON CONFLICT(chat_id) DO UPDATE SET learned_timestamp = excluded.learned_timestamp,
  learned_rowid = excluded.learned_rowid
WHERE excluded.learned_timestamp > chat_memory_learning.learned_timestamp
  OR (excluded.learned_timestamp = chat_memory_learning.learned_timestamp
    AND excluded.learned_rowid > chat_memory_learning.learned_rowid)`;
const SQL_LIST_CHATS = `
SELECT m.chat_id, MIN(m.timestamp) AS first_pending
FROM chat_messages m
LEFT JOIN chat_memory_learning l ON l.chat_id = m.chat_id
WHERE m.memory_learning IS NOT NULL AND m.role = 'user'
  AND (l.chat_id IS NULL OR m.timestamp > l.learned_timestamp
    OR (m.timestamp = l.learned_timestamp AND m.rowid > l.learned_rowid))
GROUP BY m.chat_id
ORDER BY first_pending ASC, m.chat_id ASC
LIMIT ?`;

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
}

function storedMark(row: PendingRow): MemoryLearningMark | undefined {
  if (row.memory_learning !== "desktop" && row.memory_learning !== "voice") return undefined;
  const mode =
    row.memory_learning_mode !== null && isCodingWorkbenchMode(row.memory_learning_mode)
      ? row.memory_learning_mode
      : undefined;
  return { surface: row.memory_learning, ...(mode === undefined ? {} : { mode }) };
}

function pendingMessage(row: PendingRow): PendingLearningMessage {
  const mark = storedMark(row);
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    position: { timestamp: row.timestamp, rowid: row.position_rowid },
    ...(mark === undefined ? {} : { mark }),
  };
}

function readPosition(db: DatabaseSync, chatId: string): MemoryLearningPosition | undefined {
  const row = db.prepare(SQL_READ_POSITION).get(chatId) as
    { readonly learned_timestamp: number; readonly learned_rowid: number } | undefined;
  return row === undefined
    ? undefined
    : { timestamp: row.learned_timestamp, rowid: row.learned_rowid };
}

export function createChatMemoryLearningStore(db: DatabaseSync): ChatMemoryLearningStore {
  return {
    markMessage: (messageId, mark): boolean =>
      Number(db.prepare(SQL_MARK).run(mark.surface, mark.mode ?? null, messageId).changes) > 0,
    readPosition: (chatId) => readPosition(db, chatId),
    listPending: (chatId, limit): readonly PendingLearningMessage[] => {
      assertLimit(limit);
      return (db.prepare(SQL_LIST_PENDING).all(chatId, limit) as unknown as PendingRow[]).map(
        pendingMessage,
      );
    },
    advance: (chatId, position): void => {
      db.prepare(SQL_ADVANCE).run(position.timestamp, position.rowid, chatId);
    },
    listChatsWithPending: (limit): readonly string[] => {
      assertLimit(limit);
      return (db.prepare(SQL_LIST_CHATS).all(limit) as { readonly chat_id: string }[]).map(
        (row) => row.chat_id,
      );
    },
  };
}
