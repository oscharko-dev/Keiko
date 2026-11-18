import type { DatabaseSync, StatementSync } from "node:sqlite";
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

export interface PendingLearningChat {
  readonly chatId: string;
  readonly firstPendingTimestamp: number;
}

export interface ChatMemoryLearningStore {
  /** Records that memory was on for this message. Returns false for no such message. */
  readonly markMessage: (messageId: string, mark: MemoryLearningMark) => boolean;
  readonly readPosition: (chatId: string) => MemoryLearningPosition | undefined;
  readonly listPending: (chatId: string, limit: number) => readonly PendingLearningMessage[];
  /** Reads only the immediate preceding user message, and only if it was marked for learning. */
  readonly readPreviousUserText: (chatId: string, messageId: string) => string | undefined;
  /** Moves the position forward only; an older position leaves it unchanged. */
  readonly advance: (chatId: string, position: MemoryLearningPosition) => void;
  /** Chats holding a message written with memory on after their position, oldest work first. */
  readonly listChatsWithPending: (limit: number) => readonly string[];
  readonly listPendingChats: (
    limit: number,
    after?: PendingLearningChat,
  ) => readonly PendingLearningChat[];
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
// Seek directly to each pending range in the Chat's (timestamp, rowid) order. Keeping equal
// timestamps separate also bounds work when an import gave every message the same timestamp.
const SQL_LIST_PENDING = `
WITH cursor AS (
  SELECT learned_timestamp, learned_rowid FROM chat_memory_learning WHERE chat_id = ?1
), page AS (
  SELECT rowid AS position_rowid, timestamp FROM chat_messages
  WHERE chat_id = (SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM cursor))
  UNION ALL
  SELECT rowid, timestamp FROM chat_messages
  WHERE chat_id = ?1 AND timestamp = (SELECT learned_timestamp FROM cursor)
    AND rowid > (SELECT learned_rowid FROM cursor)
  UNION ALL
  SELECT rowid, timestamp FROM chat_messages
  WHERE chat_id = ?1 AND timestamp > (SELECT learned_timestamp FROM cursor)
  ORDER BY timestamp, position_rowid LIMIT ?2
)
SELECT page.position_rowid, m.id, m.role, m.content, page.timestamp, m.memory_learning,
  m.memory_learning_mode
FROM page JOIN chat_messages m ON m.rowid = page.position_rowid
ORDER BY page.timestamp, page.position_rowid`;
// Find the immediately preceding user by rowid within this timestamp, then by earlier timestamp.
// Inspect the mark on that row only: an unmarked user turn is a consent barrier.
const SQL_READ_PREVIOUS_USER_TEXT = `
SELECT CASE WHEN previous.memory_learning IS NOT NULL THEN previous.content END AS content
FROM chat_messages current
JOIN chat_messages previous ON previous.rowid = COALESCE(
  (SELECT p.rowid FROM chat_messages p
   WHERE p.chat_id = current.chat_id AND p.role = 'user'
     AND p.timestamp = current.timestamp AND p.rowid < current.rowid
   ORDER BY p.rowid DESC LIMIT 1),
  (SELECT p.rowid FROM chat_messages p
   WHERE p.chat_id = current.chat_id AND p.role = 'user' AND p.timestamp < current.timestamp
   ORDER BY p.timestamp DESC, p.rowid DESC LIMIT 1))
WHERE current.chat_id = ? AND current.id = ? AND current.role = 'user'`;
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
HAVING ?1 IS NULL OR (MIN(m.timestamp), m.chat_id) > (?1, ?2)
ORDER BY first_pending ASC, m.chat_id ASC
LIMIT ?3`;

// Probe at most one more marked chat than the seek path admits. A wider queue keeps the
// existing grouped scan; small queues seek past each durable position without reading history.
const PENDING_CHAT_SEEK_LIMIT = 256;
const SQL_PENDING_CHAT_KEY_COUNT = `WITH RECURSIVE keys(chat_id) AS (
 SELECT MIN(chat_id) FROM chat_messages WHERE memory_learning IS NOT NULL
 UNION ALL SELECT (SELECT MIN(m.chat_id) FROM chat_messages m
 WHERE m.memory_learning IS NOT NULL AND m.chat_id>keys.chat_id)
 FROM keys WHERE chat_id IS NOT NULL LIMIT ${String(PENDING_CHAT_SEEK_LIMIT + 1)}
) SELECT CASE WHEN EXISTS(SELECT 1 FROM chat_memory_learning)
 THEN (SELECT COUNT(*) FROM keys WHERE chat_id IS NOT NULL) ELSE 0 END AS chat_count`;
const SQL_LIST_CHATS_SEEK = `WITH RECURSIVE keys(chat_id) AS (
 SELECT MIN(chat_id) FROM chat_messages WHERE memory_learning IS NOT NULL
 UNION ALL SELECT (SELECT MIN(m.chat_id) FROM chat_messages m
 WHERE m.memory_learning IS NOT NULL AND m.chat_id>keys.chat_id)
 FROM keys WHERE chat_id IS NOT NULL
), pending AS MATERIALIZED (
 SELECT c.chat_id,CASE WHEN l.chat_id IS NULL THEN (
 SELECT m.timestamp FROM chat_messages m WHERE m.chat_id=c.chat_id
 AND m.memory_learning IS NOT NULL AND m.role='user'
 ORDER BY m.timestamp,m.rowid LIMIT 1
 ) ELSE (
 SELECT m.timestamp FROM chat_messages m WHERE m.chat_id=c.chat_id
 AND m.memory_learning IS NOT NULL AND m.role='user'
 AND (m.timestamp,m.rowid)>(l.learned_timestamp,l.learned_rowid)
 ORDER BY m.timestamp,m.rowid LIMIT 1
 ) END AS first_pending FROM keys c
 LEFT JOIN chat_memory_learning l ON l.chat_id=c.chat_id WHERE c.chat_id IS NOT NULL
) SELECT chat_id,first_pending FROM pending WHERE first_pending IS NOT NULL
 AND (?1 IS NULL OR (first_pending,chat_id)>(?1,?2))
 ORDER BY first_pending,chat_id LIMIT ?3`;

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

function listPendingChats(
  statement: () => StatementSync,
  limit: number,
  after?: PendingLearningChat,
): readonly PendingLearningChat[] {
  assertLimit(limit);
  const rows = statement().all(
    after?.firstPendingTimestamp ?? null,
    after?.chatId ?? null,
    limit,
  ) as {
    readonly chat_id: string;
    readonly first_pending: number;
  }[];
  return rows.map((row) => ({ chatId: row.chat_id, firstPendingTimestamp: row.first_pending }));
}

export function createChatMemoryLearningStore(db: DatabaseSync): ChatMemoryLearningStore {
  let pendingPage: StatementSync | undefined;
  let previousUser: StatementSync | undefined;
  let pendingChats: StatementSync | undefined;
  let pendingChatSeeks: StatementSync | undefined;
  let pendingChatKeys: StatementSync | undefined;
  const pendingChatsStatement = (): StatementSync => {
    pendingChatKeys ??= db.prepare(SQL_PENDING_CHAT_KEY_COUNT);
    const { chat_count: count } = pendingChatKeys.get() as { readonly chat_count: number };
    if (count > 0 && count <= PENDING_CHAT_SEEK_LIMIT) {
      pendingChatSeeks ??= db.prepare(SQL_LIST_CHATS_SEEK);
      return pendingChatSeeks;
    }
    pendingChats ??= db.prepare(SQL_LIST_CHATS);
    return pendingChats;
  };
  return {
    markMessage: (messageId, mark): boolean =>
      Number(db.prepare(SQL_MARK).run(mark.surface, mark.mode ?? null, messageId).changes) > 0,
    readPosition: (chatId) => readPosition(db, chatId),
    listPending: (chatId, limit): readonly PendingLearningMessage[] => {
      assertLimit(limit);
      pendingPage ??= db.prepare(SQL_LIST_PENDING);
      return (pendingPage.all(chatId, limit) as unknown as PendingRow[]).map(pendingMessage);
    },
    readPreviousUserText: (chatId, messageId): string | undefined => {
      previousUser ??= db.prepare(SQL_READ_PREVIOUS_USER_TEXT);
      const row = previousUser.get(chatId, messageId) as
        { readonly content: string | null } | undefined;
      return row?.content ?? undefined;
    },
    advance: (chatId, position): void => {
      db.prepare(SQL_ADVANCE).run(position.timestamp, position.rowid, chatId);
    },
    listChatsWithPending: (limit): readonly string[] =>
      listPendingChats(pendingChatsStatement, limit).map(({ chatId }) => chatId),
    listPendingChats: (limit, after) => listPendingChats(pendingChatsStatement, limit, after),
  };
}
