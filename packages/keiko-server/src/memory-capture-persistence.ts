import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { memoryBodySuppressionHash, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

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

function reusableScopedMemory(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): MemoryRecord | undefined {
  const bodyHash = memoryBodySuppressionHash(record.body);
  return vault
    .listMemoriesByScope(record.scope, {
      status: ["proposed", "accepted"],
      includeExpired: true,
    })
    .find((existing) => memoryBodySuppressionHash(existing.body) === bodyHash);
}

function reuseCapturedMemory(
  vault: MemoryVaultStore,
  existing: MemoryRecord,
  record: MemoryRecord,
): PersistedCapturedMemory {
  if (existing.status === "proposed" && record.status === "accepted") {
    return {
      memory: vault.updateMemory(existing.id, { status: "accepted" }, record.updatedAt),
      inserted: false,
      promoted: true,
    };
  }
  return { memory: existing, inserted: false, promoted: false };
}

function insertOrReuseCanonicalMemory(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): PersistedCapturedMemory {
  const existingById = vault.getMemory(record.id);
  if (
    existingById !== undefined &&
    memoryCaptureProjection(existingById) !== memoryCaptureProjection(record)
  ) {
    throw new Error("Canonical memory capture conflicted.");
  }
  const existing = existingById ?? reusableScopedMemory(vault, record);
  return existing === undefined
    ? { memory: vault.insertMemory(record), inserted: true, promoted: false }
    : reuseCapturedMemory(vault, existing, record);
}

export function persistCapturedMemory(
  vault: MemoryVaultStore,
  candidate: MemoryRecord,
  canonicalCapture: boolean,
): PersistedCapturedMemory {
  if (canonicalCapture) return insertOrReuseCanonicalMemory(vault, candidate);
  return { memory: vault.insertMemory(candidate), inserted: true, promoted: false };
}
