// Graph-proximity primitive.
//
// A memory's graph-proximity score is a normalized count of its edges (of kinds related |
// supersedes | corrects) whose endpoint is in the caller-supplied high-rank set. The
// remaining edge kinds (`conflicts-with`, `temporal-precedes`, `derived-from`) are
// EXCLUDED because they do not denote semantic alignment:
//   - conflicts-with: the two records DISAGREE; boosting the conflicting record because
//     a conflicting peer is high-rank would invert the signal.
//   - temporal-precedes: pure ordering metadata; tells us nothing about content alignment.
//   - derived-from: lineage edge; the source record is intrinsically older and ranking
//     here would double-count its own recency contribution.
//
// Score normalization uses `1 - 1 / (1 + n)` over the qualifying neighbour count, which
// is monotonically increasing in n, bounded in [0, 1), and saturates smoothly so a memory
// connected to 6 neighbours scores >0.8 (see test). The function is pure — no state, no
// recursion, no transitive closure — so cost is O(edges_for_memory).

import type { MemoryEdge, MemoryEdgeKind, MemoryId } from "@oscharko-dev/keiko-contracts/memory";

const PROXIMITY_KINDS: ReadonlySet<MemoryEdgeKind> = new Set(["related", "supersedes", "corrects"]);

export function graphProximityScore(
  memoryId: MemoryId,
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  highRankIds: ReadonlySet<string>,
): number {
  const edges = edgesByMemory.get(memoryId);
  if (edges === undefined || edges.length === 0) return 0;
  let count = 0;
  for (const edge of edges) {
    if (!PROXIMITY_KINDS.has(edge.kind)) continue;
    const other = edge.fromMemoryId === memoryId ? edge.toMemoryId : edge.fromMemoryId;
    if (highRankIds.has(other)) count += 1;
  }
  if (count === 0) return 0;
  return 1 - 1 / (1 + count);
}
