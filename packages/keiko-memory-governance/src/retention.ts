// Expiration / retention update builder.
//
// buildExpirationUpdate produces a MemoryUpdate envelope that patches ONLY the validity
// interval. The semantics are:
//   - validFrom is preserved from the existing record (an expiration update never
//     rewrites the underlying fact's start time).
//   - validUntil is set to the new value supplied by the caller.
//
// Throws GovernanceError('invalid-validity-window') if newValidUntilMs <= validFrom,
// because a zero-or-negative-duration validity is structurally meaningless and would
// also fail the contracts validateMemoryValidityInterval rule downstream.

import type {
  MemoryRecord,
  MemoryUpdate,
  MemoryValidityInterval,
} from "@oscharko-dev/keiko-contracts/memory";
import { validateMemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type { GovernanceContext } from "./types.js";

// Bi-temporal-lite (#204, C1): the validity interval for a record being SUPERSEDED at `nowMs` — its
// belief window CLOSED at the moment its replacement takes over. With this, "what did we believe as
// of date T" is answerable (validFrom <= T AND (validUntil IS NULL OR validUntil > T)) and a closed
// window drops out of default retrieval automatically. Returns null when closing would not form a
// valid interval (nowMs <= validFrom) or would EXTEND an already-closed window (existing validUntil
// <= nowMs), so an already-expired fact is never silently un-expired. Pure; no validation throw —
// the caller applies it as an additive patch alongside the status transition.
export function supersededValidity(
  record: MemoryRecord,
  nowMs: number,
): MemoryValidityInterval | null {
  const { validFrom, validUntil } = record.validity;
  if (!Number.isFinite(nowMs) || nowMs <= validFrom) return null;
  if (validUntil !== undefined && validUntil <= nowMs) return null;
  return { validFrom, validUntil: nowMs };
}

export function buildExpirationUpdate(
  memory: MemoryRecord,
  newValidUntilMs: number,
  context: GovernanceContext,
): MemoryUpdate {
  if (!Number.isFinite(newValidUntilMs)) {
    throw new GovernanceError("invalid-validity-window", "newValidUntilMs must be a finite number");
  }
  if (newValidUntilMs <= memory.validity.validFrom) {
    throw new GovernanceError(
      "invalid-validity-window",
      "newValidUntilMs must be strictly greater than memory.validity.validFrom",
      [
        `validFrom: ${String(memory.validity.validFrom)}`,
        `newValidUntilMs: ${String(newValidUntilMs)}`,
      ],
    );
  }
  const update: MemoryUpdate = {
    schemaVersion: "1",
    memoryId: memory.id,
    reviewerId: context.reviewerId,
    updatedAt: context.nowMs,
    validityPatch: {
      validFrom: memory.validity.validFrom,
      validUntil: newValidUntilMs,
    },
  };
  const v = validateMemoryUpdate(update);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "expiration update failed contracts validation",
      v.errors,
    );
  }
  return update;
}
