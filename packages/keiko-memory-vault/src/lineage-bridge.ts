// A corrected fact stays in the vault as history, linked by `supersedes` edges from each older
// record to the one that replaced it (#4223). Deleting a record removes its edges with it (ON DELETE
// CASCADE), which would cut the surviving earlier values of a fact off from its newer ones: a later
// forget of the newest value could no longer reach them. Every delete therefore links each surviving
// predecessor to each surviving successor first, inside the same transaction, walking through every
// other record that transaction deletes. A forget by id, a sweep, retention and maintenance all
// delete through here, so none of them can split one fact into two. A lineage never crosses a
// scope: the walk only steps through and links records of the deleted record's own scope, so a
// record behind a foreign-scope link stays out of reach of a later forget (ADR-0146).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEdgeId, MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryContentCipher } from "./cipher.js";
import { insertEdgeRow } from "./edges.js";
import { cachedPrepare } from "./statements.js";

const BRIDGE_PROVENANCE = "history kept after a delete";
// The scope columns are stored in clear, so the walk reads them without opening a sealed body: a
// damaged neighbour row can never block the person's forget.
const SCOPE_BY_ID_SQL = "SELECT scope_kind, scope_coordinate FROM memories WHERE id = ?";

// The endpoints and kind of an edge are stored in clear as well: the walk never opens an edge's
// sealed provenance, so a damaged edge can never block a forget either.
const EARLIER_SQL =
  "SELECT from_memory_id AS id FROM memory_edges WHERE to_memory_id = ? AND kind = 'supersedes' ORDER BY created_at ASC";
const LATER_SQL =
  "SELECT to_memory_id AS id FROM memory_edges WHERE from_memory_id = ? AND kind = 'supersedes' ORDER BY created_at ASC";

interface EndpointRow {
  readonly id: string;
}

interface ScopeRow {
  readonly scope_kind: string;
  readonly scope_coordinate: string;
}

type Direction = "earlier" | "later";

function neighbours(db: DatabaseSync, id: MemoryId, direction: Direction): readonly MemoryId[] {
  const rows = cachedPrepare(db, direction === "earlier" ? EARLIER_SQL : LATER_SQL).all(
    id,
  ) as unknown as readonly EndpointRow[];
  return rows.map((row) => row.id as MemoryId);
}

interface Walk {
  readonly db: DatabaseSync;
  readonly deleting: ReadonlySet<MemoryId>;
  /** Scope coordinate of each record read, so a lineage is checked once per record. */
  readonly scopes: Map<MemoryId, string | undefined>;
}

function scopeOf(walk: Walk, id: MemoryId): string | undefined {
  if (!walk.scopes.has(id)) {
    const row = cachedPrepare(walk.db, SCOPE_BY_ID_SQL).get(id) as unknown as ScopeRow | undefined;
    walk.scopes.set(
      id,
      row === undefined ? undefined : `${row.scope_kind}\u0000${row.scope_coordinate}`,
    );
  }
  return walk.scopes.get(id);
}

// The records that stay, reached from `start` in one direction through records being deleted, all
// in the scope of `start`: a record of another scope ends the walk on that path.
function survivors(walk: Walk, start: MemoryId, direction: Direction): ReadonlySet<MemoryId> {
  const home = scopeOf(walk, start);
  const found = new Set<MemoryId>();
  const seen = new Set<MemoryId>([start]);
  const queue: MemoryId[] = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const id of neighbours(walk.db, next, direction)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (home === undefined || scopeOf(walk, id) !== home) continue;
      if (walk.deleting.has(id)) queue.push(id);
      else found.add(id);
    }
  }
  return found;
}

/** Links surviving predecessors to surviving successors of the records about to be deleted. */
export function bridgeSupersessionAcrossDeletes(
  db: DatabaseSync,
  deleting: ReadonlySet<MemoryId>,
  nowMs: number,
  cipher: MemoryContentCipher,
): number {
  let inserted = 0;
  const linked = new Set<string>();
  const walk: Walk = { db, deleting, scopes: new Map() };
  for (const id of deleting) {
    const later = survivors(walk, id, "later");
    if (later.size === 0) continue;
    for (const fromMemoryId of survivors(walk, id, "earlier")) {
      const existing = new Set(neighbours(db, fromMemoryId, "later"));
      for (const toMemoryId of later) {
        const key = `${fromMemoryId}\u0000${toMemoryId}`;
        if (fromMemoryId === toMemoryId || existing.has(toMemoryId) || linked.has(key)) continue;
        linked.add(key);
        insertEdgeRow(
          db,
          {
            id: randomUUID() as MemoryEdgeId,
            schemaVersion: "1",
            fromMemoryId,
            toMemoryId,
            kind: "supersedes",
            createdAt: nowMs,
            provenanceSummary: BRIDGE_PROVENANCE,
          },
          cipher,
        );
        inserted += 1;
      }
    }
  }
  return inserted;
}
