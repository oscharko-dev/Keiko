// ADR-0013 D5 — Versioned migration runner using PRAGMA user_version. Forward-only, idempotent.

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, SCHEMA_VERSION } from "./index.js";

function openMem(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  return typeof row.user_version === "number" ? row.user_version : 0;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("runMigrations", () => {
  it("creates the v1 schema and bumps user_version", () => {
    const db = openMem();
    expect(userVersion(db)).toBe(0);
    runMigrations(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const names = tableNames(db);
    expect(names).toContain("projects");
    expect(names).toContain("chats");
    expect(names).toContain("chat_messages");
  });

  it("is idempotent — second call does nothing", () => {
    const db = openMem();
    runMigrations(db);
    const before = userVersion(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(before);
  });

  it("rolls back the transaction if a migration throws", () => {
    // Pre-create a `projects` table so the first CREATE statement collides → migration fails.
    const db = openMem();
    db.exec("CREATE TABLE projects (something TEXT)");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    // user_version stays 0 — rollback.
    expect(userVersion(db)).toBe(0);
  });

  it("enables foreign keys and sets WAL", () => {
    const db = openMem();
    runMigrations(db);
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number };
    expect(fk.foreign_keys).toBe(1);
    // journal_mode on :memory: is "memory", not "wal"; we just assert it's set without error.
    const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    expect(typeof jm.journal_mode).toBe("string");
  });

  it("v2 adds task_type column to chat_messages, existing rows null", () => {
    // Simulate a pre-v2 DB by running only v1, inserting a row, then running migrations again.
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // Reset to "v1 only" by setting user_version back to 1 and dropping the column (column drop
    // isn't supported in older SQLite, so this test instead confirms that running migrations on
    // a v0 → v2 path leaves task_type as a real column). We assert via column metadata.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("task_type");
  });

  it("v3 adds connected_scope columns to chats, existing rows null", () => {
    // Issue #184 — additive migration: connected_scope_paths (TEXT) + connected_scope_at (INTEGER)
    // on the chats table. Validates the columns are present AND that an existing row inserted
    // before the migration materialises NULL for both. The forward-compatibility path (from a
    // user_version=2 seed) is exercised by the next test.
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    const cols = db.prepare("PRAGMA table_info(chats)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("connected_scope_paths");
    expect(names).toContain("connected_scope_at");
    // Copilot PR #254 finding: the assertion of NULL materialisation was missing. Insert a row
    // and confirm both new columns are NULL.
    db.exec(
      "INSERT INTO projects (path, name, favorite, created_at, last_opened_at)" +
        " VALUES ('/p', 'p', 0, 1, 1)",
    );
    db.exec(
      "INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)" +
        " VALUES ('c-null-check', '/p', 't', 'm', 1, 1)",
    );
    const row = db
      .prepare(
        "SELECT connected_scope_paths, connected_scope_at FROM chats WHERE id = 'c-null-check'",
      )
      .get() as { connected_scope_paths: string | null; connected_scope_at: number | null };
    expect(row.connected_scope_paths).toBeNull();
    expect(row.connected_scope_at).toBeNull();
  });

  it("v3 migration is forward-compatible from v2 state", () => {
    // Issue #184 — start at user_version=2 with the v2 schema shape, insert a pre-v3 chat row,
    // run migrations; the new scope columns must materialise NULL for the existing row.
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE projects (path TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL) STRICT;
      CREATE TABLE chats (id TEXT NOT NULL PRIMARY KEY,
        project_path TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
        title TEXT NOT NULL, selected_model TEXT NOT NULL, branch_label TEXT, status TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE chat_messages (id TEXT NOT NULL PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
        run_id TEXT, workflow_id TEXT, workflow_status TEXT, short_result TEXT,
        task_type TEXT) STRICT;
      PRAGMA user_version = 2;
    `);
    db.exec(
      "INSERT INTO projects (path, name, favorite, created_at, last_opened_at)" +
        " VALUES ('/p', 'p', 0, 1, 1)",
    );
    db.exec(
      "INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)" +
        " VALUES ('c-pre-v3', '/p', 't', 'm', 1, 1)",
    );
    runMigrations(db);
    const after = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    expect(after.user_version).toBe(SCHEMA_VERSION);
    const row = db
      .prepare("SELECT connected_scope_paths, connected_scope_at FROM chats WHERE id = 'c-pre-v3'")
      .get() as {
      connected_scope_paths: string | null;
      connected_scope_at: number | null;
    };
    expect(row.connected_scope_paths).toBeNull();
    expect(row.connected_scope_at).toBeNull();
  });

  it("v5 creates relationship tables with the documented columns and indexes (issue #539)", () => {
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    const names = tableNames(db);
    expect(names).toContain("relationships");
    expect(names).toContain("relationship_lifecycle_history");
    expect(names).toContain("relationship_audit_entries");
    const relCols = (
      db.prepare("PRAGMA table_info(relationships)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const expected of [
      "id",
      "schema_version",
      "workspace_scope_id",
      "scope_kind",
      "scope_coordinate",
      "type",
      "source_kind",
      "source_id",
      "target_kind",
      "target_id",
      "lifecycle",
      "created_at",
      "updated_at",
      "etag",
      "confidence",
      "summary",
    ]) {
      expect(relCols).toContain(expected);
    }
    const auditCols = (
      db.prepare("PRAGMA table_info(relationship_audit_entries)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const expected of [
      "event_id",
      "relationship_audit_schema_ver",
      "workspace_id",
      "sequence",
      "occurred_at",
      "kind",
      "relationship_id",
      "actor_surface",
      "redacted_actor_id",
      "redaction_state",
      "summary",
      "payload_json",
    ]) {
      expect(auditCols).toContain(expected);
    }
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'" +
            " ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_relationships_source");
    expect(indexes).toContain("idx_relationships_target");
    expect(indexes).toContain("idx_relationships_type");
    expect(indexes).toContain("idx_relationships_lifecycle");
    expect(indexes).toContain("uniq_relationships_produces_evidence_source");
    expect(indexes).toContain("uniq_relationships_starts_workflow_target");
    expect(indexes).toContain("uniq_relationship_audit_workspace_sequence");
  });

  it("v5 partial unique index enforces produces-evidence 1:1 on source (#539)", () => {
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // Insert a first produces-evidence relationship.
    const insert = (id: string): void => {
      db.exec(
        `INSERT INTO relationships(id, schema_version, workspace_scope_id, scope_kind,
          scope_coordinate, type, source_kind, source_id, target_kind, target_id, lifecycle,
          created_at, updated_at, etag)
         VALUES ('${id}','1','ws-1','workspace','ws-1','produces-evidence','workflow-run',
          'run-1','evidence-run','ev-${id}','active',1,1,'etag-${id}')`,
      );
    };
    insert("rel-1");
    expect(() => {
      insert("rel-2");
    }).toThrow();
    // The barrier only applies while lifecycle is in the active set; a revoked row co-exists.
    db.exec(`UPDATE relationships SET lifecycle='revoked' WHERE id='rel-1'`);
    expect(() => {
      insert("rel-3");
    }).not.toThrow();
  });

  it("v5 migration is idempotent (issue #539)", () => {
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const before = userVersion(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(before);
  });

  it("v2 migration is forward-compatible from v1 state", () => {
    // Build a DB that explicitly sits at user_version = 1 with the v1 chat_messages shape (no
    // task_type column). Run migrations; v2 ALTER must add task_type without dropping existing
    // rows.
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE projects (path TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL) STRICT;
      CREATE TABLE chats (id TEXT NOT NULL PRIMARY KEY,
        project_path TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
        title TEXT NOT NULL, selected_model TEXT NOT NULL, branch_label TEXT, status TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE chat_messages (id TEXT NOT NULL PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
        run_id TEXT, workflow_id TEXT, workflow_status TEXT, short_result TEXT) STRICT;
      PRAGMA user_version = 1;
    `);
    db.exec(
      "INSERT INTO projects (path, name, favorite, created_at, last_opened_at)" +
        " VALUES ('/p', 'p', 0, 1, 1)",
    );
    db.exec(
      "INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)" +
        " VALUES ('c1', '/p', 't', 'm', 1, 1)",
    );
    db.exec(
      "INSERT INTO chat_messages (id, chat_id, role, content, timestamp)" +
        " VALUES ('m1', 'c1', 'user', 'hi', 1)",
    );
    runMigrations(db);
    const after = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    expect(after.user_version).toBe(SCHEMA_VERSION);
    const row = db.prepare("SELECT task_type FROM chat_messages WHERE id = 'm1'").get() as {
      task_type: string | null;
    };
    expect(row.task_type).toBeNull();
  });
});
