// Prepared SQL for the memory_tombstones table. Tombstones are intentionally NOT a foreign key
// against memories.id — the memory row is gone by the time the tombstone is written; the FK
// would either reject the insert or force ON DELETE SET NULL, both of which lose the audit
// signal. We therefore store memory_id as a denormalised TEXT column and accept that listing a
// tombstone tells you "this id existed in this scope at this time," not "follow the FK."

import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryId,
  MemoryReviewerId,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { MemoryTombstone } from "./types.js";
import type { MemoryContentCipher } from "./cipher.js";

interface TombstoneRow {
  readonly id: string;
  readonly memory_id: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly type: string;
  readonly forgotten_at: number;
  readonly forgetter_surface: string;
  readonly reviewer_id: string | null;
  readonly original_status: string | null;
  readonly reason: string | null;
}

const INSERT_SQL = `
INSERT INTO memory_tombstones (
  id, memory_id, scope_kind, scope_coordinate, type, forgotten_at,
  forgetter_surface, reviewer_id, original_status, reason
) VALUES (?,?,?,?,?,?,?,?,?,?)
`;

const LIST_BY_SCOPE_SQL = `
SELECT * FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ?
ORDER BY forgotten_at ASC
`;

// `reason` is the only free-text tombstone column, so it is the only sealed one (ADR-0035).
function rowToTombstone(row: TombstoneRow, cipher: MemoryContentCipher): MemoryTombstone {
  const base = {
    id: row.id,
    memoryId: row.memory_id as MemoryId,
    scopeKind: row.scope_kind as MemoryScopeKind,
    scopeCoordinate: row.scope_coordinate,
    type: row.type as MemoryType,
    forgottenAt: row.forgotten_at,
    forgetterSurface: row.forgetter_surface,
  };
  return {
    ...base,
    ...(row.reviewer_id === null ? {} : { reviewerId: row.reviewer_id as MemoryReviewerId }),
    ...(row.original_status === null
      ? {}
      : { originalStatus: row.original_status as MemoryStatus }),
    ...(row.reason === null ? {} : { reason: cipher.openString(row.reason) }),
  };
}

export function insertTombstoneRow(
  db: DatabaseSync,
  tombstone: MemoryTombstone,
  cipher: MemoryContentCipher,
): void {
  const reason = tombstone.reason === undefined ? null : cipher.sealString(tombstone.reason);
  db.prepare(INSERT_SQL).run(
    tombstone.id,
    tombstone.memoryId,
    tombstone.scopeKind,
    tombstone.scopeCoordinate,
    tombstone.type,
    tombstone.forgottenAt,
    tombstone.forgetterSurface,
    tombstone.reviewerId ?? null,
    tombstone.originalStatus ?? null,
    reason,
  );
}

export function listTombstonesByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  cipher: MemoryContentCipher,
): readonly MemoryTombstone[] {
  const rows = db
    .prepare(LIST_BY_SCOPE_SQL)
    .all(scopeKindOf(scope), scopeCoordinateOf(scope)) as unknown as readonly TombstoneRow[];
  return rows.map((row) => rowToTombstone(row, cipher));
}
