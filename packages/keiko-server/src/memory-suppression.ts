import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

export function isSuppressedByForgetTombstone(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): boolean {
  return vault.hasForgetTombstoneForBody(record.scope, record.body);
}
