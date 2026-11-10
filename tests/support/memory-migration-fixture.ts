import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../packages/keiko-memory-vault/src/schema.js";
import { insertMemoryRow } from "../../packages/keiko-memory-vault/src/memories.js";
import { makeRecord, memId, TEST_CIPHER } from "../../packages/keiko-memory-vault/src/_support.js";

/** Real V12 DDL with the missing legacy column observed in the startup incident. */
export function seedBrokenV12MemoryVault(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) {
      if (migration.version > 12) break;
      db.exec(migration.sql);
    }
    db.exec(
      "PRAGMA user_version = 12; ALTER TABLE memory_access DROP COLUMN last_accessed_conversation_id",
    );
    const id = memId("memory-migration-fixture");
    insertMemoryRow(db, makeRecord({ id, body: "migration-row-canary" }), TEST_CIPHER);
    db.prepare(
      "INSERT INTO memory_access (memory_id, last_accessed_at, access_count) VALUES (?, 1000, 3)",
    ).run(id);
  } finally {
    db.close();
  }
}

export function memoryMigrationSnapshot(path: string): Readonly<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      memories: db.prepare("SELECT * FROM memories ORDER BY id").all(),
      access: db.prepare("SELECT * FROM memory_access ORDER BY memory_id").all(),
      schema: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    };
  } finally {
    db.close();
  }
}
