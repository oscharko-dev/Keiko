// store.test.ts — integration coverage for openKnowledgeStore: schema apply, restart
// safety, corrupted-DB quarantine, migration runner, durability pragmas.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KnowledgeStoreError } from "./errors.js";
import type { KnowledgeLogEvent, KnowledgeLogSink } from "./knowledge-log.js";
import {
  computeStoreFingerprint,
  LK_STORE_BUSY_TIMEOUT_MS,
  openKnowledgeStore,
  type KnowledgeStoreKeyProvider,
} from "./store.js";
import { STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS } from "./store-content-encryption.js";

interface CountRow {
  readonly n: number;
}
interface VersionRow {
  readonly user_version: number;
}
interface JournalRow {
  readonly journal_mode: string;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-lk-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("openKnowledgeStore — fresh install", () => {
  it("applies the DDL and sets PRAGMA user_version", () => {
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db") });
    try {
      const db = store._internal.db;
      const version = db.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      expect(version.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);

      for (const table of KNOWLEDGE_CAPSULE_TABLES) {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = :n")
          .get({ n: table }) as unknown as CountRow;
        expect(row.n).toBe(1);
      }
    } finally {
      store.close();
    }
  });

  it("sets WAL journal mode and foreign_keys=ON", () => {
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db") });
    try {
      const db = store._internal.db;
      const journal = db.prepare("PRAGMA journal_mode").get() as unknown as JournalRow;
      expect(journal.journal_mode).toBe("wal");
      const fk = db.prepare("PRAGMA foreign_keys").get() as unknown as {
        readonly foreign_keys: number;
      };
      expect(fk.foreign_keys).toBe(1);
    } finally {
      store.close();
    }
  });

  it("sets PRAGMA busy_timeout to LK_STORE_BUSY_TIMEOUT_MS", () => {
    // Concurrent writes (indexing + audit INSERT) must wait for the writer lock instead of
    // failing immediately with SQLITE_BUSY. Mirrors the UI DB test in db.test.ts (#639).
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db") });
    try {
      const db = store._internal.db;
      const rows = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(LK_STORE_BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });

  it("restricts the store directory and SQLite files on POSIX", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath });
    try {
      const dbMode = statSync(dbPath).mode & 0o777;
      const dirMode = statSync(tmp).mode & 0o777;
      expect(dbMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        const sidecarMode = statSync(sidecar).mode & 0o777;
        expect(sidecarMode).toBe(0o600);
      }
    } finally {
      store.close();
    }
  });

  it("opens an encrypted-key-provider store and applies the schema", () => {
    const store = openKnowledgeStore({
      dbPath: join(tmp, "capsules.db"),
      protection: {
        mode: "encrypted-key-provider",
        keyProvider: {
          providerId: "test-provider",
          resolveKey: () => new Uint8Array(32).fill(7),
        },
      },
    });
    try {
      expect(store._internal.contentCipher.isEncrypted).toBe(true);
      const db = store._internal.db;
      const version = db.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      expect(version.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });

  it("rejects encrypted-key-provider mode without a key provider", () => {
    expect(() =>
      openKnowledgeStore({
        dbPath: join(tmp, "capsules.db"),
        protection: { mode: "encrypted-key-provider" },
      }),
    ).toThrow(/requires a keyProvider/);
  });

  it("rejects a key whose length is not 32 bytes", () => {
    expect(() =>
      openKnowledgeStore({
        dbPath: join(tmp, "capsules.db"),
        protection: {
          mode: "encrypted-key-provider",
          keyProvider: { providerId: "short", resolveKey: () => new Uint8Array(16) },
        },
      }),
    ).toThrow(/must be exactly 32 bytes/);
  });
});

describe("openKnowledgeStore — key-resolution failure closes the handle", () => {
  it("closes the open database when the key provider's resolveKey throws", () => {
    // Regression for issue #2670: resolveContentCipher ran outside the close-on-failure guard,
    // so a key-resolution failure (malformed KEIKO_LOCAL_KNOWLEDGE_KEY, throwing keychain tier)
    // leaked the already-open, migrated WAL handle on every request. A closed WAL handle
    // checkpoints and removes its -wal/-shm sidecars; a leaked one keeps holding them.
    const dbPath = join(tmp, "capsules.db");
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() =>
        openKnowledgeStore({
          dbPath,
          protection: {
            mode: "encrypted-key-provider",
            keyProvider: {
              providerId: "throwing",
              resolveKey: () => {
                throw new Error("test key tier unavailable");
              },
            },
          },
        }),
      ).toThrow(/test key tier unavailable/);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("openKnowledgeStore — restart safety", () => {
  it("rows persist across close and re-open", () => {
    const dbPath = join(tmp, "capsules.db");
    const first = openKnowledgeStore({ dbPath });
    try {
      first._internal.db
        .prepare(
          "INSERT INTO capsules (id, display_name, tags_json, retrieval_effort, output_mode, " +
            "answer_grounding_policy, embedding_model_provider, embedding_model_id, " +
            "vector_dimensions, vector_metric, lifecycle_state, storage_reference, " +
            "created_at, updated_at) VALUES (:id, :dn, '[]', 'default', 'answers', " +
            "'require-citations', 'openai', 'text-embedding-3-small', 1536, 'cosine', " +
            "'draft', 'cap-1', :now, :now)",
        )
        .run({ id: "cap-1", dn: "cap one", now: 100 });
    } finally {
      first.close();
    }

    const second = openKnowledgeStore({ dbPath });
    try {
      const row = second._internal.db
        .prepare("SELECT id, display_name FROM capsules WHERE id = :id")
        .get({ id: "cap-1" }) as unknown as { id: string; display_name: string };
      expect(row.id).toBe("cap-1");
      expect(row.display_name).toBe("cap one");
    } finally {
      second.close();
    }
  });
});

describe("openKnowledgeStore — corrupted-DB quarantine", () => {
  it("moves a non-SQLite file aside to .corrupt.<iso>, writes diagnostics, and re-initialises", () => {
    const dbPath = join(tmp, "capsules.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");

    const store = openKnowledgeStore({ dbPath });
    try {
      // Fresh DB initialised: capsules table present, 0 rows.
      const row = store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM capsules")
        .get() as unknown as CountRow;
      expect(row.n).toBe(0);
    } finally {
      store.close();
    }

    const entries = readdirSync(tmp);
    const quarantined = entries.find((name) =>
      /capsules\.db\.corrupt\.\d{4}-\d{2}-\d{2}T/.test(name),
    );
    expect(quarantined).toBeDefined();
    const diagnostic = entries.find(
      (name) =>
        /capsules\.db\.corrupt\.\d{4}-\d{2}-\d{2}T/.test(name) && name.endsWith(".diagnostic.json"),
    );
    expect(diagnostic).toBeDefined();
    const record = JSON.parse(readFileSync(join(tmp, diagnostic ?? ""), "utf8")) as {
      readonly store?: string;
      readonly cause?: { readonly errcode?: number };
    };
    expect(record.store).toBe("local-knowledge");
    expect(record.cause?.errcode).toBe(26);
  });

  it("refuses but does not quarantine a structurally-valid SQLite file that is missing the capsules table", () => {
    const dbPath = join(tmp, "capsules.db");
    // Hand-roll a DB that opens cleanly but lacks the expected schema. The opener must
    // detect partial state and refuse, NOT silently coexist with or quarantine foreign tables.
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY)");
      seed.exec("PRAGMA user_version = 99");
    } finally {
      seed.close();
    }

    let caught: unknown;
    try {
      openKnowledgeStore({ dbPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeStoreError);
    expect((caught as Error).cause).toBeInstanceOf(KnowledgeStoreError);
    expect(((caught as Error).cause as Error).message).toMatch(/unexpected schema/);
    expect(readdirSync(tmp).some((n) => n.includes(".corrupt."))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("does not quarantine a newer schema downgrade guard", () => {
    const dbPath = join(tmp, "capsules.db");
    const first = openKnowledgeStore({ dbPath });
    first.close();
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`PRAGMA user_version = ${String(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION + 1)}`);
    } finally {
      seed.close();
    }

    let caught: unknown;
    try {
      openKnowledgeStore({ dbPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeStoreError);
    expect((caught as Error).cause).toBeInstanceOf(KnowledgeStoreError);
    expect(((caught as Error).cause as Error).message).toMatch(/newer than this binary/);
    expect(readdirSync(tmp).some((n) => n.includes(".corrupt."))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("does not quarantine SQLITE_BUSY lock contention", () => {
    const dbPath = join(tmp, "capsules.db");
    const first = openKnowledgeStore({ dbPath });
    first.close();

    const locker = new DatabaseSync(dbPath);
    locker.exec("PRAGMA locking_mode = EXCLUSIVE");
    locker.exec("BEGIN EXCLUSIVE");
    try {
      let caught: unknown;
      try {
        openKnowledgeStore({ dbPath });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KnowledgeStoreError);
      expect(String((caught as Error).cause)).toMatch(/locked|busy/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect(readdirSync(tmp).some((n) => n.includes(".corrupt."))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("openKnowledgeStore — migration runner", () => {
  it("applies pending migrations when user_version is 0", () => {
    const dbPath = join(tmp, "capsules.db");
    // Seed: empty DB at user_version 0 (would be the "I created the file but bailed before
    // applying migrations" state). The opener should treat it as fresh and apply DDL.
    const seed = new DatabaseSync(dbPath);
    try {
      // Leave sqlite_master EMPTY so the opener sees an uninitialised but valid SQLite file.
      seed.exec("PRAGMA user_version = 0");
    } finally {
      seed.close();
    }

    const store = openKnowledgeStore({ dbPath });
    try {
      const version = store._internal.db
        .prepare("PRAGMA user_version")
        .get() as unknown as VersionRow;
      expect(version.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);
      const row = store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM capsules")
        .get() as unknown as CountRow;
      expect(row.n).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("openKnowledgeStore — upgrade path from v1", () => {
  it("migrates a v1-only database to v2 without quarantining it", () => {
    // Regression for Copilot finding: KNOWLEDGE_CAPSULE_TABLES includes the v2
    // capsule_membership_changes table, so a v1 database would fail expectedTablesPresent
    // before migrations ran and be quarantined. The fix: use KNOWLEDGE_CAPSULE_V1_TABLES for
    // the pre-migration check so v1 databases pass the guard and get migrated normally.
    const dbPath = join(tmp, "capsules.db");
    const v1 = KNOWLEDGE_CAPSULE_MIGRATIONS.find((m) => m.version === 1);
    if (v1 === undefined) throw new Error("v1 migration not found");

    // Manually create a v1-state database (schema applied, user_version = 1, no v2 table).
    const seed = new DatabaseSync(dbPath);
    try {
      for (const stmt of v1.up) {
        seed.exec(stmt);
      }
      seed.exec("PRAGMA user_version = 1");
    } finally {
      seed.close();
    }

    // Open through the store — it must NOT quarantine the file.
    const store = openKnowledgeStore({ dbPath });
    try {
      // Verify migration to v2 applied: capsule_membership_changes now exists.
      const row = store._internal.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='capsule_membership_changes'",
        )
        .get() as unknown as CountRow;
      expect(row.n).toBe(1);
      // Verify we reached the final schema version.
      const ver = store._internal.db.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      expect(ver.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);
    } finally {
      store.close();
    }

    // The original file must still be there (not quarantined).
    const entries = readdirSync(tmp);
    const quarantined = entries.find((name) => name.includes(".corrupt."));
    expect(quarantined).toBeUndefined();
  });
});

// KEIKO-0371: capsule_sources carries `FOREIGN KEY (id) REFERENCES knowledge_sources(id) ON
// DELETE RESTRICT` on a fresh install, but no migration ever added it to a store created at v1.
// The obvious fix (the create/copy/DROP/rename rebuild used elsewhere in the schema) was tried and
// reverted: capsule_sources is the FK TARGET of eight dependent tables under `ON DELETE CASCADE`,
// this store opens with `PRAGMA foreign_keys = ON`, runMigrations wraps pending migrations in one
// BEGIN/COMMIT, and `PRAGMA foreign_keys = OFF` is a documented no-op once that transaction is
// open — so the DROP would have cascaded and silently deleted every upgraded store's documents,
// chunks, and vectors. This suite proves the fix through the REAL runMigrations engine (not a
// simplified statement-loop fixture — see AGENTS.md #2285 on fixtures restating the producer),
// against a store populated exactly like a real installed capsule would be.
const SEED_CAPSULE_SQL =
  "INSERT INTO capsules (id, display_name, tags_json, retrieval_effort, output_mode, " +
  "answer_grounding_policy, embedding_model_provider, embedding_model_id, vector_dimensions, " +
  "vector_metric, lifecycle_state, storage_reference, created_at, updated_at) VALUES " +
  "('cap-1', 'Demo capsule', '[]', 'default', 'answers', 'require-citations', 'openai', " +
  "'text-embedding-3-small', 4, 'cosine', 'ready', 'capsules/cap-1', 1000, 1000)";

const SEED_KNOWLEDGE_SOURCE_SQL =
  "INSERT INTO knowledge_sources (id, display_name, tags_json, scope_kind, scope_json, " +
  "created_at, updated_at) VALUES ('src-1', 'Demo source', '[]', 'folder', '{}', 1000, 1000)";

const SEED_CAPSULE_SOURCE_SQL =
  "INSERT INTO capsule_sources (id, capsule_id, display_name, tags_json, scope_kind, " +
  "scope_json, created_at, updated_at) VALUES ('src-1', 'cap-1', 'Demo source', '[]', " +
  "'folder', '{}', 1000, 1000)";

const SEED_DOCUMENT_SQL =
  "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, " +
  "content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) " +
  "VALUES ('doc-1', 'cap-1', 'src-1', 'docs/intro.md', 10, 'text/markdown', 'deadbeef', " +
  "'markdown', '1.0.0', 1000, 'extracted', 'intro.md')";

const SEED_PARSED_UNIT_SQL =
  "INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES " +
  "('unit-1', 'cap-1', 'doc-1', 'section')";

const SEED_CHUNK_SQL =
  "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, " +
  "token_count, safe_excerpt_hash) VALUES ('chunk-1', 'cap-1', 'src-1', 'doc-1', 'unit-1', 0, " +
  "4, 'abc')";

const SEED_VECTOR_SQL =
  "INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, " +
  "embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, " +
  "storage_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

// Manually builds a v32-state store on disk (every migration through v32 applied — capsule_sources
// still in its v1, FK-less shape) and populates one row in every table that cascades from
// capsule_sources, so the real migration runner is the only thing standing between this fixture and
// a passing test — exactly what an upgraded, populated, real-world store looks like today.
function seedPopulatedV32Store(dbPath: string): void {
  const seed = new DatabaseSync(dbPath);
  try {
    for (const migration of KNOWLEDGE_CAPSULE_MIGRATIONS) {
      if (migration.version > 32) break;
      for (const stmt of migration.up) seed.exec(stmt);
    }
    seed.exec(SEED_CAPSULE_SQL);
    seed.exec(SEED_KNOWLEDGE_SOURCE_SQL);
    seed.exec(SEED_CAPSULE_SOURCE_SQL);
    seed.exec(SEED_DOCUMENT_SQL);
    seed.exec(SEED_PARSED_UNIT_SQL);
    seed.exec(SEED_CHUNK_SQL);
    seed
      .prepare(SEED_VECTOR_SQL)
      .run(
        "vec-1",
        "cap-1",
        "src-1",
        "doc-1",
        "chunk-1",
        new Uint8Array(16),
        "openai",
        "text-embedding-3-small",
        4,
        "cosine",
        "store-ref-1",
        1000,
      );
    seed.exec("PRAGMA user_version = 32");
  } finally {
    seed.close();
  }
}

describe("openKnowledgeStore — capsule_sources foreign key backfill (KEIKO-0371)", () => {
  it("migrates a populated v32 store to v33 with zero dependent rows lost, and the new foreign key enforces ON DELETE RESTRICT", () => {
    const dbPath = join(tmp, "capsules.db");
    seedPopulatedV32Store(dbPath);

    const store = openKnowledgeStore({ dbPath });
    try {
      const db = store._internal.db;
      const version = db.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      expect(version.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);

      const dependentTables = [
        "capsule_sources",
        "knowledge_sources",
        "documents",
        "parsed_units",
        "chunks",
        "vectors",
      ];
      for (const table of dependentTables) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as CountRow;
        expect(row.n, `expected the seeded ${table} row to survive the v33 migration`).toBe(1);
      }

      const fkListRows = db.prepare("PRAGMA foreign_key_list('capsule_sources')").all();
      const fkList = fkListRows as unknown as readonly {
        readonly table: string;
        readonly on_delete: string;
      }[];
      expect(
        fkList.some((fk) => fk.table === "knowledge_sources" && fk.on_delete === "RESTRICT"),
      ).toBe(true);

      // Presence in the FK list is not enforcement; prove the constraint actually fires. src-1 is
      // still referenced by capsule_sources (and, transitively, documents/chunks/vectors), so
      // deleting it must be rejected rather than silently cascading away the whole lineage.
      expect(() => db.prepare("DELETE FROM knowledge_sources WHERE id = ?").run("src-1")).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      const stillPresent = db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_sources")
        .get() as unknown as CountRow;
      expect(stillPresent.n).toBe(1);
    } finally {
      store.close();
    }

    const entries = readdirSync(tmp);
    expect(entries.some((name) => name.includes(".corrupt."))).toBe(false);
  });

  it("aborts the v33 migration instead of committing a capsule_sources row with no matching knowledge_sources row", () => {
    // The v10 backfill's `GROUP BY id` should make a dangling capsule_sources.id impossible, but the
    // migration does not assume that — PRAGMA foreign_key_check inside the suspended-enforcement
    // transaction is the backstop. This seeds exactly the anomaly that check exists to catch: a
    // capsule_sources row whose id has no knowledge_sources counterpart at all.
    const dbPath = join(tmp, "capsules.db");
    const seed = new DatabaseSync(dbPath);
    try {
      for (const migration of KNOWLEDGE_CAPSULE_MIGRATIONS) {
        if (migration.version > 32) break;
        for (const stmt of migration.up) seed.exec(stmt);
      }
      seed.exec(SEED_CAPSULE_SQL);
      // Deliberately no knowledge_sources row for 'src-1' — capsule_sources is populated directly.
      seed.exec(SEED_CAPSULE_SOURCE_SQL);
      seed.exec("PRAGMA user_version = 32");
    } finally {
      seed.close();
    }

    expect(() => openKnowledgeStore({ dbPath })).toThrow(/Failed to open knowledge-capsule store/);

    // A rejected migration must fail closed, not corrupt: the file is not quarantined, and a plain
    // read against it still sees the original v32 state untouched — capsule_sources kept its row and
    // was never dropped, because ROLLBACK undid the whole suspended-enforcement transaction.
    const entries = readdirSync(tmp);
    expect(entries.some((name) => name.includes(".corrupt."))).toBe(false);
    const reopened = new DatabaseSync(dbPath);
    try {
      const version = reopened.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      expect(version.user_version).toBe(32);
      const row = reopened
        .prepare("SELECT COUNT(*) AS n FROM capsule_sources")
        .get() as unknown as CountRow;
      expect(row.n).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("reports every violating table, deduplicated and sorted, when the rebuild finds more than one", () => {
    // assertNoForeignKeyViolations runs PRAGMA foreign_key_check against the WHOLE database, not
    // just capsule_sources — a genuine safety net, not a narrow check. Plants a second, unrelated
    // pre-existing violation (foreign_keys off for that one insert only) alongside the
    // capsule_sources/knowledge_sources gap, so the reported table list has two distinct entries and
    // the dedup+sort formatting path actually runs.
    const dbPath = join(tmp, "capsules.db");
    const seed = new DatabaseSync(dbPath);
    try {
      for (const migration of KNOWLEDGE_CAPSULE_MIGRATIONS) {
        if (migration.version > 32) break;
        for (const stmt of migration.up) seed.exec(stmt);
      }
      seed.exec(SEED_CAPSULE_SQL);
      seed.exec(SEED_CAPSULE_SOURCE_SQL);
      seed.exec("PRAGMA foreign_keys = OFF");
      seed.exec(
        "INSERT INTO capsule_set_members (set_id, capsule_id, ordinal, composed_at) " +
          "VALUES ('set-1', 'no-such-capsule', 0, 1000)",
      );
      seed.exec("PRAGMA foreign_keys = ON");
      seed.exec("PRAGMA user_version = 32");
    } finally {
      seed.close();
    }

    let caught: unknown;
    try {
      openKnowledgeStore({ dbPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeStoreError);
    const migrationFailure = (caught as Error).cause;
    expect(migrationFailure).toBeInstanceOf(KnowledgeStoreError);
    const violationDetail = (migrationFailure as Error).cause;
    expect(violationDetail).toBeInstanceOf(KnowledgeStoreError);
    expect((violationDetail as Error).message).toMatch(/\[capsule_set_members, capsule_sources\]/);
  });
});

describe("openKnowledgeStore — migration runner failure (standard, non-suspended group)", () => {
  it("rolls back and rethrows when a normal migration fails mid-group, leaving the store at its prior version", () => {
    // Every migration before v33 runs through applyStandardMigrationGroup's own BEGIN/COMMIT with no
    // foreign-key suspension. Pre-creates capsule_membership_changes (the very table v2 tries to
    // CREATE) so v2's first statement collides and throws — proving the standard group's ROLLBACK
    // path undoes the whole batch instead of leaving a half-applied schema.
    const dbPath = join(tmp, "capsules.db");
    const v1 = KNOWLEDGE_CAPSULE_MIGRATIONS.find((m) => m.version === 1);
    if (v1 === undefined) throw new Error("v1 migration not found");
    const seed = new DatabaseSync(dbPath);
    try {
      for (const stmt of v1.up) seed.exec(stmt);
      seed.exec("CREATE TABLE capsule_membership_changes (id INTEGER)");
      seed.exec("PRAGMA user_version = 1");
    } finally {
      seed.close();
    }

    expect(() => openKnowledgeStore({ dbPath })).toThrow(/Failed to open knowledge-capsule store/);

    const entries = readdirSync(tmp);
    expect(entries.some((name) => name.includes(".corrupt."))).toBe(false);
    const reopened = new DatabaseSync(dbPath);
    try {
      const version = reopened.prepare("PRAGMA user_version").get() as unknown as VersionRow;
      // Still 1: the whole v2..v32 group rolled back, so user_version never advanced past v1.
      expect(version.user_version).toBe(1);
      const columns = reopened.prepare("PRAGMA table_info('capsule_membership_changes')").all() as {
        readonly name?: string;
      }[];
      // The pre-created placeholder table (one INTEGER column) is still there, unreplaced by v2's
      // real shape — proof the rest of v2's statements never committed either.
      expect(columns.map((column) => column.name)).toEqual(["id"]);
    } finally {
      reopened.close();
    }
  });
});

describe("openKnowledgeStore — sequential transactions", () => {
  it("two prepared transactions in sequence both succeed under WAL", () => {
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db") });
    try {
      const insert = store._internal.db.prepare(
        "INSERT INTO capsules (id, display_name, tags_json, retrieval_effort, output_mode, " +
          "answer_grounding_policy, embedding_model_provider, embedding_model_id, " +
          "vector_dimensions, vector_metric, lifecycle_state, storage_reference, " +
          "created_at, updated_at) VALUES (:id, :dn, '[]', 'default', 'answers', " +
          "'require-citations', 'openai', 'text-embedding-3-small', 1536, 'cosine', " +
          "'draft', :sref, :now, :now)",
      );
      const tx = (id: string, sref: string): void => {
        store._internal.db.exec("BEGIN");
        try {
          insert.run({ id, dn: id, sref, now: 1 });
          store._internal.db.exec("COMMIT");
        } catch (e) {
          store._internal.db.exec("ROLLBACK");
          throw e;
        }
      };
      tx("a", "sa");
      tx("b", "sb");
      const count = store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM capsules")
        .get() as unknown as CountRow;
      expect(count.n).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("openKnowledgeStore — sidecar quarantine", () => {
  it("moves -wal and -shm sidecars alongside the main file", () => {
    const dbPath = join(tmp, "capsules.db");
    writeFileSync(dbPath, "corrupt");
    writeFileSync(`${dbPath}-wal`, "");
    writeFileSync(`${dbPath}-shm`, "");
    const store = openKnowledgeStore({ dbPath });
    store.close();
    const names = readdirSync(tmp);
    const corruptMain = names.some((n) => n.startsWith("capsules.db.corrupt."));
    const corruptWal = names.some((n) => n.startsWith("capsules.db-wal.corrupt."));
    const corruptShm = names.some((n) => n.startsWith("capsules.db-shm.corrupt."));
    expect(corruptMain).toBe(true);
    expect(corruptWal).toBe(true);
    expect(corruptShm).toBe(true);
  });
});

// ─── Activity log ────────────────────────────────────────────────────────────
// Store recovery is otherwise invisible: a corrupt database is renamed aside and an EMPTY one
// takes its place, and until these lines existed the only trace was a diagnostic sidecar
// nobody looks for until the missing capsules are already noticed.
describe("openKnowledgeStore — activity log", () => {
  function recordingSink(): { sink: KnowledgeLogSink; events: KnowledgeLogEvent[] } {
    const events: KnowledgeLogEvent[] = [];
    return {
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
      events,
    };
  }

  it("records a data-losing quarantine at error level, with the reopen outcome", () => {
    const dbPath = join(tmp, "capsules.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");
    const { sink, events } = recordingSink();

    const store = openKnowledgeStore({ dbPath, logSink: sink });
    store.close();

    const quarantine = events.find((event) => event.op === "knowledge.store.quarantined");
    expect(quarantine).toBeDefined();
    expect(quarantine?.level).toBe("error");
    expect(quarantine?.category).toBe("diagnostic");
    expect(quarantine?.extra).toEqual({ reopened: true });
    expect(typeof quarantine?.errorKind).toBe("string");
  });

  it("writes nothing when the store opens cleanly", () => {
    const { sink, events } = recordingSink();
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db"), logSink: sink });
    store.close();
    expect(events).toEqual([]);
  });

  it("never places the database path in a logged field", () => {
    const dbPath = join(tmp, "capsules.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");
    const { sink, events } = recordingSink();

    const store = openKnowledgeStore({ dbPath, logSink: sink });
    store.close();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(dbPath);
    expect(serialized).not.toContain(tmp);
    expect(serialized).not.toContain("capsules.db");
  });

  it("records the fail-closed rejection when the content cipher cannot be resolved", () => {
    const dbPath = join(tmp, "capsules.db");
    const { sink, events } = recordingSink();

    expect(() =>
      openKnowledgeStore({
        dbPath,
        logSink: sink,
        protection: { mode: "encrypted-key-provider" },
      }),
    ).toThrow(KnowledgeStoreError);

    const rejection = events.find((event) => event.op === "knowledge.store.encryption-rejected");
    expect(rejection).toBeDefined();
    expect(rejection?.level).toBe("error");
    expect(rejection?.extra).toEqual({ protectionMode: "encrypted-key-provider" });
  });

  function testKeyProvider(fill: number): KnowledgeStoreKeyProvider {
    return {
      providerId: `test-${String(fill)}`,
      resolveKey: () => new Uint8Array(32).fill(fill),
    };
  }

  it("records store.encryption-migrated on a fresh forward migration to encrypted storage", () => {
    const dbPath = join(tmp, "capsules.db");
    const { sink, events } = recordingSink();

    const store = openKnowledgeStore({
      dbPath,
      logSink: sink,
      protection: { mode: "encrypted-key-provider", keyProvider: testKeyProvider(7) },
    });
    store.close();

    const migrated = events.find((event) => event.op === "store.encryption-migrated");
    expect(migrated).toBeDefined();
    expect(migrated?.category).toBe("diagnostic");
    expect(migrated?.durationMs).toBeGreaterThanOrEqual(0);
    expect(migrated?.extra).toEqual({
      fromScope: "plaintext",
      toScope: STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeValue,
    });
  });

  it("records store.encryption-migrated with the prior scope on a scope upgrade", () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({
      dbPath,
      protection: { mode: "encrypted-key-provider", keyProvider: testKeyProvider(9) },
    });
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
        .run("reconstructive-columns/v2", STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey);
    } finally {
      raw.close();
    }

    const { sink, events } = recordingSink();
    const upgraded = openKnowledgeStore({
      dbPath,
      logSink: sink,
      protection: { mode: "encrypted-key-provider", keyProvider: testKeyProvider(9) },
    });
    upgraded.close();

    const migrated = events.find((event) => event.op === "store.encryption-migrated");
    expect(migrated).toBeDefined();
    expect(migrated?.extra).toEqual({
      fromScope: "reconstructive-columns/v2",
      toScope: STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeValue,
    });
  });

  it("never writes store.encryption-migrated when nothing needed migrating", () => {
    const dbPath = join(tmp, "capsules.db");
    const provider = testKeyProvider(11);
    openKnowledgeStore({
      dbPath,
      protection: { mode: "encrypted-key-provider", keyProvider: provider },
    }).close();

    const { sink, events } = recordingSink();
    openKnowledgeStore({
      dbPath,
      logSink: sink,
      protection: { mode: "encrypted-key-provider", keyProvider: provider },
    }).close();

    expect(events.find((event) => event.op === "store.encryption-migrated")).toBeUndefined();
  });
});

describe("computeStoreFingerprint", () => {
  it("reports schema version, applied migrations, table row counts, and quick_check on a fresh plaintext store", () => {
    const store = openKnowledgeStore({ dbPath: join(tmp, "capsules.db") });
    try {
      const fingerprint = computeStoreFingerprint(store._internal.db);
      expect(fingerprint.store).toBe("local-knowledge");
      expect(fingerprint.schemaVersion).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);
      expect(fingerprint.migrationsApplied).toEqual(
        KNOWLEDGE_CAPSULE_MIGRATIONS.map((migration) => `v${String(migration.version)}`),
      );
      expect(Object.keys(fingerprint.tableRowCounts).sort()).toEqual(
        [...KNOWLEDGE_CAPSULE_TABLES].sort(),
      );
      expect(Object.values(fingerprint.tableRowCounts).every((count) => count === 0)).toBe(true);
      expect(fingerprint.quickCheckOk).toBe(true);
      expect(fingerprint.encryptionMode).toBe("plaintext");
      expect(fingerprint.keySource).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("counts existing rows and reports encryptionMode: encrypted for an encrypted store", () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({
      dbPath,
      protection: {
        mode: "encrypted-key-provider",
        keyProvider: { providerId: "fp-test", resolveKey: () => new Uint8Array(32).fill(3) },
      },
    });
    try {
      store._internal.db
        .prepare(
          `INSERT INTO capsules (id, display_name, tags_json, retrieval_effort, output_mode,
             answer_grounding_policy, lifecycle_state, storage_reference,
             embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric,
             created_at, updated_at)
           VALUES ('cap-fp', 'Fingerprint capsule', '[]', 'default', 'answers',
             'require-citations-or-state-no-evidence', 'draft', 'capsules/cap-fp',
             'test', 'model', 8, 'cosine', 1, 1)`,
        )
        .run();
      const fingerprint = computeStoreFingerprint(store._internal.db);
      expect(fingerprint.tableRowCounts.capsules).toBe(1);
      expect(fingerprint.encryptionMode).toBe("encrypted");
      expect(fingerprint.quickCheckOk).toBe(true);
    } finally {
      store.close();
    }
  });

  it("degrades a failing quick_check read to quickCheckOk: false rather than throwing", () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath });
    // A quick_check failure must degrade, never propagate — a bundle export must not crash
    // because the very store it is reporting on is unhealthy. Overriding `prepare` for just the
    // one statement (rather than corrupting the on-disk file, which `openKnowledgeStore` already
    // quarantines at open time) isolates the ONE read this function's `quickCheckOkFor` helper
    // must swallow, without disturbing every other prepared statement `computeStoreFingerprint`
    // also issues.
    const originalPrepare = store._internal.db.prepare.bind(store._internal.db);
    store._internal.db.prepare = (sql: string): ReturnType<typeof originalPrepare> => {
      if (sql === "PRAGMA quick_check") throw new Error("simulated quick_check read failure");
      return originalPrepare(sql);
    };
    try {
      const fingerprint = computeStoreFingerprint(store._internal.db);
      expect(fingerprint.quickCheckOk).toBe(false);
    } finally {
      store._internal.db.prepare = originalPrepare;
      store.close();
    }
  });
});
