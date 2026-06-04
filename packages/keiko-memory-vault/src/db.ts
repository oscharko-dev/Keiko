// DB lifecycle: open prepared (WAL + FK on), migrate, quarantine on corruption. Mirrors the
// proven ADR-0013 D3 pattern in keiko-server/store/db.ts so the two SQLite surfaces have the
// same operational shape (audit, rotation, recovery).

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./schema.js";

export function preparedDatabase(target: string): DatabaseSync {
  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function ensureDirHardened(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort: a parent-owned directory we cannot chmod is preferable to a hard failure
      // that blocks the user from opening the vault.
    }
  }
}

export function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // The sidecar (-wal/-shm) may not exist yet; best-effort.
  }
}

export function quarantineCorruptDb(target: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(target)) {
    renameSync(target, `${target}.corrupt.${ts}`);
  }
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${sidecar}.corrupt.${ts}`);
    }
  }
}

export function openMemoryDatabase(dbPath: string): DatabaseSync {
  ensureDirHardened(dirname(dbPath));
  let db = preparedDatabase(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  } catch {
    db.close();
    quarantineCorruptDb(dbPath);
    db = preparedDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  }
  chmodIfPresent(dbPath, 0o600);
  chmodIfPresent(`${dbPath}-wal`, 0o600);
  chmodIfPresent(`${dbPath}-shm`, 0o600);
  return db;
}
