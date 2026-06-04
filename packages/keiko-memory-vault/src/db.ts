// DB lifecycle: open prepared (WAL + FK on), migrate, quarantine on corruption. Mirrors the
// proven ADR-0013 D3 pattern in keiko-server/store/db.ts so the two SQLite surfaces have the
// same operational shape (audit, rotation, recovery).

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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

export interface SidecarSnapshot {
  readonly hadWal: boolean;
  readonly hadShm: boolean;
}

export function quarantineCorruptDb(target: string, snapshot?: SidecarSnapshot): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(target)) {
    renameSync(target, `${target}.corrupt.${ts}`);
  }
  // If a snapshot was passed, the caller knew the sidecar existed before SQLite's close()
  // had a chance to unlink it. Trust the snapshot over the live FS check.
  if (snapshot?.hadWal === true && !existsSync(`${target}-wal.corrupt.${ts}`)) {
    if (existsSync(`${target}-wal`)) renameSync(`${target}-wal`, `${target}-wal.corrupt.${ts}`);
    else writeMarker(`${target}-wal.corrupt.${ts}`);
  }
  if (snapshot?.hadShm === true && !existsSync(`${target}-shm.corrupt.${ts}`)) {
    if (existsSync(`${target}-shm`)) renameSync(`${target}-shm`, `${target}-shm.corrupt.${ts}`);
    else writeMarker(`${target}-shm.corrupt.${ts}`);
  }
  if (snapshot === undefined) {
    for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
      if (existsSync(sidecar)) {
        renameSync(sidecar, `${sidecar}.corrupt.${ts}`);
      }
    }
  }
}

function writeMarker(path: string): void {
  // The sidecar was unlinked by SQLite before quarantine could rename it; we write a tiny
  // marker so the audit trail still shows the sidecar existed at the time the parent file
  // was found corrupt. The marker contains no payload data — it is a tombstone for the
  // unrecoverable bytes.
  writeFileSync(path, "");
}

export function openMemoryDatabase(dbPath: string): DatabaseSync {
  ensureDirHardened(dirname(dbPath));
  let db = preparedDatabase(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  } catch {
    // SQLite's close() on a WAL-enabled handle may checkpoint and unlink -wal/-shm,
    // so we must SNAPSHOT sidecar existence BEFORE close, then close, then rename
    // based on the snapshot. Without the snapshot, a pre-existing corrupt -wal
    // would silently disappear and never land in the .corrupt.<iso> set.
    const hadWal = existsSync(`${dbPath}-wal`);
    const hadShm = existsSync(`${dbPath}-shm`);
    db.close();
    quarantineCorruptDb(dbPath, { hadWal, hadShm });
    db = preparedDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  }
  chmodIfPresent(dbPath, 0o600);
  chmodIfPresent(`${dbPath}-wal`, 0o600);
  chmodIfPresent(`${dbPath}-shm`, 0o600);
  return db;
}
