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
}

// Insert-or-increment. The ON CONFLICT clause turns a repeat access into a counter bump plus a
// timestamp advance, so the row reflects the MOST RECENT touch and the TOTAL touch count. A
// duplicate id inside one batch is applied as two separate statements => counted twice, which is
// the intended semantics (two recalls of the same memory in one turn are two reinforcements).
const UPSERT_SQL = `
INSERT INTO memory_access (memory_id, last_accessed_at, access_count)
VALUES (?, ?, 1)
ON CONFLICT(memory_id) DO UPDATE SET
  access_count = access_count + 1,
  last_accessed_at = excluded.last_accessed_at
`;

// Append a governed retention OUTCOME (#204, O-V1). Unlike an access, an outcome NEVER advances the
// recall counter or the last-access timestamp — it only accumulates the outcome count and summed
// utility. A memory that was judged before it was ever recalled gets a fresh row with access_count 0
// (the maintenance recency model then anchors on createdAt, not this insert's timestamp). `utility`
// is clamped to [0,1] so a caller bug cannot skew the mean outside the modelled range.
const RECORD_OUTCOME_SQL = `
INSERT INTO memory_access (memory_id, last_accessed_at, access_count, outcome_count, utility_sum)
VALUES (?, ?, 0, 1, ?)
ON CONFLICT(memory_id) DO UPDATE SET
  outcome_count = outcome_count + 1,
  utility_sum = utility_sum + excluded.utility_sum
`;

const SELECT_ALL_SQL =
  "SELECT memory_id, last_accessed_at, access_count, outcome_count, utility_sum FROM memory_access";

interface AccessRow {
  readonly memory_id: string;
  readonly last_accessed_at: number;
  readonly access_count: number;
  readonly outcome_count: number;
  readonly utility_sum: number;
}

export function recordAccessRows(db: DatabaseSync, ids: readonly MemoryId[], nowMs: number): void {
  if (ids.length === 0) return;
  const stmt = cachedPrepare(db, UPSERT_SQL);
  for (const id of ids) {
    stmt.run(id, nowMs);
  }
}

function clampUtility(utility: number): number {
  if (!(utility > 0)) return 0;
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
