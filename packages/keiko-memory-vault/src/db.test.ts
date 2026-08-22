import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  chmodIfPresent,
  computeStoreFingerprint,
  openMemoryDatabase,
  openMemoryDatabaseReadOnly,
  quarantineCorruptDb,
} from "./db.js";
import { MEMORY_VAULT_SCHEMA_VERSION } from "./schema.js";
import { insertMemoryRow } from "./memories.js";
import { makeRecord, memId, TEST_CIPHER } from "./_support.js";
import type { MemoryVaultLogEvent, MemoryVaultLogSink } from "./vault-log.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function freshDir(): string {
  // Realpath the tmpdir to avoid tripping the walk-every-ancestor symlink guard on macOS,
  // where /var (and /tmp) are legitimate system-level symlinks. On Linux this is a no-op.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mem-db-"));
  cleanups.push(dir);
  return dir;
}

describe("openMemoryDatabase", () => {
  it("brings a fresh DB up with WAL mode + FK on + contention-friendly pragmas", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    const busy = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
      timeout: number;
    }[];
    expect(busy[0]?.timeout).toBe(5000);
    const synchronous = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    expect(synchronous.synchronous).toBe(1);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("hardens the dir to 0o700 and the DB file to 0o600 on POSIX", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    db.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("close() releases the file lock so the next open succeeds", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const first = openMemoryDatabase(dbPath, TEST_CIPHER);
    first.close();
    const second = openMemoryDatabase(dbPath, TEST_CIPHER);
    expect(() => second.prepare("SELECT 1").get()).not.toThrow();
    second.close();
  });
});

describe("quarantineCorruptDb", () => {
  it("rotates the main DB plus -wal and -shm sidecars", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage");
    writeFileSync(`${dbPath}-wal`, "wal-garbage");
    writeFileSync(`${dbPath}-shm`, "shm-garbage");
    quarantineCorruptDb(dbPath);
    const entries = readdirSync(dir);
    expect(entries.some((e) => e.startsWith("keiko-memory.db.corrupt."))).toBe(true);
    expect(entries.some((e) => e.startsWith("keiko-memory.db-wal.corrupt."))).toBe(true);
    expect(entries.some((e) => e.startsWith("keiko-memory.db-shm.corrupt."))).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("is safe when sidecars do not exist", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage");
    expect(() => {
      quarantineCorruptDb(dbPath);
    }).not.toThrow();
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("openMemoryDatabase corruption path", () => {
  it("quarantines a garbage DB on open, writes a diagnostic record, and re-creates fresh", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    // Vault is up: schema applied to the head + new file exists with the correct user_version.
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
    const entries = readdirSync(dir);
    const corrupt = entries.find((e) => e.startsWith("keiko-memory.db.corrupt."));
    expect(corrupt).toBeDefined();
    const diagnostic = entries.find(
      (e) => e.startsWith("keiko-memory.db.corrupt.") && e.endsWith(".diagnostic.json"),
    );
    expect(diagnostic).toBeDefined();
    const record = JSON.parse(readFileSync(join(dir, diagnostic ?? ""), "utf8")) as {
      readonly store?: string;
      readonly cause?: { readonly errcode?: number };
    };
    expect(record.store).toBe("memory-vault");
    expect(record.cause?.errcode).toBe(26);
  });

  it("does not quarantine a newer schema downgrade guard and leaves existing rows intact", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    db.exec("INSERT INTO memory_vault_secrets (name, value) VALUES ('sentinel', 'kv1.sentinel')");
    db.exec(`PRAGMA user_version = ${String(MEMORY_VAULT_SCHEMA_VERSION + 1)}`);
    db.close();

    expect(() => openMemoryDatabase(dbPath, TEST_CIPHER)).toThrow(/newer than this binary/);
    const entries = readdirSync(dir);
    expect(entries.some((e) => e.includes(".corrupt."))).toBe(false);

    const raw = new DatabaseSync(dbPath);
    try {
      const count = raw
        .prepare("SELECT COUNT(*) AS n FROM memory_vault_secrets WHERE name = 'sentinel'")
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("does not quarantine SQLITE_BUSY lock contention", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    db.close();

    const locker = new DatabaseSync(dbPath);
    locker.exec("PRAGMA locking_mode = EXCLUSIVE");
    locker.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => openMemoryDatabase(dbPath, TEST_CIPHER)).toThrow(/locked|busy/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect(readdirSync(dir).some((e) => e.includes(".corrupt."))).toBe(false);
  });

  // RED (before fix): openMemoryDatabase had no third parameter at all, so a quarantine — a
  // data-losing recovery decision — was completely unobservable from the activity log.
  it("emits exactly one memory-vault.store.quarantined event with reopened:true", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header");
    const events: MemoryVaultLogEvent[] = [];
    const sink: MemoryVaultLogSink = {
      write: (event): void => {
        events.push(event);
      },
    };

    const db = openMemoryDatabase(dbPath, TEST_CIPHER, sink);
    db.close();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "memory-vault.store.quarantined",
      extra: { reopened: true },
    });
    expect(typeof events[0]?.errorKind).toBe("string");
  });

  it("never lets a throwing sink surface as an open failure", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header");
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw new Error("sink is down");
      },
    };

    let db: DatabaseSync | undefined;
    expect(() => {
      db = openMemoryDatabase(dbPath, TEST_CIPHER, dead);
    }).not.toThrow();
    db?.close();
  });
});

// RED (before fix): `runMigrations` never forwarded a sink into `encryptExistingContent`, so this
// event could never fire through the real `openMemoryDatabase` path — only through a direct,
// bypassing call to `encryptExistingContent` itself (see migrate-encrypt.test.ts). This test goes
// through the real production entry point end to end, per AGENTS.md's fixture rule: a fixture that
// never reaches the production entry point cannot detect a wiring gap between two functions that
// both individually work.
describe("openMemoryDatabase — store.encryption-migrated wiring", () => {
  // Mirrors `encryption-at-rest.test.ts`'s `downgradeToLegacyPlaintext`, at the level this suite
  // already operates on (a raw `DatabaseSync`, not the public vault API): bring the DB to schema
  // head first, insert a row, downgrade its content back to plaintext, then roll the v3+ DDL back
  // to its v1 shape (a genuine v1 DB predates it) so the reopen's pending-DDL replay does not
  // collide with tables/columns that already exist.
  function seedLegacyPlaintextDb(dbPath: string): void {
    openMemoryDatabase(dbPath, TEST_CIPHER).close();
    const db = new DatabaseSync(dbPath);
    insertMemoryRow(db, makeRecord({ id: memId("m1") }), TEST_CIPHER);
    db.prepare("UPDATE memories SET body = ? WHERE id = ?").run("plaintext body", "m1");
    db.exec("DROP TABLE memory_access");
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
    db.exec("PRAGMA user_version = 1");
    db.close();
  }

  it("emits store.encryption-migrated when opening a legacy plaintext DB", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    seedLegacyPlaintextDb(dbPath);
    const events: MemoryVaultLogEvent[] = [];
    const sink: MemoryVaultLogSink = {
      write: (event): void => {
        events.push(event);
      },
    };

    const db = openMemoryDatabase(dbPath, TEST_CIPHER, sink);
    db.close();

    const migrated = events.filter((event) => event.op === "store.encryption-migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ category: "diagnostic" });
    const extra = migrated[0]?.extra as { rowsMigrated?: unknown } | undefined;
    expect(typeof extra?.rowsMigrated).toBe("number");
    expect(extra?.rowsMigrated as number).toBeGreaterThanOrEqual(1);
  });

  it("does not emit store.encryption-migrated for a fresh DB with nothing to migrate", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const events: MemoryVaultLogEvent[] = [];
    const sink: MemoryVaultLogSink = {
      write: (event): void => {
        events.push(event);
      },
    };

    openMemoryDatabase(dbPath, TEST_CIPHER, sink).close();

    expect(events.some((event) => event.op === "store.encryption-migrated")).toBe(false);
  });
});

describe("computeStoreFingerprint", () => {
  it("reports schemaVersion, table row counts, quickCheckOk, encryptionMode and keySource for a healthy vault", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    db.prepare(
      "INSERT INTO memory_vault_secrets (name, value) VALUES ('probe', 'kv1.probe-value')",
    ).run();

    const fingerprint = computeStoreFingerprint(db, "keychain");

    expect(fingerprint.store).toBe("memory-vault");
    expect(fingerprint.schemaVersion).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    expect(fingerprint.migrationsApplied).toContain("v1");
    expect(fingerprint.migrationsApplied).toContain(`v${String(MEMORY_VAULT_SCHEMA_VERSION)}`);
    expect(fingerprint.tableRowCounts.memory_vault_secrets).toBe(1);
    expect(fingerprint.tableRowCounts.memories).toBe(0);
    expect(fingerprint.quickCheckOk).toBe(true);
    expect(fingerprint.encryptionMode).toBe("encrypted");
    expect(fingerprint.keySource).toBe("keychain");
    db.close();
  });

  it("omits keySource when the caller supplies none (an injected cipher/vaultKey test seam)", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);

    const fingerprint = computeStoreFingerprint(db, undefined);

    expect(fingerprint.keySource).toBeUndefined();
    db.close();
  });

  it("never throws on a corrupt/garbage file and reports quickCheckOk:false", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header, definitely not a real db file");
    const raw = new DatabaseSync(dbPath);

    let fingerprint: ReturnType<typeof computeStoreFingerprint> | undefined;
    expect(() => {
      fingerprint = computeStoreFingerprint(raw, undefined);
    }).not.toThrow();

    expect(fingerprint?.store).toBe("memory-vault");
    expect(fingerprint?.quickCheckOk).toBe(false);
    // Every fixed table read fails against a garbage file (not a database at all), so each
    // reports the safe default of 0 rather than throwing or being omitted.
    expect(Object.values(fingerprint?.tableRowCounts ?? {})).toEqual([0, 0, 0, 0, 0, 0]);
    raw.close();
  });

  it("is read-only: computing a fingerprint does not change table row counts", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    db.prepare("INSERT INTO memory_vault_secrets (name, value) VALUES ('a', 'kv1.a')").run();

    computeStoreFingerprint(db, undefined);
    computeStoreFingerprint(db, undefined);

    const row = db.prepare("SELECT COUNT(*) AS n FROM memory_vault_secrets").get() as {
      readonly n: number;
    };
    expect(row.n).toBe(1);
    db.close();
  });
});

describe("openMemoryDatabaseReadOnly (Finding 2 — busy_timeout on the read-only diagnostic open)", () => {
  // RED (before fix): `node:sqlite`'s default busy_timeout is 0, so a reader started against a
  // live production server can receive an immediate SQLITE_BUSY from a concurrent WAL checkpoint
  // and spuriously report the vault `open-failed`, exactly the moment `keiko support export`
  // needs the fingerprint to work.
  it("sets the active PRAGMA busy_timeout, matching the production open path", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    openMemoryDatabase(dbPath, TEST_CIPHER).close();

    const db = openMemoryDatabaseReadOnly(dbPath);
    try {
      const rows = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });
});

describe("chmodIfPresent", () => {
  it("is a no-op for non-existent paths", () => {
    const dir = freshDir();
    expect(() => {
      chmodIfPresent(join(dir, "no-such-file"), 0o600);
    }).not.toThrow();
  });

  it("applies the mode when the file exists (POSIX)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dir = freshDir();
    const path = join(dir, "marker");
    writeFileSync(path, "x");
    chmodIfPresent(path, 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("DatabaseSync sanity", () => {
  it("opens an :memory: db without throwing (smoke for node:sqlite availability)", () => {
    const db = new DatabaseSync(":memory:");
    expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  });
});

// Regression pin (audit KEIKO-0212): the CLI's `keiko memory maintain|stats|diagnostics|reembed`
// commands open a second live DatabaseSync handle against the same on-disk file the running BFF
// already holds open — a documented, intentionally-supported concurrent-process pattern. The only
// pre-existing two-handle test (openMemoryDatabase corruption path > does not quarantine
// SQLITE_BUSY lock contention) deliberately forces PRAGMA locking_mode = EXCLUSIVE and asserts the
// SECOND open throws immediately, proving the open path does not wait-and-succeed under an
// EXCLUSIVE lock. This block covers the opposite — the ordinary (non-EXCLUSIVE) WAL case — where a
// second-handle write must WAIT on the RESERVED lock (busy_timeout=5000 by db.ts) and then succeed
// once the first handle commits, instead of surfacing SQLITE_BUSY. node:sqlite is synchronous, so
// this test uses a worker thread to hold the second handle and issue the contending write in
// parallel with the main thread's transaction; the coordination sequence is via structured
// messages so no wall-clock threshold is asserted (fail-mode is "worker throws" or "worker never
// completes", not "worker took longer than N ms").
describe("ordinary WAL concurrency (two live connections)", () => {
  const workerScript = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const b = new DatabaseSync(workerData.dbPath);
    // Same busy_timeout the production preparedDatabase() applies to the CLI's handle. Making it
    // the SAME as the main-thread handle ensures the wait/throw decision comes from SQLite's
    // ordinary WAL contention semantics, not from a tighter test-only timeout.
    b.exec("PRAGMA busy_timeout = 5000");
    parentPort.postMessage({ event: "opened" });
    parentPort.once("message", (msg) => {
      if (msg && msg.event === "attempt-write") {
        // "attempt-started" is posted from a setImmediate callback so the sync .run() call
        // happens on the SAME tick — the message flushes to the channel first, then the
        // insert blocks. Main can therefore observe two distinct signals: the worker has
        // started (attempt-started arrived) AND is still blocked (its done/error message
        // has not arrived yet). No time-based coordination is needed.
        parentPort.postMessage({ event: "attempt-started" });
        try {
          b.prepare("INSERT INTO memory_vault_secrets (name, value) VALUES (?, ?)").run(
            workerData.rowName,
            "kv1.worker",
          );
          parentPort.postMessage({ event: "done" });
        } catch (err) {
          parentPort.postMessage({ event: "error", message: err && err.message });
        } finally {
          b.close();
        }
      }
    });
  `;

  it("a concurrent writer waits then succeeds, instead of surfacing SQLITE_BUSY", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const a = openMemoryDatabase(dbPath, TEST_CIPHER);
    try {
      a.exec("BEGIN IMMEDIATE");
      a.prepare("INSERT INTO memory_vault_secrets (name, value) VALUES (?, ?)").run(
        "m1-sentinel",
        "kv1.main",
      );

      const worker = new Worker(workerScript, {
        eval: true,
        workerData: { dbPath, rowName: "m2-sentinel" },
      });

      try {
        await new Promise<void>((resolve, reject) => {
          worker.once("message", (msg: { event: string }) => {
            if (msg.event === "opened") resolve();
            else reject(new Error(`unexpected first message: ${msg.event}`));
          });
        });

        // Observable coordination replaces the sleep the reviewer flagged (PR-review follow-up
        // on KEIKO-0212): wait for the worker's `attempt-started` message — posted immediately
        // before its synchronous `.run()` — then verify the worker is STILL blocked (its
        // done/error message has not yet arrived). Together those two conditions prove the
        // worker is sitting inside SQLite's lock-wait BEFORE we release the lock; without them
        // a sabotaged busy_timeout=0 would race past this check with `event: "error"`.
        let terminal: { event: string; message?: string } | undefined;
        const donePromise = new Promise<{ event: string; message?: string }>((resolve) => {
          worker.on("message", (msg: { event: string; message?: string }) => {
            if (msg.event === "done" || msg.event === "error") {
              terminal = msg;
              resolve(msg);
            }
          });
        });

        worker.postMessage({ event: "attempt-write" });
        await new Promise<void>((resolve, reject) => {
          const settle = setTimeout(() => {
            reject(new Error("worker did not report attempt-started"));
          }, 5_000);
          worker.on("message", (msg: { event: string }) => {
            if (msg.event === "attempt-started") {
              clearTimeout(settle);
              resolve();
            }
          });
        });
        expect(terminal, "worker unexpectedly settled before main COMMIT").toBeUndefined();

        a.exec("COMMIT");

        const result = await donePromise;
        expect(result.event).toBe("done");

        const rows = a
          .prepare(
            "SELECT name FROM memory_vault_secrets WHERE name LIKE 'm%-sentinel' ORDER BY name",
          )
          .all() as unknown as readonly { name: string }[];
        expect(rows.map((r) => r.name)).toEqual(["m1-sentinel", "m2-sentinel"]);
      } finally {
        await worker.terminate();
      }
    } finally {
      a.close();
    }
  });

  it("a concurrent reader on a third handle sees a consistent (non-torn) row set", () => {
    // WAL isolation guarantees a reader sees either the pre-transaction or post-commit snapshot,
    // never a partially-visible intermediate. Prove this by starting a BEGIN IMMEDIATE writer,
    // opening a fresh reader handle, and asserting the reader sees the pre-write row set exactly.
    // After commit, a fresh read observes the post-write set. Both reads happen through a live
    // third handle that never enters the write transaction itself.
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const a = openMemoryDatabase(dbPath, TEST_CIPHER);
    const reader = new DatabaseSync(dbPath);
    try {
      a.prepare("INSERT INTO memory_vault_secrets (name, value) VALUES (?, ?)").run(
        "pre-existing",
        "kv1.pre",
      );

      a.exec("BEGIN IMMEDIATE");
      a.prepare("INSERT INTO memory_vault_secrets (name, value) VALUES (?, ?)").run(
        "mid-transaction",
        "kv1.mid",
      );

      // Reader sees the pre-transaction snapshot — the mid-transaction row is not yet visible.
      const preRows = reader
        .prepare("SELECT name FROM memory_vault_secrets WHERE name IN (?, ?) ORDER BY name")
        .all("pre-existing", "mid-transaction") as unknown as readonly { name: string }[];
      expect(preRows.map((r) => r.name)).toEqual(["pre-existing"]);

      a.exec("COMMIT");

      // Post-commit, a fresh read observes the full committed state.
      const postRows = reader
        .prepare("SELECT name FROM memory_vault_secrets WHERE name IN (?, ?) ORDER BY name")
        .all("pre-existing", "mid-transaction") as unknown as readonly { name: string }[];
      expect(postRows.map((r) => r.name)).toEqual(["mid-transaction", "pre-existing"]);
    } finally {
      reader.close();
      a.close();
    }
  });
});
