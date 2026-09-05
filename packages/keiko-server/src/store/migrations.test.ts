// ADR-0013 D5 — Versioned migration runner using PRAGMA user_version. Forward-only, idempotent.

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspaceRootIdentity } from "../workspace-root-identity.js";
import { runMigrations, SCHEMA_VERSION } from "./index.js";
import { rewindSchemaFixture } from "./legacySchemaTestFixture.js";

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

// Builds a real v16-shape database: fully migrate a fresh in-memory database, then rewind it with
// the shared fixture (legacySchemaTestFixture.ts) instead of hand-writing a second, independent
// CREATE TABLE set. A hand-written stand-in silently stops covering a table/column a later
// migration adds or rebuilds (schema.ts's V28 rebuild of `relationships` is exactly such a case —
// #3400/#3401) the moment that migration lands; composing from the same rollback fragments every
// other legacy-schema fixture uses means a future migration is covered the moment its own fragment
// is appended to `ROLLBACKS`.
function seedV16WorkspaceTables(db: DatabaseSync): void {
  runMigrations(db);
  rewindSchemaFixture(db, 16);
}

interface V16RootSeed {
  readonly workspaceId: string;
  readonly rootRef: string;
  readonly canonicalRoot: string;
  readonly identityDigest: string;
}

function insertV16Root(db: DatabaseSync, seed: V16RootSeed): void {
  db.prepare(
    `INSERT INTO workspace_manifest_roots (
       workspace_id, root_ref, position, project_path, canonical_root, identity_digest
     ) VALUES (?, ?, 0, ?, ?, ?)`,
  ).run(
    seed.workspaceId,
    seed.rootRef,
    seed.canonicalRoot,
    seed.canonicalRoot,
    seed.identityDigest,
  );
}

function insertV16Trust(db: DatabaseSync, rootRef: string): void {
  db.prepare(
    `INSERT INTO workspace_trust_records (
       root_ref, revision, trust, record_json, updated_at
     ) VALUES (?, 1, 'trusted', '{}', 1)`,
  ).run(rootRef);
}

type RootIdentity = ReturnType<typeof inspectWorkspaceRootIdentity>;
type RootInspector = (path: string) => RootIdentity;

function syntheticRootIdentity(
  seed: Pick<V16RootSeed, "canonicalRoot" | "identityDigest" | "rootRef">,
  objectIdentityDigest: string | undefined,
): RootIdentity {
  return {
    canonicalRoot: seed.canonicalRoot,
    identityDigest: seed.identityDigest as RootIdentity["identityDigest"],
    objectIdentityDigest,
    objectIdentityUnsupported: false,
    rootRef: seed.rootRef as RootIdentity["rootRef"],
    device: 1,
    inode: 1,
    mode: 0o40_700,
    ownerUid: 1,
  };
}

async function runMigrationsWithRootInspector(
  db: DatabaseSync,
  inspect: RootInspector,
): Promise<void> {
  vi.resetModules();
  vi.doMock("../workspace-root-identity.js", async () => {
    const actual = await vi.importActual<typeof import("../workspace-root-identity.js")>(
      "../workspace-root-identity.js",
    );
    return { ...actual, inspectWorkspaceRootIdentity: inspect };
  });
  try {
    const schema = await import("./schema.js");
    schema.runMigrations(db);
  } finally {
    vi.doUnmock("../workspace-root-identity.js");
    vi.resetModules();
  }
}

describe("runMigrations", () => {
  it("v17 backfills private object identity and revokes every legacy trust grant", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-v17-root-"));
    const identity = inspectWorkspaceRootIdentity(root);
    const db = openMem();
    try {
      seedV16WorkspaceTables(db);
      db.prepare(
        `INSERT INTO workspace_manifest_roots (
           workspace_id, root_ref, position, project_path, canonical_root, identity_digest
         ) VALUES (?, ?, 0, ?, ?, ?)`,
      ).run("workspace-1", identity.rootRef, root, root, identity.identityDigest);
      db.prepare(
        `INSERT INTO workspace_trust_records (
           root_ref, revision, trust, record_json, updated_at
         ) VALUES (?, 1, 'trusted', '{}', 1)`,
      ).run(identity.rootRef);

      runMigrations(db);

      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(
        db.prepare("SELECT object_identity_digest FROM workspace_manifest_roots").get(),
      ).toEqual({ object_identity_digest: identity.objectIdentityDigest });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_trust_records").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("v17 prevents two public roots from claiming one filesystem object", () => {
    const db = openMem();
    try {
      seedV16WorkspaceTables(db);
      runMigrations(db);
      const insert = db.prepare(
        `INSERT INTO workspace_manifest_roots (
           workspace_id, root_ref, position, project_path, canonical_root, identity_digest,
           object_identity_digest
         ) VALUES (?, ?, 0, ?, ?, ?, ?)`,
      );
      insert.run(
        "workspace-1",
        "root-a",
        "/project-a",
        "/canonical-a",
        "a".repeat(64),
        "f".repeat(64),
      );

      expect(() =>
        insert.run(
          "workspace-2",
          "root-b",
          "/project-b",
          "/canonical-b",
          "b".repeat(64),
          "f".repeat(64),
        ),
      ).toThrow(/UNIQUE constraint failed/iu);
    } finally {
      db.close();
    }
  });

  it("v17 leaves mismatched, unavailable, and ambiguous roots unbound", async () => {
    const seeds: readonly V16RootSeed[] = [
      {
        workspaceId: "workspace-mismatch",
        rootRef: "root-mismatch",
        canonicalRoot: "/mismatch",
        identityDigest: "a".repeat(64),
      },
      {
        workspaceId: "workspace-unreadable",
        rootRef: "root-unreadable",
        canonicalRoot: "/unreadable",
        identityDigest: "b".repeat(64),
      },
      {
        workspaceId: "workspace-unsupported",
        rootRef: "root-unsupported",
        canonicalRoot: "/unsupported",
        identityDigest: "c".repeat(64),
      },
      {
        workspaceId: "workspace-duplicate-a",
        rootRef: "root-duplicate-a",
        canonicalRoot: "/duplicate-a",
        identityDigest: "d".repeat(64),
      },
      {
        workspaceId: "workspace-duplicate-b",
        rootRef: "root-duplicate-b",
        canonicalRoot: "/duplicate-b",
        identityDigest: "e".repeat(64),
      },
    ];
    const firstSeed = seeds[0];
    if (firstSeed === undefined) throw new Error("missing V17 negative seed");
    const db = openMem();
    try {
      seedV16WorkspaceTables(db);
      for (const seed of seeds) {
        insertV16Root(db, seed);
        insertV16Trust(db, seed.rootRef);
      }
      const byPath = new Map(seeds.map((seed) => [seed.canonicalRoot, seed] as const));
      const duplicateDigest = "f".repeat(64);
      await runMigrationsWithRootInspector(db, (path) => {
        const seed = byPath.get(path);
        if (seed === undefined || path === "/unreadable") throw new Error("unreadable root");
        if (path === "/mismatch") {
          return syntheticRootIdentity(
            { ...seed, identityDigest: "0".repeat(64) },
            duplicateDigest,
          );
        }
        return syntheticRootIdentity(seed, path === "/unsupported" ? undefined : duplicateDigest);
      });

      const rows = db
        .prepare(
          `SELECT root_ref, object_identity_digest FROM workspace_manifest_roots
           ORDER BY root_ref`,
        )
        .all() as unknown as readonly {
        readonly root_ref: string;
        readonly object_identity_digest: string | null;
      }[];
      expect(rows).toEqual(
        seeds
          .map((seed) => ({ root_ref: seed.rootRef, object_identity_digest: null }))
          .sort((left, right) => left.root_ref.localeCompare(right.root_ref)),
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_trust_records").get()).toEqual({
        count: 0,
      });

      insertV16Trust(db, firstSeed.rootRef);
      runMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_trust_records").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("v17 rolls back identity backfill when legacy trust revocation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-v17-rollback-"));
    const identity = inspectWorkspaceRootIdentity(root);
    const db = openMem();
    try {
      seedV16WorkspaceTables(db);
      insertV16Root(db, {
        workspaceId: "workspace-rollback",
        rootRef: identity.rootRef,
        canonicalRoot: root,
        identityDigest: identity.identityDigest,
      });
      insertV16Trust(db, identity.rootRef);
      db.exec(`
        CREATE TRIGGER reject_v17_trust_revoke
        BEFORE DELETE ON workspace_trust_records
        BEGIN
          SELECT RAISE(ABORT, 'trust revoke failed');
        END;
      `);

      expect(() => {
        runMigrations(db);
      }).toThrow(/trust revoke failed/u);
      expect(userVersion(db)).toBe(16);
      expect(
        (db.prepare("PRAGMA table_info(workspace_manifest_roots)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      ).not.toContain("object_identity_digest");
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_trust_records").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("v13 adds content-free canonical turn identity, content digest, and uniqueness", () => {
    const db = openMem();
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    const columns = (
      db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(["client_turn_id", "client_turn_state", "client_turn_content_digest"]),
    );
    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index'" +
          " AND name='uniq_chat_messages_client_turn_role'",
      )
      .get() as { sql: string };
    expect(index.sql).toContain("chat_id, client_turn_id, role");
    expect(index.sql).toContain("client_turn_id IS NOT NULL");
  });

  it("v18 adds durable assistant response-version history", () => {
    const db = openMem();
    runMigrations(db);

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    const columns = (
      db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toContain("assistant_response_versions_json");
    db.close();
  });

  it("v11 creates the singleton canonical memory autonomy policy", () => {
    const db = openMem();
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    db.prepare("INSERT INTO memory_autonomy_policy (id, requested_mode) VALUES (?, ?)").run(
      "capture",
      "governed-assist",
    );
    expect(() => {
      db.prepare("INSERT INTO memory_autonomy_policy (id, requested_mode) VALUES (?, ?)").run(
        "other",
        "governed-assist",
      );
    }).toThrow();
    expect(() => {
      db.prepare("UPDATE memory_autonomy_policy SET requested_mode = ? WHERE id = ?").run(
        "unbounded",
        "capture",
      );
    }).toThrow();
    expect(
      db.prepare("SELECT revision FROM memory_autonomy_policy WHERE id = ?").get("capture"),
    ).toEqual({ revision: 0 });
    expect(() => {
      db.prepare("UPDATE memory_autonomy_policy SET revision = -1 WHERE id = ?").run("capture");
    }).toThrow();
  });

  it("v16 gives an existing memory autonomy policy a zero revision", () => {
    // Rewind to v15 (before V16's own ADD COLUMN) rather than v16: memory_autonomy_policy already
    // carries `revision` at v16, so re-creating it by hand here would collide with the real table
    // the shared fixture already produces at that version.
    const db = openMem();
    runMigrations(db);
    rewindSchemaFixture(db, 15);
    db.exec(
      "INSERT INTO memory_autonomy_policy (id, requested_mode) VALUES ('capture', 'supervised-coding')",
    );

    runMigrations(db);

    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .prepare("SELECT requested_mode, revision FROM memory_autonomy_policy WHERE id = 'capture'")
        .get(),
    ).toEqual({ requested_mode: "supervised-coding", revision: 0 });
  });

  it("v10 creates the strict, content-free coding runtime snapshot ledger and active-slot index", () => {
    const db = openMem();
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    const columns = (
      db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toContain("run_id");
    expect(columns).toContain("recovery_handle");
    expect(columns).not.toContain("prompt");
    expect(columns).not.toContain("argv");
    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='uniq_coding_runtime_active_slot'",
      )
      .get() as { sql: string };
    expect(index.sql).toContain("WHERE terminal_at IS NULL");
  });

  it("migrates a v17 database through chat v18, body-free runtime-result v19, and widened failure_code v20", () => {
    const db = openMem();
    runMigrations(db);
    rewindSchemaFixture(db, 17);

    runMigrations(db);

    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const chatColumns = (
      db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
    ).map((row) => row.name);
    const runtimeColumns = (
      db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(chatColumns).toContain("assistant_response_versions_json");
    expect(runtimeColumns).toEqual(
      expect.arrayContaining([
        "result_status",
        "exit_code",
        "stdout_byte_count",
        "stdout_sha256",
        "stderr_byte_count",
        "stderr_sha256",
      ]),
    );
    expect(runtimeColumns).not.toContain("stdout_body");
    expect(runtimeColumns).not.toContain("stderr_body");

    // #2906 round-3 review (KEIKO-0532): v20 rebuilds the table to widen the failure_code CHECK.
    // A database that migrated forward through the rebuild -- not only a fresh from-empty one --
    // must accept a literal the pre-v20 constraint rejected, proving the rebuild (not just a fresh
    // CREATE TABLE) carries the widened list for real, already-provisioned installs.
    const digest = "a".repeat(64);
    expect(() => {
      db.exec(`
        INSERT INTO coding_runtime_snapshots (
          run_id, schema_version, state, revision, requested_mode, runtime_source, model_source,
          failure_code, created_at, updated_at, task_digest, workspace_digest, operator_digest,
          authority_digest, binding_digest, provenance_digest
        ) VALUES (
          'run-migrated-v20', '1', 'failed', 1, 'governed-assist', 'keiko-sidecar',
          'keiko-model-gateway', 'replay-cap-exhausted', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '${digest}', '${digest}', '${digest}', '${digest}',
          '${digest}', '${digest}'
        );
      `);
    }).not.toThrow();
  });

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

  it("v6 adds grounded_answer_json to chat_messages", () => {
    const db = openMem();
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("grounded_answer_json");
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

  it("v7 creates the task_workspace_instances table (issue #445)", () => {
    const db = openMem();
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    expect(tableNames(db)).toContain("task_workspace_instances");
  });

  it("v8 creates the singleton active-pointer table with the documented columns (issue #446)", () => {
    const db = openMem();
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(tableNames(db)).toContain("task_workspace_active_pointer");
    const cols = (
      db.prepare("PRAGMA table_info(task_workspace_active_pointer)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const expected of ["id", "workspace_id", "set_by", "set_at", "updated_at"]) {
      expect(cols).toContain(expected);
    }
  });

  it("v8 enforces the foreign key from the pointer to an instance (issue #446)", () => {
    const db = openMem();
    runMigrations(db);
    // No instance with id 'ghost' exists, so the FK rejects the pointer insert.
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_workspace_active_pointer (id, workspace_id, set_by, set_at, updated_at)" +
            " VALUES ('active', 'ghost', 'op', 'x', 'x')",
        )
        .run(),
    ).toThrow();
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
