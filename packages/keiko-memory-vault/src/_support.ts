// Shared deterministic test cipher (ADR-0035). A fixed 32-byte key keeps row-layer tests
// reproducible while exercising the real AES-256-GCM seal/open path — the encryption is never
// stubbed, so a regression in the cipher surfaces in these tests, not just the dedicated ones.

import { DatabaseSync } from "node:sqlite";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { makeMemoryRecord } from "@oscharko-dev/keiko-contracts/memory-fixtures";
import { createMemoryContentCipher } from "./cipher.js";
import { runMigrations } from "./schema.js";

export const TEST_CIPHER = createMemoryContentCipher(Buffer.alloc(32, 7));

export function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, TEST_CIPHER);
  return db;
}

// Minimal valid MemoryRecord fixture for row-layer suites. Wraps the sanctioned contracts
// fixture builder (`makeMemoryRecord`, GEN-DX-001) and preserves this suite's historical body
// default ("prefers dark mode"), which the shared builder spells more verbosely. Caller
// overrides win over that body default because they are applied last.
export function makeRecord(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">,
): MemoryRecord {
  return makeMemoryRecord({ body: "prefers dark mode", ...overrides });
}

export function memId(value: string): MemoryId {
  return value as MemoryId;
}
