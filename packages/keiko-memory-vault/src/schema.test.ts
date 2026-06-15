import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_VAULT_SCHEMA_VERSION, runMigrations } from "./schema.js";
import { TEST_CIPHER } from "./_support.js";

function openMemDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  return row.user_version ?? 0;
}

describe("runMigrations", () => {
  it("brings a fresh DB to the current schema version", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent on re-run", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    runMigrations(db, TEST_CIPHER);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("migrates an empty user_version=0 DB forward to the current version", () => {
    const db = openMemDb();
    expect(userVersion(db)).toBe(0);
    runMigrations(db, TEST_CIPHER);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("lands a fresh DB on the current schema head even though encryption keys to v2", () => {
    // Regression guard: the encryption sweep is keyed to ENCRYPTION_VERSION (2) but must NOT pin
    // user_version to 2 — later DDL migrations own the head.
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("upgrades a v2 DB forward to the current schema head by applying only later DDL", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    // Simulate a genuine pre-v3 (encryption-era) database: the access table did not exist and the
    // version sat at the encryption head. Dropping the table + regressing the version reproduces
    // the on-disk shape a v2 DB actually has before this migration runs.
    db.exec("DROP TABLE memory_access");
    db.exec("DROP INDEX idx_tombstones_scope");
    db.exec("DROP INDEX idx_tombstones_memory_id");
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
    db.exec("PRAGMA user_version = 2");
    runMigrations(db, TEST_CIPHER);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    const hasAccess = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memory_access'")
      .get() as { name?: string } | undefined;
    expect(hasAccess?.name).toBe("memory_access");
    const tombstoneColumns = db
      .prepare("PRAGMA table_info(memory_tombstones)")
      .all() as unknown as readonly { name: string }[];
    expect(tombstoneColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["reviewer_id", "original_status"]),
    );
    const retrievalIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get("idx_memories_scope_created") as { name?: string } | undefined;
    expect(retrievalIndex?.name).toBe("idx_memories_scope_created");
    db.close();
  });

  it("creates all five tables", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as readonly { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "memories",
      "memory_access",
      "memory_edges",
      "memory_embeddings",
      "memory_tombstones",
    ]);
    db.close();
  });

  it("creates the expected indexes", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as unknown as readonly { name: string }[];
    expect(idx.map((i) => i.name)).toEqual([
      "idx_edges_from",
      "idx_edges_from_created",
      "idx_edges_to",
      "idx_edges_to_created",
      "idx_memories_pinned",
      "idx_memories_scope",
      "idx_memories_scope_created",
      "idx_memories_scope_status",
      "idx_memories_scope_type",
      "idx_memories_updated_at",
      "idx_memories_valid_until",
      "idx_memory_access_last",
      "idx_tombstones_memory_id",
      "idx_tombstones_scope",
    ]);
    db.close();
  });
});

describe("STRICT-table type enforcement", () => {
  it("rejects a wrong-type insert via raw prepare", () => {
    const db = openMemDb();
    runMigrations(db, TEST_CIPHER);
    // confidence is REAL NOT NULL; passing a TEXT-shaped non-numeric value should error under STRICT.
    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (id, schema_version, type, scope_kind, scope_coordinate, body, " +
            "status, sensitivity, confidence, valid_from, tags_json, source_kind, captured_at, " +
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "m1",
          "1",
          "preference",
          "user",
          "u-1",
          "body",
          "active",
          "internal",
          "not-a-number",
          1,
          "[]",
          "user",
          1,
          1,
          1,
        ),
    ).toThrow();
    db.close();
  });
});
