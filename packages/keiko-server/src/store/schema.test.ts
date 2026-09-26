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

// Owner audit finding b1-20 (PR #3394): only v28 had a forward-migration test; v21-v27 and v29 (all
// added by this PR) had none. Each test below applies migrations only up to the version BEFORE the
// one under test, then runs the real `runMigrations` and asserts the exact structural change that
// version's own `V<n>_SQL` documents — proving the forward path, not just the fully-migrated shape
// every other suite in this repo already exercises incidentally.
const DIGEST_64 = "a".repeat(64);

function insertMinimalCodingRuntimeSnapshot(db: DatabaseSync, runId: string): void {
  db.exec(`
    INSERT INTO coding_runtime_snapshots (
      run_id, schema_version, state, revision, requested_mode, runtime_source, model_source,
      created_at, updated_at, task_digest, workspace_digest, operator_digest,
      authority_digest, binding_digest, provenance_digest
    ) VALUES (
      '${runId}', '1', 'starting', 1, 'governed-assist', 'keiko-sidecar',
      'keiko-model-gateway', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '${DIGEST_64}', '${DIGEST_64}', '${DIGEST_64}', '${DIGEST_64}', '${DIGEST_64}', '${DIGEST_64}'
    );
  `);
}

describe("forward migrations v21-v27, v29, v30 (Owner audit finding b1-20)", () => {
  it("v21 creates github_issue_reader_authorization with the documented CHECK", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 20);
    runMigrations(db);
    db.exec(`
      INSERT INTO github_issue_reader_authorization (repository_id, authorized, revision, updated_at)
      VALUES ('repo-1', 1, 0, '2026-01-01T00:00:00.000Z');
    `);
    const row = db
      .prepare(
        "SELECT authorized FROM github_issue_reader_authorization WHERE repository_id = 'repo-1'",
      )
      .get() as { authorized: number };
    expect(row.authorized).toBe(1);
    expect(() => {
      db.exec(
        "INSERT INTO github_issue_reader_authorization (repository_id, authorized, revision, updated_at) VALUES ('repo-2', 2, 0, 'x')",
      );
    }).toThrow(/CHECK constraint failed/);
  });

  it("v22 adds the seven issue_* columns to coding_runtime_snapshots, existing rows NULL", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 21);
    insertMinimalCodingRuntimeSnapshot(db, "run-v22");
    runMigrations(db);
    const row = db
      .prepare(
        "SELECT issue_repository_id, issue_number FROM coding_runtime_snapshots WHERE run_id = 'run-v22'",
      )
      .get() as { issue_repository_id: string | null; issue_number: number | null };
    expect(row.issue_repository_id).toBeNull();
    expect(row.issue_number).toBeNull();
  });

  it("v23 adds verified_commit_result as a body-free JSON column", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 22);
    insertMinimalCodingRuntimeSnapshot(db, "run-v23");
    runMigrations(db);
    expect(() => {
      db.exec(
        "UPDATE coding_runtime_snapshots SET verified_commit_result = 'not-json' WHERE run_id = 'run-v23'",
      );
    }).toThrow(/CHECK constraint failed/);
    db.exec(
      `UPDATE coding_runtime_snapshots SET verified_commit_result = '{"ok":true}' WHERE run_id = 'run-v23'`,
    );
    const row = db
      .prepare(
        "SELECT verified_commit_result FROM coding_runtime_snapshots WHERE run_id = 'run-v23'",
      )
      .get() as { verified_commit_result: string };
    expect(row.verified_commit_result).toBe('{"ok":true}');
  });

  it("v24 adds draft_delivery_record as a body-free JSON column", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 23);
    insertMinimalCodingRuntimeSnapshot(db, "run-v24");
    runMigrations(db);
    const columns = (
      db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("draft_delivery_record");
  });

  it("v25 adds draft_delivery_source_receipt as a body-free JSON column", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 24);
    insertMinimalCodingRuntimeSnapshot(db, "run-v25");
    runMigrations(db);
    const columns = (
      db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("draft_delivery_source_receipt");
  });

  it("v26 adds verified-commit accounting columns and the ci-repair budget table", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 25);
    insertMinimalCodingRuntimeSnapshot(db, "run-v26");
    runMigrations(db);
    const columns = (
      db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "last_successful_verified_commit",
        "ci_observation_revision",
        "ci_readiness_record",
      ]),
    );
    db.exec(`
      INSERT INTO coding_runtime_ci_repair_budgets (
        task_digest, remote_digest, pr_number, revision, record_json
      ) VALUES ('${DIGEST_64}', '${DIGEST_64}', 1, 0, '{}');
    `);
    const row = db
      .prepare(
        `SELECT pr_number FROM coding_runtime_ci_repair_budgets WHERE task_digest = '${DIGEST_64}'`,
      )
      .get() as { pr_number: number };
    expect(row.pr_number).toBe(1);
  });

  it("v27 creates the content-free git_journey_outcomes projection", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 26);
    runMigrations(db);
    db.exec(`
      INSERT INTO git_journey_outcomes (
        remote_digest, pr_number, run_id, revision, state, reason, head_sha, evidence_ref,
        observed_at, updated_at
      ) VALUES (
        '${DIGEST_64}', 1, 'run-v27', 0, 'ready', 'checks-green', 'aaaaaaa', 'ev-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    const row = db
      .prepare("SELECT state FROM git_journey_outcomes WHERE run_id = 'run-v27'")
      .get() as { state: string };
    expect(row.state).toBe("ready");
  });

  it("v29 creates the deduplicated coding_runtime_description_jobs ledger", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 28);
    runMigrations(db);
    db.exec(`
      INSERT INTO coding_runtime_description_jobs (
        run_id, remote_digest, base_sha, head_sha, generation_version, revision, phase, updated_at
      ) VALUES (
        'run-v29', '${DIGEST_64}', '${"b".repeat(40)}', '${"c".repeat(40)}', 1, 0, 'dispatched',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    expect(() => {
      db.exec(
        `UPDATE coding_runtime_description_jobs SET status_json = '{}' WHERE run_id = 'run-v29'`,
      );
    }).toThrow(/CHECK constraint failed/);
    db.exec(
      `UPDATE coding_runtime_description_jobs SET phase = 'settled', status_json = '{}' WHERE run_id = 'run-v29'`,
    );
    const row = db
      .prepare("SELECT phase FROM coding_runtime_description_jobs WHERE run_id = 'run-v29'")
      .get() as { phase: string };
    expect(row.phase).toBe("settled");
  });

  it("v30 widens failure_code to admit issue-context-unavailable and question-answer-rejected", () => {
    const db = openWithForeignKeys();
    applyMigrationsUpTo(db, 29);
    insertMinimalCodingRuntimeSnapshot(db, "run-v30");
    expect(() => {
      db.exec(
        "UPDATE coding_runtime_snapshots SET failure_code = 'question-answer-rejected' WHERE run_id = 'run-v30'",
      );
    }).toThrow(/CHECK constraint failed/);

    runMigrations(db);

    db.exec(
      "UPDATE coding_runtime_snapshots SET failure_code = 'question-answer-rejected' WHERE run_id = 'run-v30'",
    );
    db.exec(
      "UPDATE coding_runtime_snapshots SET failure_code = 'issue-context-unavailable' WHERE run_id = 'run-v30'",
    );
    const row = db
      .prepare("SELECT failure_code FROM coding_runtime_snapshots WHERE run_id = 'run-v30'")
      .get() as { failure_code: string };
    expect(row.failure_code).toBe("issue-context-unavailable");
  });
});
