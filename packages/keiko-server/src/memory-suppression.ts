import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { memoryBodySuppressionHash, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

export function isSuppressedByForgetTombstone(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): boolean {
  const bodyHash = memoryBodySuppressionHash(record.body);
  return vault
    .listTombstonesByScope(record.scope)
    .some((tombstone) => tombstone.bodyHash === bodyHash);
}
