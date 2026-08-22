// DB lifecycle: open prepared (WAL + FK on), migrate, quarantine on corruption. Mirrors the
// proven ADR-0013 D3 pattern in keiko-server/store/db.ts so the two SQLite surfaces have the
// same operational shape (audit, rotation, recovery).

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Shared fs-hardening owner [GEN-MAINT-COUPLING-005]. Re-exported below so cipher.ts and vault.ts
// keep importing these from "./db.js" unchanged while the single hardening implementation lives in
// keiko-security.
import {
  chmodIfPresent,
  ensureDirHardened,
  FILE_MODE,
} from "@oscharko-dev/keiko-security/fs-hardening";
// Shared SQLite corruption classifier [GEN-DUP-SEMANTIC-019]. The pure classification vocabulary is
// owned by keiko-security; the fs-bound recovery machinery (quarantine, quick_check, open) stays here.
import {
  SqliteQuickCheckError,
  errorRecord,
  isSqliteCorruptionError,
} from "@oscharko-dev/keiko-security/sqlite-corruption";
import type { StoreFingerprint } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "./schema.js";
import type { MemoryContentCipher, VaultKeySource } from "./cipher.js";
import {
  emitMemoryVaultLogEvent,
  memoryVaultErrorKind,
  type MemoryVaultLogSink,
} from "./vault-log.js";

export { chmodIfPresent, ensureDirHardened };

// Issue #639's busy_timeout bound, shared by the production open path (`preparedDatabase` below)
// and the read-only diagnostic open (`openMemoryDatabaseReadOnly`, Finding 2) so both connections
// wait the same short, bounded interval for a concurrent writer's lock instead of failing
// immediately with SQLITE_BUSY.
const MEMORY_VAULT_BUSY_TIMEOUT_MS = 5_000;

export function preparedDatabase(target: string): DatabaseSync {
  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${String(MEMORY_VAULT_BUSY_TIMEOUT_MS)}`);
  return db;
}

function configureWalDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

export interface SidecarSnapshot {
  readonly hadWal: boolean;
  readonly hadShm: boolean;
}

function assertQuickCheckOk(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as readonly Record<string, unknown>[];
  const values = rows
    .map((row) => Object.values(row)[0])
    .filter((value): value is string => typeof value === "string");
  if (values.length === 1 && values[0] === "ok") return;
  throw new SqliteQuickCheckError(values.length > 0 ? values : ["no quick_check rows returned"]);
}

// Rotate a single sidecar path to its .corrupt.<ts> form. If `hadAtSnapshot` is true, the
// caller observed the file before SQLite's close() may have unlinked it; in that case we still
// write a zero-byte marker so the audit trail shows the sidecar existed at the time the parent
// file was found corrupt. Returns silently when there's nothing to rotate.
function rotateSidecar(sourcePath: string, stampedPath: string, hadAtSnapshot: boolean): void {
  if (existsSync(sourcePath)) {
    renameSync(sourcePath, stampedPath);
    return;
  }
  if (hadAtSnapshot && !existsSync(stampedPath)) {
    writeFileSync(stampedPath, "");
  }
}

export function quarantineCorruptDb(
  target: string,
  snapshot?: SidecarSnapshot,
  cause?: unknown,
): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${target}.corrupt.${ts}`;
  const walPath = `${target}-wal.corrupt.${ts}`;
  const shmPath = `${target}-shm.corrupt.${ts}`;
  rotateSidecar(target, quarantinedPath, false);
  rotateSidecar(`${target}-wal`, walPath, snapshot?.hadWal === true);
  rotateSidecar(`${target}-shm`, shmPath, snapshot?.hadShm === true);
  writeFileSync(
    `${quarantinedPath}.diagnostic.json`,
    `${JSON.stringify(
      {
        incidentId: randomUUID(),
        store: "memory-vault",
        timestamp: new Date().toISOString(),
        dbPath: target,
        quarantinedPath,
        walQuarantinePath: snapshot?.hadWal === true ? walPath : undefined,
        shmQuarantinePath: snapshot?.hadShm === true ? shmPath : undefined,
        cause: errorRecord(cause ?? new Error("manual quarantine")),
      },
      null,
      2,
    )}\n`,
    { mode: FILE_MODE },
  );
}

// Quarantine is a DATA-LOSING decision (the old file is rotated aside and a fresh, empty DB takes
// its place), so it is recorded at `error` even when the reopen succeeds — mirroring
// `packages/keiko-local-knowledge/src/store.ts`'s `logStoreQuarantine`. `sink` is optional
// (ADR-0019 — see `vault-log.ts`); `emitMemoryVaultLogEvent` never throws, so a dead sink can
// never turn a successful recovery into a new failure.
function logStoreQuarantined(
  sink: MemoryVaultLogSink | undefined,
  cause: unknown,
  reopened: boolean,
): void {
  emitMemoryVaultLogEvent(sink, {
    level: "error",
    category: "diagnostic",
    op: "memory-vault.store.quarantined",
    errorKind: memoryVaultErrorKind(cause),
    extra: { reopened },
  });
}

export function openMemoryDatabase(
  dbPath: string,
  cipher: MemoryContentCipher,
  sink?: MemoryVaultLogSink,
): DatabaseSync {
  ensureDirHardened(dirname(dbPath));
  let db = preparedDatabase(dbPath);
  try {
    configureWalDatabase(db);
    assertQuickCheckOk(db);
    runMigrations(db, cipher, sink);
  } catch (error) {
    // SQLite's close() on a WAL-enabled handle may checkpoint and unlink -wal/-shm,
    // so we must SNAPSHOT sidecar existence BEFORE close, then close, then rename
    // based on the snapshot. Without the snapshot, a pre-existing corrupt -wal
    // would silently disappear and never land in the .corrupt.<iso> set.
    const hadWal = existsSync(`${dbPath}-wal`);
    const hadShm = existsSync(`${dbPath}-shm`);
    db.close();
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
    quarantineCorruptDb(dbPath, { hadWal, hadShm }, error);
    let reopened = false;
    try {
      db = preparedDatabase(dbPath);
      configureWalDatabase(db);
      assertQuickCheckOk(db);
      runMigrations(db, cipher, sink);
      reopened = true;
    } finally {
      logStoreQuarantined(sink, error, reopened);
    }
  }
  chmodIfPresent(dbPath, FILE_MODE);
  chmodIfPresent(`${dbPath}-wal`, FILE_MODE);
  chmodIfPresent(`${dbPath}-shm`, FILE_MODE);
  return db;
}

// Genuinely read-only open for a diagnostic snapshot (Wave 4a, epic #3233 §6.2/§8). Unlike
// `openMemoryDatabase` above, this never runs `runMigrations` (which can trigger the v1->v2
// encryption sweep, rewriting every content row) or the corruption-quarantine reopen loop — every
// one of those is a write, and a fingerprint export must not migrate, re-encrypt, or quarantine the
// very vault an operator is trying to inspect. `computeStoreFingerprint` below needs only
// `PRAGMA user_version`/`quick_check` and fixed `SELECT COUNT(*)` reads, none of which need write
// access.
export function openMemoryDatabaseReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // A short busy_timeout (Finding 2) so a reader opened with no wait bound does not spuriously
  // report the store `open-failed` on an immediate SQLITE_BUSY from a concurrent WAL checkpoint
  // or schema-changing transaction on a live production server. Connection-local PRAGMA: no write,
  // does not throw on a `readOnly: true` handle, so the read-only guarantee above is unaffected.
  db.exec(`PRAGMA busy_timeout = ${String(MEMORY_VAULT_BUSY_TIMEOUT_MS)}`);
  return db;
}

// ─── computeStoreFingerprint (Wave 4a, epic #3233 §6.2) ────────────────────────────────────────
//
// A read-only, NEVER-THROWING snapshot of this vault's schema/integrity state for `keiko bundle
// export`'s support-bundle manifest (`StoreFingerprint`, `@oscharko-dev/keiko-contracts`). Every
// field is a count, a closed-vocabulary label, or a bounded identifier drawn from this package's
// own fixed table/migration list — never a row, a path, a key, a secret, or free text (ADR-0128
// D6). `keySource` is the already-computed key-resolution tier from `resolveVaultKey` (cipher.ts),
// passed in by the caller rather than recomputed here — recomputing it would mean touching the
// keychain/keyfile tiers a second time purely for a diagnostic read.

// FIXED, closed table list — mirrors schema.ts's CREATE TABLE statements (v1: memories,
// memory_edges, memory_embeddings, memory_tombstones; v3: memory_access; v9: memory_vault_secrets)
// — never a dynamic sqlite_master walk, per `StoreFingerprint`'s own contract. A future migration
// that adds a table updates this list alongside schema.ts: the same accepted, documented-
// duplication tradeoff `ERROR_KIND_PATTERN` used across three packages before ADR-0173
// consolidated it, needed here because schema.ts does not export its private table/migration
// lists and this function must stay read-only over db + PRAGMA state without reaching into them.
const STORE_FINGERPRINT_TABLES: readonly string[] = [
  "memories",
  "memory_edges",
  "memory_embeddings",
  "memory_tombstones",
  "memory_access",
  "memory_vault_secrets",
];

// FIXED, closed migration-version list — mirrors schema.ts's `MIGRATIONS` array's version numbers
// (frozen, append-only history; v2 is the encryption-only bump and has no discrete DDL entry, so
// it is intentionally absent here too, exactly as it is absent from schema.ts's own array).
const STORE_FINGERPRINT_MIGRATION_VERSIONS: readonly number[] = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// The schema version at which this store's content became encrypted-at-rest. Mirrors schema.ts's
// private `ENCRYPTION_VERSION`, frozen at 2 since that migration already shipped and schema.ts's
// migration history is append-only. `openMemoryDatabase` always drives a DB to this version or
// higher before returning, so `"migrating"` is structurally unobservable for this store today —
// the value exists in `StoreFingerprint`'s closed vocabulary for the OTHER store packages that
// share the type, not because this one can produce it.
const ENCRYPTION_SCHEMA_VERSION = 2;

function safeUserVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : 0;
  } catch {
    return 0;
  }
}

function safeQuickCheckOk(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as readonly Record<string, unknown>[];
    const values = rows
      .map((row) => Object.values(row)[0])
      .filter((value): value is string => typeof value === "string");
    return values.length === 1 && values[0] === "ok";
  } catch {
    return false;
  }
}

function safeTableRowCount(db: DatabaseSync, table: string): number {
  try {
    // `table` comes only from the hard-coded STORE_FINGERPRINT_TABLES list above, never from
    // caller data, so the interpolation is not an injection surface (the same rule
    // migrate-encrypt.ts and schema.ts rely on for their own fixed identifier lists).
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      { readonly n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  } catch {
    // Table absent (fresh or pre-migration DB) or unreadable (corruption) — 0 is the safe,
    // honest count for "nothing confirmed present", never a thrown diagnostic-read failure.
    return 0;
  }
}

function safeTableRowCounts(db: DatabaseSync): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of STORE_FINGERPRINT_TABLES) {
    counts[table] = safeTableRowCount(db, table);
  }
  return counts;
}

function migrationsAppliedUpTo(schemaVersion: number): readonly string[] {
  return STORE_FINGERPRINT_MIGRATION_VERSIONS.filter((version) => version <= schemaVersion).map(
    (version) => `v${String(version)}`,
  );
}

// A store whose schema could not be read is reported as `plaintext` with NO `keySource`: the key
// tier that was resolved for it is not evidence about bytes nobody could read, and the contract's
// `isStoreFingerprint` rejects a plaintext fingerprint that still names a key source — a rejected
// fingerprint must never silently vanish from a support bundle (see the exporter's
// `invalid-fingerprint` unavailability reason, the fail-closed backstop for exactly that).
function fallbackStoreFingerprint(): StoreFingerprint {
  return {
    store: "memory-vault",
    schemaVersion: 0,
    migrationsApplied: [],
    tableRowCounts: {},
    quickCheckOk: false,
    encryptionMode: "plaintext",
  };
}

/**
 * A point-in-time, redacted snapshot of this vault's schema/integrity state (Wave 4a, epic #3233
 * §6.2). Read-only and NEVER THROWS — a corrupt or unreadable file yields a safe, all-failed
 * fingerprint (`quickCheckOk: false`) instead of propagating, so a support-bundle export can
 * always attach one entry per store even when a store is unhealthy.
 */
export function computeStoreFingerprint(
  db: DatabaseSync,
  keySource: VaultKeySource | undefined,
): StoreFingerprint {
  try {
    const schemaVersion = safeUserVersion(db);
    const encrypted = schemaVersion >= ENCRYPTION_SCHEMA_VERSION;
    return {
      store: "memory-vault",
      schemaVersion,
      migrationsApplied: migrationsAppliedUpTo(schemaVersion),
      tableRowCounts: safeTableRowCounts(db),
      quickCheckOk: safeQuickCheckOk(db),
      encryptionMode: encrypted ? "encrypted" : "plaintext",
      // `keySource` describes how THIS store's key was resolved; a plaintext store has no key in
      // play, so naming a tier for it would contradict the contract (`isStoreFingerprint`).
      ...(encrypted && keySource !== undefined ? { keySource } : {}),
    };
  } catch {
    return fallbackStoreFingerprint();
  }
}
