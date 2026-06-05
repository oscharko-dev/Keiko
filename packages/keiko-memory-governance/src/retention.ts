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

import type { MemoryRecord, MemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";
import { validateMemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type { GovernanceContext } from "./types.js";

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
