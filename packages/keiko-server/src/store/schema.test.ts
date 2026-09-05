import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MIGRATIONS, runMigrations } from "./schema.js";

// KEIKO-0573: runMigrations filters and applies pending migrations in declaration order (no
// .sort()), so the array's order-of-declaration is trusted to equal ascending version order. This
// test pins the invariant so a future migration added out of position fails here before it can
// reach a real on-disk database.
describe("keiko-server store MIGRATIONS", () => {
  it("starts at version 1 and is strictly increasing", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0]?.version).toBe(1);
    let previous = 0;
    for (const m of MIGRATIONS) {
      expect(m.version).toBeGreaterThan(previous);
      previous = m.version;
    }
  });
});

// Issue #3400 (epic #3384) — the v28 migration is the first to widen the `relationships` V5
// CHECK constraint, which SQLite cannot ALTER, so the table is rebuilt. Unlike the V20 rebuild
// precedent, `relationships` has a live child foreign key
// (`relationship_lifecycle_history.relationship_id ... ON DELETE CASCADE`), and migrations run
// with `PRAGMA foreign_keys = ON` (db.ts's `preparedDatabase`) inside one transaction — so a naive
// `DROP TABLE relationships` would cascade-delete every history row. These tests run with foreign
// keys ON, exactly like production, to prove the rebuild does not lose data.
function openWithForeignKeys(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// Applies every migration up to (and including) `uptoVersion` directly, bypassing the exported
// `runMigrations` (which always advances to the full current SCHEMA_VERSION), so a test can seed
// data at a known pre-v28 schema state and then apply v28 alone via the real exported runner.
function applyMigrationsUpTo(db: DatabaseSync, uptoVersion: number): void {
  db.exec("BEGIN");
  for (const migration of MIGRATIONS) {
    if (migration.version > uptoVersion) break;
    db.exec(migration.sql);
    migration.apply?.(db);
  }
  db.exec(`PRAGMA user_version = ${String(uptoVersion)}`);
  db.exec("COMMIT");
}

describe("v28 migration — relationships CHECK widening (Issue #3400)", () => {
  it("denies a git-change row at v27 and admits one after v28 (failing-before/passing-after)", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 27);
    const insertGitChangeRow = (): void => {
      db.prepare(
        `INSERT INTO relationships (
          id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
          source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at, etag
        ) VALUES ('rel-1','1','ws','workspace','coord','reads-context','chat','chat-1',
          'git-change','gc-1','active',1,1,'etag-1')`,
      ).run();
    };
    expect(insertGitChangeRow).toThrow(/CHECK constraint failed/);

    runMigrations(db);
    expect(insertGitChangeRow).not.toThrow();
    const row = db.prepare("SELECT * FROM relationships WHERE id = 'rel-1'").get() as {
      target_kind: string;
    };
    expect(row.target_kind).toBe("git-change");
  });

  it("preserves relationship_lifecycle_history rows through the v28 rebuild", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 27);
    db.exec(`
      INSERT INTO relationships (
        id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
        source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at, etag
      ) VALUES ('rel-2','1','ws','workspace','coord','reads-context','chat','chat-1',
        'memory','mem-1','active',1,1,'etag-2');
      INSERT INTO relationship_lifecycle_history (
        id, relationship_id, from_state, to_state, occurred_at, summary
      ) VALUES ('hist-1','rel-2','draft','active',1,'created');
    `);

    runMigrations(db);

    const history = db
      .prepare("SELECT * FROM relationship_lifecycle_history WHERE id = 'hist-1'")
      .get() as { relationship_id: string; from_state: string; to_state: string } | undefined;
    expect(history).toBeDefined();
    expect(history?.relationship_id).toBe("rel-2");
    expect(history?.from_state).toBe("draft");
    expect(history?.to_state).toBe("active");

    // The rebuilt foreign key must be LIVE against the new `relationships` table, not orphaned
    // against the dropped `relationships_v27` — proven by an actual cascade.
    db.exec("DELETE FROM relationships WHERE id = 'rel-2'");
    const afterDelete = db
      .prepare("SELECT * FROM relationship_lifecycle_history WHERE id = 'hist-1'")
      .get();
    expect(afterDelete).toBeUndefined();
  });

  it("adds the chats.git_change_scope_json column, defaulting to NULL", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 27);
    db.exec(`
      INSERT INTO projects (path, name, created_at, last_opened_at) VALUES ('/p','p',1,1);
      INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)
        VALUES ('c1','/p','t','m',1,1);
    `);
    runMigrations(db);
    const row = db.prepare("SELECT git_change_scope_json FROM chats WHERE id = 'c1'").get() as {
      git_change_scope_json: string | null;
    };
    expect(row.git_change_scope_json).toBeNull();
  });
});
