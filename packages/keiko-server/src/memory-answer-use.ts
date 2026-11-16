// Which supplied memories an answer actually drew on. This is remembered for "Vergiss das" and never
// strengthens a memory: an answer repeating a false memory must not entrench it (#4212).

import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import { tokenize } from "@oscharko-dev/keiko-memory-retrieval";

const MAX_USED_PER_TURN = 3;
const DISTINCTIVE_TOKEN_LENGTH = 6;

const GENERIC_MEMORY_TOKENS = new Set([
  "memory",
  "remember",
  "user",
  "users",
  "preference",
  "fact",
]);

function distinctiveTokens(text: string): readonly string[] {
  return tokenize(text).filter((token) => !GENERIC_MEMORY_TOKENS.has(token));
}

function answerUsesMemory(bodyExcerpt: string, assistantText: string): boolean {
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

export function memoriesUsedInAnswer(
  memories: readonly { readonly memoryId: MemoryId | string; readonly bodyExcerpt: string }[],
  assistantText: string,
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  for (const memory of memories) {
    if (ids.length >= MAX_USED_PER_TURN) break;
    const id = memory.memoryId as MemoryId;
    if (!ids.includes(id) && answerUsesMemory(memory.bodyExcerpt, assistantText)) ids.push(id);
  }
  return ids;
}
