import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_SEMANTIC_MIN_SCORE,
  type IncludedMemory,
} from "@oscharko-dev/keiko-memory-retrieval";

export function reinforcementAccessIds(
  included: readonly IncludedMemory[],
  semanticMinScore: number = DEFAULT_SEMANTIC_MIN_SCORE,
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  for (const item of included) {
    if (item.subscores.relevance > 0 || item.subscores.semantic >= semanticMinScore) {
      ids.push(item.memoryId);
    }
  }
  return ids;
}
