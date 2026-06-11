// Capsule store runtime. Opens a node:sqlite database, sets durability/correctness pragmas
// (WAL journal + NORMAL synchronous + foreign_keys), applies the #265 DDL via the migration
// runner, and quarantines partial-write / wrong-schema files to `.corrupt.<iso>`.
//
// Foundry-IQ invariants enforced here:
//   * PRAGMA foreign_keys=ON before any insert so capsule_id NOT NULL cascades and the
//     composite (capsule_id, source/document/chunk) FKs cannot be silently bypassed.
//   * Mirroring keiko-server's #62 pattern, a structurally corrupt file is renamed aside
//     (preserving sidecars) rather than reformatted in place — operators recover the file
//     by hand if it was actually data.
//
// Crash-safe write tradeoffs documented inline next to each PRAGMA call.

import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  KNOWLEDGE_CAPSULE_V1_TABLES,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "./errors.js";

export interface OpenKnowledgeStoreOptions {
  readonly dbPath: string;
  readonly clock?: () => number;
  readonly protection?: KnowledgeStoreProtectionOptions;
}

export interface KnowledgeStoreKeyProviderContext {
  readonly dbPath: string;
  readonly schemaVersion: number;
}

export interface KnowledgeStoreKeyProvider {
  readonly providerId: string;
  readonly resolveKey: (context: KnowledgeStoreKeyProviderContext) => Uint8Array;
}

export interface KnowledgeStoreProtectionOptions {
  readonly mode?: "plaintext-local-file-permissions" | "encrypted-key-provider";
  readonly keyProvider?: KnowledgeStoreKeyProvider;
}

// `_internal.db` is exposed so the lifecycle helpers in this package can issue prepared
// statements without re-exporting `node:sqlite` types from the barrel. The underscore
// prefix and the package-internal layout signal that consumers outside this package must
// NOT reach in — they should use the CRUD functions from index.ts.
export interface KnowledgeStore {
  readonly close: () => void;
  readonly _internal: {
    readonly db: DatabaseSync;
    readonly now: () => number;
  };
}

interface VersionRow {
  readonly user_version: number;
}

interface NameRow {
  readonly name: string;
}

function defaultClock(): number {
  return Date.now();
}

function applyDurabilityPragmas(db: DatabaseSync): void {
  // WAL: crash-safe single-writer; readers do not block the writer. Right tradeoff for
  // the indexing+retrieval mix the local-knowledge layer will see.
  db.exec("PRAGMA journal_mode = WAL");
  // synchronous=NORMAL: fsyncs on commit boundaries but skips the fsync between WAL
  // appends. Standard durability/latency choice for embedded apps where the user controls
  // the host process; matches keiko-server's #62 store.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

function rejectUnsupportedProtection(opts: OpenKnowledgeStoreOptions): void {
  if (
    opts.protection?.mode === "encrypted-key-provider" ||
    opts.protection?.keyProvider !== undefined
  ) {
    throw new KnowledgeStoreError(
      "Encrypted local-knowledge stores are not enabled in this build; refusing to open with a key provider.",
    );
  }
}

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as VersionRow | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function setUserVersion(db: DatabaseSync, version: number): void {
  // user_version is not parameterisable. The value here is an integer constant from the
  // contracts package's migration manifest, never caller input.
  db.exec(`PRAGMA user_version = ${String(version)}`);
}

function runMigrations(db: DatabaseSync): void {
  const start = currentUserVersion(db);
  const pending = KNOWLEDGE_CAPSULE_MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      for (const statement of migration.up) {
        db.exec(statement);
      }
      setUserVersion(db, migration.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw new KnowledgeStoreError(
      `Failed to apply knowledge-capsule migration (start=${String(start)})`,
      { cause: error },
    );
  }
}

function listExistingTables(db: DatabaseSync): readonly string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return rows.map((row) => (row as unknown as NameRow).name);
}

function hasAnyUserContent(db: DatabaseSync): boolean {
  // Non-empty sqlite_master OR non-zero user_version → the file is "in use" by something.
  // Either means: don't silently overwrite; quarantine and start fresh.
  const tables = listExistingTables(db);
  const userTables = tables.filter((n) => !n.startsWith("sqlite_"));
  if (userTables.length > 0) return true;
  return currentUserVersion(db) !== 0;
}

function expectedV1TablesPresent(db: DatabaseSync): boolean {
  // Only checks the v1 table set (pre-migration). Used before runMigrations so that a v1
  // database with a valid pre-v2 schema is not quarantined as corrupt.
  const present = new Set(listExistingTables(db));
  for (const expected of KNOWLEDGE_CAPSULE_V1_TABLES) {
    if (!present.has(expected)) return false;
  }
  return true;
}

function expectedTablesPresent(db: DatabaseSync): boolean {
  const present = new Set(listExistingTables(db));
  for (const expected of KNOWLEDGE_CAPSULE_TABLES) {
    if (!present.has(expected)) return false;
  }
  return true;
}

function quarantineFile(target: string): void {
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

function tryOpenAndMigrate(
  dbPath: string,
  onError?: (cause: unknown) => void,
): DatabaseSync | undefined {
  // Returns the opened, migrated handle on success; undefined when the file is unusable
  // (open threw OR the post-migrate schema is missing expected tables OR the file held
  // foreign content that we refuse to coexist with). Callers handle quarantine + retry.
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    // Cannot open at all (file missing permissions, OS error). Caller quarantines and retries.
    return undefined;
  }
  try {
    applyDurabilityPragmas(db);
    if (hasAnyUserContent(db) && !expectedV1TablesPresent(db)) {
      // Pre-existing foreign schema or a partial install missing even the v1 tables.
      // Quarantine and retry. The v1 check is intentionally narrow: a v1 database that
      // has not yet been migrated to v2 passes here, then runMigrations upgrades it.
      db.close();
      return undefined;
    }
    runMigrations(db);
    if (!expectedTablesPresent(db)) {
      db.close();
      return undefined;
    }
    return db;
  } catch (cause) {
    onError?.(cause);
    try {
      db.close();
    } catch {
      // ignore close failure; outer caller will quarantine and retry
    }
    return undefined;
  }
}

function ensureParentDir(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    // 0o700: best-effort on POSIX; ignored on win32.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  restrictPathPermissions(dir, 0o700);
}

function restrictPathPermissions(target: string, mode: number): void {
  if (process.platform === "win32" || !existsSync(target)) return;
  chmodSync(target, mode);
}

function restrictStoreFilePermissions(dbPath: string): void {
  restrictPathPermissions(dbPath, 0o600);
  restrictPathPermissions(`${dbPath}-wal`, 0o600);
  restrictPathPermissions(`${dbPath}-shm`, 0o600);
}

export function openKnowledgeStore(opts: OpenKnowledgeStoreOptions): KnowledgeStore {
  rejectUnsupportedProtection(opts);
  ensureParentDir(opts.dbPath);
  let db = tryOpenAndMigrate(opts.dbPath);
  let lastError: unknown;
  if (db === undefined) {
    quarantineFile(opts.dbPath);
    db = tryOpenAndMigrate(opts.dbPath, (cause) => {
      lastError = cause;
    });
  }
  if (db === undefined) {
    throw new KnowledgeStoreError(
      `Failed to open knowledge-capsule store at ${opts.dbPath} even after quarantine.`,
      lastError !== undefined ? { cause: lastError } : undefined,
    );
  }
  restrictStoreFilePermissions(opts.dbPath);
  const now = opts.clock ?? defaultClock;
  const handle = db;
  return {
    close: (): void => {
      handle.close();
    },
    _internal: { db: handle, now },
  };
}
