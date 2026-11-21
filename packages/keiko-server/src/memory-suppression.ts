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
// Body comparison is delegated to the vault's own keyed suppression fingerprint, the same
// normalisation the forget tombstone is keyed on. The vault computes and indexes it, so the two
// refusal paths cannot drift apart on what "the same body" means.
//
// DELIBERATE ASYMMETRY: rejection suppresses the INFERRED capture paths (model salience, voice
// recap) — "stop deducing this about me" — while an explicit "remember that X" instruction is a
// fresh human decision that outranks a past rejection and stays on forget-only suppression. A
// forget tombstone a PERSON wrote is deletion-grade and suppresses every path (RB-4). A tombstone an
// unattended pass wrote (maintenance, retention) suppresses only the inferred paths, and only where
// it removed a rejected record or records no status (#4223): it must never make a rejection stronger
// than it was while the record existed, so the person's own statement ignores it altogether.

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  FORGOTTEN_MEMORY_SUPPRESSION_REASON,
  REJECTED_MEMORY_SUPPRESSION_REASON,
  type MemoryCaptureSuppressionReason,
} from "./memory-capture-policy.js";

export interface ForgetTombstoneCheck {
  /** The person's own statement: a tombstone an unattended pass left does not refuse it. */
  readonly explicitStatement?: boolean;
}

export function isSuppressedByForgetTombstone(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  check: ForgetTombstoneCheck = {},
): boolean {
  return vault.hasForgetTombstoneForBody(record.scope, record.body, {
    personOnly: check.explicitStatement === true,
  });
}

// Found by the vault's body fingerprint index, so a rejection keeps refusing its fact however many
// newer rejections the scope holds; a window of the newest rows let an older one slip back in.
export function isSuppressedByRejection(vault: MemoryVaultStore, record: MemoryRecord): boolean {
  return (
    vault.listMemoryMetadataByBody(record.scope, record.body, {
      status: ["rejected"],
      limit: 1,
      includeExpired: true,
    }).length > 0
  );
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
