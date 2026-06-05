import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_VAULT_SCHEMA_VERSION, runMigrations } from "./schema.js";

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
  it("brings a fresh DB to schema version 1", () => {
    const db = openMemDb();
    runMigrations(db);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent on re-run", () => {
    const db = openMemDb();
    runMigrations(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("migrates an empty user_version=0 DB forward to V1", () => {
    const db = openMemDb();
    expect(userVersion(db)).toBe(0);
    runMigrations(db);
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  it("creates all four tables", () => {
    const db = openMemDb();
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as readonly { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "memories",
      "memory_edges",
      "memory_embeddings",
      "memory_tombstones",
    ]);
    db.close();
  });

  it("creates the expected indexes", () => {
    const db = openMemDb();
    runMigrations(db);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as unknown as readonly { name: string }[];
    expect(idx.map((i) => i.name)).toEqual([
      "idx_edges_from",
      "idx_edges_to",
      "idx_memories_pinned",
      "idx_memories_scope",
      "idx_memories_scope_status",
      "idx_memories_scope_type",
      "idx_memories_updated_at",
      "idx_memories_valid_until",
      "idx_tombstones_memory_id",
      "idx_tombstones_scope",
    ]);
    db.close();
  });
});

describe("STRICT-table type enforcement", () => {
  it("rejects a wrong-type insert via raw prepare", () => {
    const db = openMemDb();
    runMigrations(db);
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
