// A corrected fact stays in the vault as history, linked by `supersedes` edges from each older
// record to the one that replaced it (#4223). Deleting a record removes its edges with it (ON DELETE
// CASCADE), which would cut the surviving earlier values of a fact off from its newer ones: a later
// forget of the newest value could no longer reach them. Every delete therefore links each surviving
// predecessor to each surviving successor first, inside the same transaction, walking through every
// other record that transaction deletes. A forget by id, a sweep, retention and maintenance all
// delete through here, so none of them can split one fact into two.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEdgeId, MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryContentCipher } from "./cipher.js";
import { insertEdgeRow, listIncomingEdgeRows, listOutgoingEdgeRows } from "./edges.js";

const BRIDGE_PROVENANCE = "history kept after a delete";

type Direction = "earlier" | "later";

function neighbours(
  db: DatabaseSync,
  id: MemoryId,
  direction: Direction,
  cipher: MemoryContentCipher,
): readonly MemoryId[] {
  if (direction === "earlier") {
    return listIncomingEdgeRows(db, id, cipher)
      .filter((edge) => edge.kind === "supersedes")
      .map((edge) => edge.fromMemoryId);
  }
  return listOutgoingEdgeRows(db, id, cipher)
    .filter((edge) => edge.kind === "supersedes")
    .map((edge) => edge.toMemoryId);
}

// The records that stay, reached from `start` in one direction through records being deleted.
function survivors(
  db: DatabaseSync,
  start: MemoryId,
  direction: Direction,
  deleting: ReadonlySet<MemoryId>,
  cipher: MemoryContentCipher,
): ReadonlySet<MemoryId> {
  const found = new Set<MemoryId>();
  const seen = new Set<MemoryId>([start]);
  const queue: MemoryId[] = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const id of neighbours(db, next, direction, cipher)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (deleting.has(id)) queue.push(id);
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
  for (const id of deleting) {
    const later = survivors(db, id, "later", deleting, cipher);
    if (later.size === 0) continue;
    for (const fromMemoryId of survivors(db, id, "earlier", deleting, cipher)) {
      const existing = new Set(neighbours(db, fromMemoryId, "later", cipher));
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
