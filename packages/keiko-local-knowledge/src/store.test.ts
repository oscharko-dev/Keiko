// store.test.ts — integration coverage for openKnowledgeStore: schema apply, restart
// safety, corrupted-DB quarantine, migration runner, durability pragmas.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openKnowledgeStore } from "./store.js";

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
      const fk = db.prepare("PRAGMA foreign_keys").get() as unknown as { readonly foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
    } finally {
      store.close();
    }
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
  it("moves a non-SQLite file aside to .corrupt.<iso> and re-initialises", () => {
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
  });

  it("detects a structurally-valid SQLite file that is missing the capsules table", () => {
    const dbPath = join(tmp, "capsules.db");
    // Hand-roll a DB that opens cleanly but lacks the expected schema. The opener must
    // detect partial state and quarantine, NOT silently coexist with foreign tables.
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY)");
      seed.exec("PRAGMA user_version = 99");
    } finally {
      seed.close();
    }

    const store = openKnowledgeStore({ dbPath });
    try {
      // Quarantined → fresh DB → capsules table present.
      const ok = store._internal.db.prepare("SELECT COUNT(*) AS n FROM capsules").get() as unknown as CountRow;
      expect(ok.n).toBe(0);
      // Quarantine file present alongside the new db.
      const moved = readdirSync(tmp).find((n) =>
        /capsules\.db\.corrupt\.\d{4}-\d{2}-\d{2}T/.test(n),
      );
      expect(moved).toBeDefined();
    } finally {
      store.close();
    }
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
      const version = store._internal.db.prepare("PRAGMA user_version").get() as unknown as VersionRow;
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

