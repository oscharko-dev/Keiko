// DB lifecycle: open prepared (WAL + FK on), migrate, quarantine on corruption. Mirrors the
// proven ADR-0013 D3 pattern in keiko-server/store/db.ts so the two SQLite surfaces have the
// same operational shape (audit, rotation, recovery).

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
// Shared fs-hardening owner [GEN-MAINT-COUPLING-005]. Re-exported below so cipher.ts and vault.ts
// keep importing these from "./db.js" unchanged while the single hardening implementation lives in
// keiko-security.
import {
  chmodIfPresent,
  ensureDirHardened,
  FILE_MODE,
} from "@oscharko-dev/keiko-security/fs-hardening";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
// Shared SQLite corruption classifier [GEN-DUP-SEMANTIC-019]. The pure classification vocabulary is
// owned by keiko-security; the fs-bound recovery machinery (quarantine, quick_check, open) stays here.
import {
  SqliteQuickCheckError,
  errorRecord,
  isSqliteCorruptionError,
} from "@oscharko-dev/keiko-security/sqlite-corruption";
import { runMigrations } from "./schema.js";
import type { MemoryContentCipher } from "./cipher.js";
import {
  emitMemoryVaultLogEvent,
  memoryVaultErrorKind,
  type MemoryVaultLogSink,
} from "./vault-log.js";

const MEMORY_VAULT_STORE_QUARANTINED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory-vault.store.quarantined",
  category: "diagnostic",
  owner: "keiko-memory-vault",
  emitter: "db.logStoreQuarantined",
  fields: {
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    reopened: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["memory-vault-corruption", "memory-vault-reopen"],
  proofIds: ["memory-vault.store.quarantined.recovery"],
  releaseImpact: "patch",
});

export { chmodIfPresent, ensureDirHardened };

// Issue #639's busy_timeout bound for the production open path (`preparedDatabase` below): a
// connection waits a short, bounded interval for a concurrent writer's lock instead of failing
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
    atomicPublishRename(sourcePath, stampedPath, { rename: renameSync });
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
  // A recovered quarantine still records the data-loss-triggering read failure. If opening the
  // replacement also failed, promote the envelope to unavailable so failure clusters distinguish
  // a usable fresh vault from one that remained offline. The exact SQLite class stays body-free in
  // failureKind for incident reconstruction.
  const errorKind = reopened ? "read-failed" : "unavailable";
  emitMemoryVaultLogEvent(
    sink,
    activityLogEvent(
      MEMORY_VAULT_STORE_QUARANTINED_OPERATION,
      { level: "error", errorKind },
      { failureKind: memoryVaultErrorKind(cause), reopened },
    ),
  );
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
