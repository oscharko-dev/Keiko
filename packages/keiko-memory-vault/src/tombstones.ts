// Prepared SQL for the memory_tombstones table. Tombstones are intentionally NOT a foreign key
// against memories.id — the memory row is gone by the time the tombstone is written; the FK
// would either reject the insert or force ON DELETE SET NULL, both of which lose the audit
// signal. We therefore store memory_id as a denormalised TEXT column and accept that listing a
// tombstone tells you "this id existed in this scope at this time," not "follow the FK."

import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryId,
  MemoryScope,
  MemoryScopeKind,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { MemoryTombstone } from "./types.js";

interface TombstoneRow {
  readonly id: string;
  readonly memory_id: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly type: string;
  readonly forgotten_at: number;
  readonly forgetter_surface: string;
  readonly reason: string | null;
}

const INSERT_SQL = `
INSERT INTO memory_tombstones (
  id, memory_id, scope_kind, scope_coordinate, type, forgotten_at,
  forgetter_surface, reason
) VALUES (?,?,?,?,?,?,?,?)
`;

const LIST_BY_SCOPE_SQL = `
SELECT * FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ?
ORDER BY forgotten_at ASC
`;

function rowToTombstone(row: TombstoneRow): MemoryTombstone {
  const base = {
    id: row.id,
    memoryId: row.memory_id as MemoryId,
    scopeKind: row.scope_kind as MemoryScopeKind,
    scopeCoordinate: row.scope_coordinate,
    type: row.type as MemoryType,
    forgottenAt: row.forgotten_at,
    forgetterSurface: row.forgetter_surface,
  };
  return row.reason === null ? base : { ...base, reason: row.reason };
}

export function insertTombstoneRow(db: DatabaseSync, tombstone: MemoryTombstone): void {
  db.prepare(INSERT_SQL).run(
    tombstone.id,
    tombstone.memoryId,
    tombstone.scopeKind,
    tombstone.scopeCoordinate,
    tombstone.type,
    tombstone.forgottenAt,
    tombstone.forgetterSurface,
    tombstone.reason ?? null,
  );
}

export function listTombstonesByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
): readonly MemoryTombstone[] {
  const rows = db
    .prepare(LIST_BY_SCOPE_SQL)
    .all(scopeKindOf(scope), scopeCoordinateOf(scope)) as unknown as readonly TombstoneRow[];
  return rows.map(rowToTombstone);
}
