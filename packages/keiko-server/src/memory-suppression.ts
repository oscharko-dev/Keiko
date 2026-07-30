// Capture-time suppression: "has the local human already refused this exact fact in this scope?".
//
// There are two governed refusals and they must behave identically, because to the operator they
// mean the same thing — "no, do not keep this":
//   * FORGET  — the record was deleted and only a body-hash + sealed-vector tombstone remains.
//   * REJECT  — the record survives with status `rejected` (a terminal state in
//               MEMORY_STATUS_TRANSITIONS), which is the audit trail of the refusal.
// Before this module carried the second case, a rejected proposal left NO trace the capture path
// consulted — both dedup corpora read `accepted` only — so the salience extractor re-derived the
// same fact from ordinary conversation and put it straight back in the review queue, forever.
//
// Body comparison is delegated to the vault's own suppression fingerprint
// (`memoryBodySuppressionHash`), the same normalisation the forget tombstone is keyed on. It is
// imported, never re-implemented, so the two refusal paths cannot drift apart on what "the same
// body" means.
//
// DELIBERATE ASYMMETRY: rejection suppresses the INFERRED capture paths (model salience, voice
// recap) — "stop deducing this about me" — while an explicit "remember that X" instruction is a
// fresh human decision that outranks a past rejection and stays on forget-only suppression. A
// forget tombstone is deletion-grade and suppresses every path, as it always has (RB-4).

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { memoryBodySuppressionHash, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  FORGOTTEN_MEMORY_SUPPRESSION_REASON,
  REJECTED_MEMORY_SUPPRESSION_REASON,
  type MemoryCaptureSuppressionReason,
} from "./memory-capture-policy.js";

// Bounds the rejected corpus read so the check stays cheap on a large vault, mirroring the
// MAX_EXISTING_BODIES / MAX_DEDUP_NEIGHBORS bounds on the two dedup corpora.
const MAX_REJECTED_SUPPRESSION_RECORDS = 200;

export function isSuppressedByForgetTombstone(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): boolean {
  return vault.hasForgetTombstoneForBody(record.scope, record.body);
}

export function isSuppressedByRejection(vault: MemoryVaultStore, record: MemoryRecord): boolean {
  const candidateHash = memoryBodySuppressionHash(record.body);
  return vault
    .listMemoriesByScope(record.scope, {
      status: ["rejected"],
      limit: MAX_REJECTED_SUPPRESSION_RECORDS,
      includeExpired: true,
    })
    .some((rejected) => memoryBodySuppressionHash(rejected.body) === candidateHash);
}

// The single exact-body suppression gate the capture path consults. Returns the typed refusal
// reason so the caller records the right capture-decision audit event, or null when nothing has
// refused this body. Forget is checked first only for determinism; the two are mutually consistent.
export function exactCaptureSuppressionReason(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): MemoryCaptureSuppressionReason | null {
  if (isSuppressedByForgetTombstone(vault, record)) return FORGOTTEN_MEMORY_SUPPRESSION_REASON;
  if (isSuppressedByRejection(vault, record)) return REJECTED_MEMORY_SUPPRESSION_REASON;
  return null;
}
