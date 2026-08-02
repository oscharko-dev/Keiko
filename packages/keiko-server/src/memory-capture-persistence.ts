import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

export interface PersistedCapturedMemory {
  readonly memory: MemoryRecord;
  readonly inserted: boolean;
  readonly promoted: boolean;
}

function memoryCaptureProjection(record: MemoryRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    type: record.type,
    body: record.body,
    payload: record.payload ?? null,
    provenance: { ...record.provenance, capturedAt: 0 },
    validity: { ...record.validity, validFrom: 0 },
    pinned: record.pinned,
    staleReason: record.staleReason ?? null,
    retentionHint: record.retentionHint ?? null,
    tags: record.tags,
  });
}

function insertOrReuseCanonicalMemory(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): PersistedCapturedMemory {
  const existing = vault.getMemory(record.id);
  if (existing === undefined) {
    return { memory: vault.insertMemory(record), inserted: true, promoted: false };
  }
  if (memoryCaptureProjection(existing) !== memoryCaptureProjection(record)) {
    throw new Error("Canonical memory capture conflicted.");
  }
  if (existing.status === "proposed" && record.status === "accepted") {
    return {
      memory: vault.updateMemory(existing.id, { status: "accepted" }, record.updatedAt),
      inserted: false,
      promoted: true,
    };
  }
  return { memory: existing, inserted: false, promoted: false };
}

export function persistCapturedMemory(
  vault: MemoryVaultStore,
  candidate: MemoryRecord,
  canonicalCapture: boolean,
): PersistedCapturedMemory {
  if (canonicalCapture) return insertOrReuseCanonicalMemory(vault, candidate);
  return { memory: vault.insertMemory(candidate), inserted: true, promoted: false };
}
