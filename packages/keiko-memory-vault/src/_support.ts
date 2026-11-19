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

// The two on-disk migration probes seed current encrypted rows before replacing their fields
// with the historical plaintext fixture. Reopen must then apply every later DDL migration.
export function rewindPlaintextFixtureSchema(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER memory_sources_insert;
    DROP TRIGGER memory_sources_update;
    DROP TABLE memory_message_sources;`);
  db.exec("ALTER TABLE memories DROP COLUMN evidence_span");
  db.exec("ALTER TABLE memories DROP COLUMN source_message_ids_json");
  db.exec("DROP TABLE IF EXISTS memory_conversation_touches");
  db.exec("DROP TABLE IF EXISTS memory_access");
  db.exec("DROP INDEX IF EXISTS idx_tombstones_scope");
  db.exec("DROP INDEX IF EXISTS idx_tombstones_memory_id");
  db.exec("DROP TABLE memory_tombstones");
  db.exec(`
    CREATE TABLE memory_tombstones (
      id TEXT NOT NULL PRIMARY KEY,
      memory_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_coordinate TEXT NOT NULL,
      type TEXT NOT NULL,
      forgotten_at INTEGER NOT NULL,
      forgetter_surface TEXT NOT NULL,
      reason TEXT
    ) STRICT;
    CREATE INDEX idx_tombstones_scope ON memory_tombstones(scope_kind, scope_coordinate);
    CREATE INDEX idx_tombstones_memory_id ON memory_tombstones(memory_id);
  `);
  db.exec("PRAGMA user_version = 1");
}
