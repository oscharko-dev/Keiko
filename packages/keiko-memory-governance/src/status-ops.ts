// Pin / unpin / archive envelope builders.
//
// Each builder is idempotency-rejecting: pinning an already-pinned memory throws
// GovernanceError("idempotent-noop"), and likewise for unpin/archive. The check happens
// BEFORE the envelope is constructed so the caller never receives a "valid" envelope
// representing a no-op. Every emitted envelope is revalidated through the contracts
// validator (validateMemoryPin / validateMemoryUnpin / validateMemoryArchive) as a
// defence-in-depth guard against future contract drift.
//
// Archive additionally rejects memories whose current status forbids the transition to
// archived (per MEMORY_STATUS_TRANSITIONS: archive is legal from accepted, superseded,
// conflicted, expired — and ILLEGAL from proposed, rejected, archived, forgotten). The
// check is delegated to the same checkStatusTransition helper the conflict layer uses so
// the two layers agree on transition legality.

import type {
  MemoryArchive,
  MemoryPin,
  MemoryRecord,
  MemoryUnpin,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  checkStatusTransition,
  validateMemoryArchive,
  validateMemoryPin,
  validateMemoryUnpin,
} from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type { GovernanceContext } from "./types.js";

// ─── Pin ──────────────────────────────────────────────────────────────────────
export function buildPinOperation(
  memory: MemoryRecord,
  context: GovernanceContext,
  reason?: string,
): MemoryPin {
  if (memory.pinned) {
    throw new GovernanceError("idempotent-noop", `memory ${memory.id} is already pinned`, [
      `memoryId: ${memory.id}`,
    ]);
  }
  const env: MemoryPin = {
    schemaVersion: "1",
    memoryId: memory.id,
    reviewerId: context.reviewerId,
    pinnedAt: context.nowMs,
    ...(reason !== undefined ? { reason } : {}),
  };
  const v = validateMemoryPin(env);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "pin envelope failed contracts validation",
      v.errors,
    );
  }
  return env;
}

// ─── Unpin ────────────────────────────────────────────────────────────────────
export function buildUnpinOperation(
  memory: MemoryRecord,
  context: GovernanceContext,
  reason?: string,
): MemoryUnpin {
  if (!memory.pinned) {
    throw new GovernanceError("idempotent-noop", `memory ${memory.id} is not pinned`, [
      `memoryId: ${memory.id}`,
    ]);
  }
  const env: MemoryUnpin = {
    schemaVersion: "1",
    memoryId: memory.id,
    reviewerId: context.reviewerId,
    unpinnedAt: context.nowMs,
    ...(reason !== undefined ? { reason } : {}),
  };
  const v = validateMemoryUnpin(env);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "unpin envelope failed contracts validation",
      v.errors,
    );
  }
  return env;
}

// ─── Archive ──────────────────────────────────────────────────────────────────
function assertArchivable(memory: MemoryRecord): void {
  if (memory.status === "archived") {
    throw new GovernanceError("idempotent-noop", `memory ${memory.id} is already archived`, [
      `memoryId: ${memory.id}`,
    ]);
  }
  if (memory.status === "forgotten") {
    throw new GovernanceError(
      "memory-not-eligible",
      `memory ${memory.id} is forgotten and cannot be archived`,
      [`memoryId: ${memory.id}`, `status: ${memory.status}`],
    );
  }
  const check = checkStatusTransition(memory.status, "archived");
  if (!check.ok) {
    throw new GovernanceError(
      "illegal-status-transition",
      check.reason ?? `illegal transition: ${memory.status} -> archived`,
      [`memoryId: ${memory.id}`, `from: ${memory.status}`, `to: archived`],
    );
  }
}

export function buildArchiveOperation(
  memory: MemoryRecord,
  context: GovernanceContext,
  reason?: string,
): MemoryArchive {
  assertArchivable(memory);
  const env: MemoryArchive = {
    schemaVersion: "1",
    memoryId: memory.id,
    reviewerId: context.reviewerId,
    archivedAt: context.nowMs,
    ...(reason !== undefined ? { reason } : {}),
  };
  const v = validateMemoryArchive(env);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "archive envelope failed contracts validation",
      v.errors,
    );
  }
  return env;
}
