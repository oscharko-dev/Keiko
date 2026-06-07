// Shared deterministic test cipher (ADR-0035). A fixed 32-byte key keeps row-layer tests
// reproducible while exercising the real AES-256-GCM seal/open path — the encryption is never
// stubbed, so a regression in the cipher surfaces in these tests, not just the dedicated ones.

import { DatabaseSync } from "node:sqlite";
import { createMemoryContentCipher } from "./cipher.js";
import { runMigrations } from "./schema.js";

export const TEST_CIPHER = createMemoryContentCipher(Buffer.alloc(32, 7));

export function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, TEST_CIPHER);
  return db;
}
