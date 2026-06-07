// Prepared SQL for the memory_access table (#204). Access rows hold ONLY a counter and a
// timestamp — never memory content — so no cipher is threaded through this module. The table
// feeds the decay / reinforcement maintenance cycle: recall increments the counter and advances
// the timestamp; the maintenance planner reads the stats to compute effective strength.
//
// Same shape discipline as memories.ts / edges.ts: every parameter binds positionally, no template
// concatenation with caller data, so SQL injection is structurally impossible at this layer.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";

export interface MemoryAccessStat {
  readonly lastAccessedAt: number;
  readonly accessCount: number;
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

const SELECT_ALL_SQL = "SELECT memory_id, last_accessed_at, access_count FROM memory_access";

interface AccessRow {
  readonly memory_id: string;
  readonly last_accessed_at: number;
  readonly access_count: number;
}

export function recordAccessRows(db: DatabaseSync, ids: readonly MemoryId[], nowMs: number): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(UPSERT_SQL);
  for (const id of ids) {
    stmt.run(id, nowMs);
  }
}

function rowsToMap(rows: readonly AccessRow[]): Map<MemoryId, MemoryAccessStat> {
  const map = new Map<MemoryId, MemoryAccessStat>();
  for (const row of rows) {
    map.set(row.memory_id as MemoryId, {
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    });
  }
  return map;
}

export function getAccessStatsRows(
  db: DatabaseSync,
  ids?: readonly MemoryId[],
): ReadonlyMap<MemoryId, MemoryAccessStat> {
  if (ids === undefined) {
    const rows = db.prepare(SELECT_ALL_SQL).all() as unknown as readonly AccessRow[];
    return rowsToMap(rows);
  }
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const sql = `${SELECT_ALL_SQL} WHERE memory_id IN (${placeholders})`;
  const rows = db.prepare(sql).all(...ids) as unknown as readonly AccessRow[];
  return rowsToMap(rows);
}
