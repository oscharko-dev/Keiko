// Shared deterministic test cipher (ADR-0035). A fixed 32-byte key keeps row-layer tests
// reproducible while exercising the real AES-256-GCM seal/open path — the encryption is never
// stubbed, so a regression in the cipher surfaces in these tests, not just the dedicated ones.

import { DatabaseSync } from "node:sqlite";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryContentCipher } from "./cipher.js";
import { runMigrations } from "./schema.js";

export const TEST_CIPHER = createMemoryContentCipher(Buffer.alloc(32, 7));

export function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, TEST_CIPHER);
  return db;
}

// Minimal valid MemoryRecord fixture for row-layer suites. Mirrors the inline `makeMemory` in
// vault.test.ts so access/maintenance suites do not duplicate the provenance shape.
export function makeRecord(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">,
): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: t,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: t },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

export function memId(value: string): MemoryId {
  return value as MemoryId;
}
