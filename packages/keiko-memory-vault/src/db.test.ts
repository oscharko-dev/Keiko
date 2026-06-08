import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodIfPresent, openMemoryDatabase, quarantineCorruptDb } from "./db.js";
import { MEMORY_VAULT_SCHEMA_VERSION } from "./schema.js";
import { TEST_CIPHER } from "./_support.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-mem-db-"));
  cleanups.push(dir);
  return dir;
}

describe("openMemoryDatabase", () => {
  it("brings a fresh DB up with WAL mode + FK on + migrated to the schema head", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
  });

  it("hardens the dir to 0o700 and the DB file to 0o600 on POSIX", () => {
    if (process.platform === "win32") return;
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
  it("quarantines a garbage DB on open and re-creates fresh", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header");
    const db = openMemoryDatabase(dbPath, TEST_CIPHER);
    // Vault is up: schema applied to the head + new file exists with the correct user_version.
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    db.close();
    expect(readdirSync(dir).some((e) => e.startsWith("keiko-memory.db.corrupt."))).toBe(true);
  });
});

describe("chmodIfPresent", () => {
  it("is a no-op for non-existent paths", () => {
    const dir = freshDir();
    expect(() => {
      chmodIfPresent(join(dir, "no-such-file"), 0o600);
    }).not.toThrow();
  });

  it("applies the mode when the file exists (POSIX)", () => {
    if (process.platform === "win32") return;
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
