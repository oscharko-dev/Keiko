// The supersession lineage of a fact (#4223). A corrected fact stays in the vault as history, so a
// fact and the earlier values it replaced are ONE fact to the person: forgetting it by name must not
// stop at the newest value, and naming it must not be ambiguous with its own predecessors. The edge
// runs from the older record to its successor (`fromMemoryId` is replaced by `toMemoryId`), so the
// predecessors of a record are the sources of its incoming `supersedes` edges.

import { randomUUID } from "node:crypto";
import type { MemoryEdgeId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

// A fact corrected this many times is not a plausible lineage. The walk stops there and says so; the
// forget then refuses instead of leaving earlier values behind without telling the person.
const MAX_LINEAGE_RECORDS = 256;

export interface SupersededLineage {
  readonly records: readonly MemoryRecord[];
  /** False when the walk hit its bound, so more predecessors may exist. */
  readonly complete: boolean;
}

function predecessorIds(vault: MemoryVaultStore, id: MemoryRecord["id"]): readonly string[] {
  return vault
    .listIncomingEdges(id)
    .filter((edge) => edge.kind === "supersedes")
    .map((edge) => edge.fromMemoryId);
}

/**
 * Every superseded record reachable over `supersedes` edges from `record`, transitively. A seen-set
 * ends cycles; a predecessor that is gone or is not itself superseded is not part of the history.
 */
export function supersededPredecessors(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): SupersededLineage {
  const seen = new Set<string>([String(record.id)]);
  const found: MemoryRecord[] = [];
  const queue: MemoryRecord["id"][] = [record.id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const fromId of predecessorIds(vault, next)) {
      if (seen.has(fromId)) continue;
      seen.add(fromId);
      const predecessor = vault.getMemory(fromId as MemoryRecord["id"]);
      if (predecessor?.status !== "superseded") continue;
      if (found.length >= MAX_LINEAGE_RECORDS) return { records: found, complete: false };
      found.push(predecessor);
      queue.push(predecessor.id);
    }
  }
  return { records: found, complete: true };
}

/**
 * Keeps the chain whole when one history record is forgotten on its own: deleting a record removes
 * its edges, which would cut the earlier values off from the newer one and make them look like a
 * separate fact. Each predecessor is linked to each successor of the record that goes.
 */
export function bridgeSupersessionAround(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  nowMs: number,
): void {
  const successors = vault
    .listOutgoingEdges(record.id)
    .filter((edge) => edge.kind === "supersedes")
    .map((edge) => edge.toMemoryId);
  for (const fromId of predecessorIds(vault, record.id)) {
    const existing = new Set(
      vault
        .listOutgoingEdges(fromId as MemoryRecord["id"])
        .filter((edge) => edge.kind === "supersedes")
        .map((edge) => edge.toMemoryId),
    );
    for (const toMemoryId of successors) {
      if (existing.has(toMemoryId)) continue;
      vault.insertEdge({
        id: randomUUID() as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: fromId as MemoryRecord["id"],
        toMemoryId,
        kind: "supersedes",
        createdAt: nowMs,
        provenanceSummary: "history kept after a forget",
      });
    }
  }
}
