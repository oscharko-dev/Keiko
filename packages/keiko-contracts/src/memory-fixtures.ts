// Sanctioned MemoryRecord fixture builder (GEN-DX-001).
//
// Every memory-touching test in the monorepo had hand-rolled a "valid MemoryRecord" literal,
// and they drifted: different default types, sensitivities, and timestamps. That made a change
// to the record contract expensive to propagate and let stale fixtures pass validation for the
// wrong reasons. `makeMemoryRecord` is the single canonical builder, seeded with the MAJORITY
// default set observed across those fixtures, whose output always validates against the real
// `validateMemoryRecord` contract validator.
//
// This is a testing-only subpath (`@oscharko-dev/keiko-contracts/memory-fixtures`); it stays a
// pure leaf (no IO, no clock, no randomness) and reuses the canonical `MemoryRecord` type from
// contracts so a contract change surfaces here at compile time.

import type { MemoryRecord } from "./memory-records.js";
import type { MemoryScope, UserId } from "./memory.js";

/**
 * Fixed epoch-ms "now" used by the fixture defaults. Exported so tests that assert on the
 * default timestamps have a stable reference instead of re-typing the literal.
 */
export const FIXED_NOW_MS = 1_700_000_000_000;

const DEFAULT_SCOPE: MemoryScope = { kind: "user", userId: "u-1" as UserId };

/**
 * Build a valid `MemoryRecord` from the majority default set, applying `overrides` last.
 *
 * Defaults: type "preference", sensitivity "confidential" (on the provenance envelope),
 * `capturedAt` / `createdAt` / `updatedAt` / `validFrom` = `FIXED_NOW_MS`, confidence 0.9,
 * id "m-1", user scope "u-1", status "accepted". The output validates against
 * `validateMemoryRecord`.
 */
export function makeMemoryRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  const base: MemoryRecord = {
    id: "m-1" as MemoryRecord["id"],
    schemaVersion: "1",
    scope: DEFAULT_SCOPE,
    type: "preference",
    body: "Prefers dark mode across all windows.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: FIXED_NOW_MS,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: FIXED_NOW_MS },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: FIXED_NOW_MS,
    updatedAt: FIXED_NOW_MS,
  };
  return { ...base, ...overrides };
}
