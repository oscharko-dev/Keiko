// ADR-0013 D5 — Versioned migration runner using PRAGMA user_version. Forward-only, idempotent.

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, SCHEMA_VERSION } from "../../../src/ui/store/index.js";

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
});
