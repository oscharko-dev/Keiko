import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_SEMANTIC_MIN_SCORE,
  tokenize,
  type IncludedMemory,
} from "@oscharko-dev/keiko-memory-retrieval";

const DEFAULT_MAX_REINFORCED_PER_TURN = 3;
const MIN_RELEVANCE_REINFORCEMENT_SCORE = 0.15;
const DISTINCTIVE_TOKEN_LENGTH = 6;

const GENERIC_REINFORCEMENT_TOKENS = new Set([
  "memory",
  "remember",
  "user",
  "users",
  "preference",
  "fact",
]);

function pushUniqueCapped(ids: MemoryId[], id: MemoryId, maxIds: number): void {
  if (ids.length >= maxIds || ids.includes(id)) return;
  ids.push(id);
}

export function reinforcementAccessIds(
  included: readonly IncludedMemory[],
  semanticMinScore: number = DEFAULT_SEMANTIC_MIN_SCORE,
  maxIds: number = DEFAULT_MAX_REINFORCED_PER_TURN,
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  for (const item of included) {
    if (
      item.subscores.relevance >= MIN_RELEVANCE_REINFORCEMENT_SCORE ||
      item.subscores.semantic >= semanticMinScore
    ) {
      pushUniqueCapped(ids, item.memoryId, maxIds);
    }
  }
  return ids;
}

function distinctiveTokens(text: string): readonly string[] {
  return tokenize(text).filter((token) => !GENERIC_REINFORCEMENT_TOKENS.has(token));
}

function assistantUsesMemory(bodyExcerpt: string, assistantText: string): boolean {
  const memoryTokens = distinctiveTokens(bodyExcerpt);
  if (memoryTokens.length === 0) return false;
  const assistantTokens = new Set(distinctiveTokens(assistantText));
  if (assistantTokens.size === 0) return false;
  let shared = 0;
  for (const token of memoryTokens) {
    if (!assistantTokens.has(token)) continue;
    shared += 1;
    if (token.length >= DISTINCTIVE_TOKEN_LENGTH) return true;
  }
  if (shared >= 2) return true;
  return shared === 1 && memoryTokens.length <= 3;
}

export function reinforcementAccessIdsForAssistantUse(
  memories: readonly { readonly memoryId: MemoryId | string; readonly bodyExcerpt: string }[],
  assistantText: string,
  maxIds: number = DEFAULT_MAX_REINFORCED_PER_TURN,
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  for (const memory of memories) {
    if (assistantUsesMemory(memory.bodyExcerpt, assistantText)) {
      pushUniqueCapped(ids, memory.memoryId as MemoryId, maxIds);
    }
  }
  return ids;
}
