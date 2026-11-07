// Prepared SQL for the memory_access table (#204). Access rows hold ONLY a counter and a
// timestamp — never memory content — so no cipher is threaded through this module. The table
// feeds the decay / reinforcement maintenance cycle: recall increments the counter and advances
// the timestamp; the maintenance planner reads the stats to compute effective strength.
//
// Same shape discipline as memories.ts / edges.ts: every parameter binds positionally, no template
// concatenation with caller data, so SQL injection is structurally impossible at this layer.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { cachedPrepare } from "./statements.js";

export interface MemoryAccessStat {
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  // Governed retention outcomes (#204, O-V1). `outcomeCount` is how many times a deterministic
  // governance event judged this memory's usefulness; `utilitySum` is the summed utility of those
  // judgements (each in [0,1]). Their mean drives the maintenance utility factor. Both default 0 for
  // a never-judged memory (no outcome => neutral factor).
  readonly outcomeCount: number;
  readonly utilitySum: number;
  // When an answer last drew on this memory. Not a reinforcement: `accessCount` and
  // `lastAccessedAt` rise only on the person's own repetition (#4212).
  readonly lastUsedAt?: number;
}

// One chat's own latest confirmation and use of a memory. Absent means that chat never touched it.
export interface MemoryConversationTouch {
  readonly confirmedAt?: number;
  readonly usedAt?: number;
}

// Insert-or-increment. The ON CONFLICT clause turns a repeat access into a counter bump plus a
// timestamp advance, so the row reflects the MOST RECENT touch and the TOTAL touch count. A
// duplicate id inside one batch is applied as two separate statements => counted twice, which is
// the intended semantics (two recalls of the same memory in one turn are two reinforcements).
//
// Every write below names its memory in the same statement that checks it still exists: a memory
// forgotten while a model call was running is touched by nobody, and the write neither fails its
// foreign key nor stops the caller's settlement (#4212).
const UPSERT_SQL = `
INSERT INTO memory_access (memory_id, last_accessed_at, access_count)
SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)
ON CONFLICT(memory_id) DO UPDATE SET
  access_count = access_count + 1,
  last_accessed_at = excluded.last_accessed_at
`;

// Each chat keeps its own latest confirmation and use: a touch in another chat changes nothing here,
// so "Vergiss das" in this chat still finds what this chat's last turn touched (#4212).
const CONFIRM_IN_CONVERSATION_SQL = `
INSERT INTO memory_conversation_touches (memory_id, conversation_id, confirmed_at)
SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)
ON CONFLICT(memory_id, conversation_id) DO UPDATE SET confirmed_at = excluded.confirmed_at
`;

const USE_IN_CONVERSATION_SQL = `
INSERT INTO memory_conversation_touches (memory_id, conversation_id, used_at)
SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)
ON CONFLICT(memory_id, conversation_id) DO UPDATE SET used_at = excluded.used_at
`;

const SELECT_CONVERSATION_TOUCHES_SQL =
  "SELECT memory_id, confirmed_at, used_at FROM memory_conversation_touches WHERE conversation_id = ?";

// Append a governed retention OUTCOME (#204, O-V1). Unlike an access, an outcome NEVER advances the
// recall counter or the last-access timestamp — it only accumulates the outcome count and summed
// utility. A memory that was judged before it was ever recalled gets a fresh row with access_count 0
// (the maintenance recency model then anchors on createdAt, not this insert's timestamp). `utility`
// is clamped to [0,1] so a caller bug cannot skew the mean outside the modelled range.
const RECORD_OUTCOME_SQL = `
INSERT INTO memory_access (memory_id, last_accessed_at, access_count, outcome_count, utility_sum)
SELECT ?1, ?2, 0, 1, ?3 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)
ON CONFLICT(memory_id) DO UPDATE SET
  outcome_count = outcome_count + 1,
  utility_sum = utility_sum + excluded.utility_sum
`;

// A use advances only its own timestamp. A fresh row anchors last_accessed_at at 0 with access_count
// 0, so neither the maintenance recency model nor the stale check reads it as a recall.
const RECORD_USE_SQL = `
INSERT INTO memory_access (memory_id, last_accessed_at, access_count, last_used_at)
SELECT ?1, 0, 0, ?2 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)
ON CONFLICT(memory_id) DO UPDATE SET last_used_at = excluded.last_used_at
`;

const SELECT_ALL_SQL =
  "SELECT memory_id, last_accessed_at, access_count, outcome_count, utility_sum, last_used_at FROM memory_access";

interface AccessRow {
  readonly memory_id: string;
  readonly last_accessed_at: number;
  readonly access_count: number;
  readonly outcome_count: number;
  readonly utility_sum: number;
  readonly last_used_at: number | null;
}

export function recordAccessRows(
  db: DatabaseSync,
  ids: readonly MemoryId[],
  nowMs: number,
  conversationId?: string,
): void {
  if (ids.length === 0) return;
  const stmt = cachedPrepare(db, UPSERT_SQL);
  const touch =
    conversationId === undefined ? undefined : cachedPrepare(db, CONFIRM_IN_CONVERSATION_SQL);
  for (const id of ids) {
    stmt.run(id, nowMs);
    touch?.run(id, conversationId ?? null, nowMs);
  }
}

export function recordUseRows(
  db: DatabaseSync,
  ids: readonly MemoryId[],
  nowMs: number,
  conversationId: string,
): void {
  if (ids.length === 0) return;
  const stmt = cachedPrepare(db, RECORD_USE_SQL);
  const touch = cachedPrepare(db, USE_IN_CONVERSATION_SQL);
  for (const id of ids) {
    stmt.run(id, nowMs);
    touch.run(id, conversationId, nowMs);
  }
}

function clampUtility(utility: number): number {
  if (utility <= 0) return 0;
  if (utility > 1) return 1;
  return utility;
}

export function recordOutcomeRows(
  db: DatabaseSync,
  ids: readonly MemoryId[],
  utility: number,
  nowMs: number,
): void {
  if (ids.length === 0) return;
  const clamped = clampUtility(utility);
  const stmt = cachedPrepare(db, RECORD_OUTCOME_SQL);
  for (const id of ids) {
    stmt.run(id, nowMs, clamped);
  }
}

function rowsToMap(rows: readonly AccessRow[]): Map<MemoryId, MemoryAccessStat> {
  const map = new Map<MemoryId, MemoryAccessStat>();
  for (const row of rows) {
    map.set(row.memory_id as MemoryId, {
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      outcomeCount: row.outcome_count,
      utilitySum: row.utility_sum,
      ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    });
  }
  return map;
}

export function getAccessStatsRows(
  db: DatabaseSync,
  ids?: readonly MemoryId[],
): ReadonlyMap<MemoryId, MemoryAccessStat> {
  if (ids === undefined) {
    const rows = cachedPrepare(db, SELECT_ALL_SQL).all() as unknown as readonly AccessRow[];
    return rowsToMap(rows);
  }
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const sql = `${SELECT_ALL_SQL} WHERE memory_id IN (${placeholders})`;
  const rows = cachedPrepare(db, sql).all(...ids) as unknown as readonly AccessRow[];
  return rowsToMap(rows);
}

interface ConversationTouchRow {
  readonly memory_id: string;
  readonly confirmed_at: number | null;
  readonly used_at: number | null;
}

export function getConversationTouchRows(
  db: DatabaseSync,
  conversationId: string,
): ReadonlyMap<MemoryId, MemoryConversationTouch> {
  const rows = cachedPrepare(db, SELECT_CONVERSATION_TOUCHES_SQL).all(
    conversationId,
  ) as unknown as readonly ConversationTouchRow[];
  const map = new Map<MemoryId, MemoryConversationTouch>();
  for (const row of rows) {
    map.set(row.memory_id as MemoryId, {
      ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
      ...(row.used_at === null ? {} : { usedAt: row.used_at }),
    });
  }
  return map;
}
