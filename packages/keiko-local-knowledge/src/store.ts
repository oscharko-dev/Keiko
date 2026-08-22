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

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  KNOWLEDGE_CAPSULE_V1_TABLES,
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
  type KnowledgeCapsuleMigration,
  type StoreFingerprint,
} from "@oscharko-dev/keiko-contracts";
// Shared fs-hardening owner [GEN-MAINT-COUPLING-005]: the single 0o700/0o600 hardening pair.
import {
  chmodIfPresent,
  ensureDirHardened,
  FILE_MODE,
} from "@oscharko-dev/keiko-security/fs-hardening";
// Shared SQLite corruption classifier [GEN-DUP-SEMANTIC-019]: the pure classification vocabulary. The
// KnowledgeStoreError-unwrap hook (see unwrapKnowledgeStoreError) resolves the sealed cause underneath.
import {
  SqliteQuickCheckError,
  errorRecord as sharedErrorRecord,
  isSqliteCorruptionError as sharedIsSqliteCorruptionError,
} from "@oscharko-dev/keiko-security/sqlite-corruption";

import { KnowledgeStoreError } from "./errors.js";
import {
  emitKnowledgeLogEvent,
  knowledgeErrorKind,
  type KnowledgeLogEvent,
  type KnowledgeLogSink,
} from "./knowledge-log.js";
import {
  createEncryptedContentCipher,
  PLAINTEXT_CONTENT_CIPHER,
  type StoreContentCipher,
} from "./store-content-cipher.js";
import {
  applyStoreContentEncryption,
  readStoreEncryptionMode,
} from "./store-content-encryption.js";
import type { VectorIndexOptions } from "./retrieval/vector-index.js";

export interface OpenKnowledgeStoreOptions {
  readonly dbPath: string;
  readonly clock?: () => number;
  readonly protection?: KnowledgeStoreProtectionOptions;
  readonly vectorIndex?: VectorIndexOptions;
  // Optional content-free activity log. Store recovery is otherwise SILENT: a corrupt database
  // is renamed aside and a fresh empty one takes its place, and the only trace is a diagnostic
  // sidecar nobody thinks to look for until after the missing capsules are noticed. Absent →
  // nothing is written. The database path never reaches a field here.
  readonly logSink?: KnowledgeLogSink;
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
    // The store-boundary cipher for reconstructive content columns (ADR-0047). The identity cipher
    // in plaintext mode, an AES-256-GCM cipher when a key provider is supplied. The row layer
    // threads it through every content read/write; no other module touches crypto.
    readonly contentCipher: StoreContentCipher;
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

// Concurrent writers (indexing write + grounded-ask audit INSERT) must wait for the writer
// lock instead of failing immediately with SQLITE_BUSY → HTTP 500. 5_000ms matches the
// keiko-server UI DB constant (packages/keiko-server/src/store/db.ts, issue #639) and is
// the conservative default for the local single-writer desktop pattern.
export const LK_STORE_BUSY_TIMEOUT_MS = 5_000;

function applyDurabilityPragmas(db: DatabaseSync): void {
  // WAL: crash-safe single-writer; readers do not block the writer. Right tradeoff for
  // the indexing+retrieval mix the local-knowledge layer will see.
  db.exec("PRAGMA journal_mode = WAL");
  // synchronous=NORMAL: fsyncs on commit boundaries but skips the fsync between WAL
  // appends. Standard durability/latency choice for embedded apps where the user controls
  // the host process; matches keiko-server's #62 store.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${String(LK_STORE_BUSY_TIMEOUT_MS)}`);
}

// Resolves the store-boundary content cipher from the protection options. Plaintext (identity cipher)
// is the default: a store opened without a key provider behaves exactly as before. Encryption is
// requested by `encrypted-key-provider` mode or by supplying a keyProvider; the provider's 32-byte key
// (resolved for this dbPath + schema version) binds an AES-256-GCM cipher (ADR-0047 D1/D2).
function resolveContentCipher(
  opts: OpenKnowledgeStoreOptions,
  schemaVersion: number,
): StoreContentCipher {
  const protection = opts.protection;
  if (protection === undefined) return PLAINTEXT_CONTENT_CIPHER;
  const encryptionRequested =
    protection.mode === "encrypted-key-provider" || protection.keyProvider !== undefined;
  if (!encryptionRequested) return PLAINTEXT_CONTENT_CIPHER;
  const provider = protection.keyProvider;
  if (provider === undefined) {
    throw new KnowledgeStoreError(
      "encrypted-key-provider protection requires a keyProvider to resolve the store key",
    );
  }
  const key = provider.resolveKey({ dbPath: opts.dbPath, schemaVersion });
  return createEncryptedContentCipher(key);
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

interface MigrationGroup {
  readonly foreignKeysSuspended: boolean;
  readonly migrations: readonly KnowledgeCapsuleMigration[];
}

// Consecutive pending migrations that share the same `requiresForeignKeysSuspended` flag (KEIKO-
// 0371) apply together in one transaction. With no opted-in migration pending, this produces
// exactly one "not suspended" group holding every pending migration — byte-identical to the single
// shared transaction every migration used before the flag existed.
function groupPendingMigrations(
  pending: readonly KnowledgeCapsuleMigration[],
): readonly MigrationGroup[] {
  const groups: MigrationGroup[] = [];
  for (const migration of pending) {
    const foreignKeysSuspended = migration.requiresForeignKeysSuspended === true;
    const current = groups.at(-1);
    if (current?.foreignKeysSuspended === foreignKeysSuspended) {
      groups[groups.length - 1] = {
        foreignKeysSuspended,
        migrations: [...current.migrations, migration],
      };
    } else {
      groups.push({ foreignKeysSuspended, migrations: [migration] });
    }
  }
  return groups;
}

function applyMigrationStatements(
  db: DatabaseSync,
  migrations: readonly KnowledgeCapsuleMigration[],
): void {
  for (const migration of migrations) {
    for (const statement of migration.up) {
      db.exec(statement);
    }
    setUserVersion(db, migration.version);
  }
}

// The path every migration used before KEIKO-0371: one shared transaction, foreign keys enforced
// throughout (applyDurabilityPragmas already turned them on before runMigrations ever runs). A
// migration that does not set `requiresForeignKeysSuspended` still runs exactly this way.
function applyStandardMigrationGroup(
  db: DatabaseSync,
  migrations: readonly KnowledgeCapsuleMigration[],
): void {
  db.exec("BEGIN");
  try {
    applyMigrationStatements(db, migrations);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface ForeignKeyViolationRow {
  readonly table: string;
}

// `PRAGMA foreign_key_check` never throws by itself — it returns one row per violation found
// anywhere in the database (empty when clean) — so a suspended-enforcement rebuild must query it
// explicitly and fail closed itself rather than trust silence.
function assertNoForeignKeyViolations(db: DatabaseSync): void {
  const violations = db
    .prepare("PRAGMA foreign_key_check")
    .all() as unknown as ForeignKeyViolationRow[];
  if (violations.length === 0) return;
  const tables = [...new Set(violations.map((row) => row.table))]
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
  throw new KnowledgeStoreError(
    `Foreign key check found ${String(violations.length)} violation(s) in [${tables}] after a ` +
      "foreign-keys-suspended migration rebuild; rolling back rather than committing orphaned rows.",
  );
}

// The KEIKO-0371 path: a migration whose `up` DROPs a table that other tables reference with `ON
// DELETE CASCADE` must not run with foreign keys on, or the DROP cascades and silently deletes
// every dependent row (SQLite fires FK actions for DROP TABLE exactly like a real DELETE).
// `PRAGMA foreign_keys` is a documented no-op once a transaction is open, so it is toggled here,
// before BEGIN and after COMMIT/ROLLBACK — never inside the transaction. `PRAGMA foreign_key_check`
// runs before COMMIT so a row the rebuild would orphan aborts the migration instead of corrupting
// the store; the `finally` guarantees enforcement is back on for every later migration group and
// for the runtime, whether this group succeeded or failed.
function applySuspendedForeignKeyMigrationGroup(
  db: DatabaseSync,
  migrations: readonly KnowledgeCapsuleMigration[],
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      applyMigrationStatements(db, migrations);
      assertNoForeignKeyViolations(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyMigrationGroup(db: DatabaseSync, group: MigrationGroup): void {
  if (group.foreignKeysSuspended) {
    applySuspendedForeignKeyMigrationGroup(db, group.migrations);
  } else {
    applyStandardMigrationGroup(db, group.migrations);
  }
}

function runMigrations(db: DatabaseSync): void {
  const start = currentUserVersion(db);
  if (start > LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION) {
    throw new KnowledgeStoreError(
      `Knowledge-capsule schema version ${String(start)} is newer than this binary supports (${String(
        LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
      )})`,
    );
  }
  const pending = KNOWLEDGE_CAPSULE_MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  try {
    for (const group of groupPendingMigrations(pending)) {
      applyMigrationGroup(db, group);
    }
  } catch (error) {
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

type OpenAttempt =
  | { readonly status: "ok"; readonly db: DatabaseSync }
  | { readonly status: "corrupt"; readonly cause: unknown }
  | { readonly status: "error"; readonly cause: unknown };

// Unwrap hook for the shared classifier: peel every KnowledgeStoreError layer that carries a cause so
// the sealed SQLite error underneath is classified rather than the wrapper. Recursive to match the
// previous local sqliteErrorLike, which stripped nested wrappers to the innermost cause.
function unwrapKnowledgeStoreError(error: unknown): unknown {
  return error instanceof KnowledgeStoreError && error.cause !== undefined
    ? unwrapKnowledgeStoreError(error.cause)
    : error;
}

const isSqliteCorruptionError = (error: unknown): boolean =>
  sharedIsSqliteCorruptionError(error, unwrapKnowledgeStoreError);
const errorRecord = (error: unknown): Record<string, unknown> =>
  sharedErrorRecord(error, unwrapKnowledgeStoreError);

function assertQuickCheckOk(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as readonly Record<string, unknown>[];
  const values = rows
    .map((row) => Object.values(row)[0])
    .filter((value): value is string => typeof value === "string");
  if (values.length === 1 && values[0] === "ok") return;
  throw new SqliteQuickCheckError(values.length > 0 ? values : ["no quick_check rows returned"]);
}

function quarantineFile(target: string, cause?: unknown): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${target}.corrupt.${ts}`;
  if (existsSync(target)) {
    renameSync(target, quarantinedPath);
  }
  const sidecarQuarantinePaths: string[] = [];
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(sidecar)) {
      const sidecarQuarantinePath = `${sidecar}.corrupt.${ts}`;
      renameSync(sidecar, sidecarQuarantinePath);
      sidecarQuarantinePaths.push(sidecarQuarantinePath);
    }
  }
  writeFileSync(
    `${quarantinedPath}.diagnostic.json`,
    `${JSON.stringify(
      {
        incidentId: randomUUID(),
        store: "local-knowledge",
        timestamp: new Date().toISOString(),
        dbPath: target,
        quarantinedPath,
        sidecarQuarantinePaths,
        cause: errorRecord(cause ?? new Error("manual quarantine")),
      },
      null,
      2,
    )}\n`,
    { mode: FILE_MODE },
  );
}

function tryOpenAndMigrate(dbPath: string): OpenAttempt {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (cause) {
    return isSqliteCorruptionError(cause)
      ? { status: "corrupt", cause }
      : { status: "error", cause };
  }
  try {
    applyDurabilityPragmas(db);
    assertQuickCheckOk(db);
    if (hasAnyUserContent(db) && !expectedV1TablesPresent(db)) {
      // Pre-existing foreign schema or a partial install missing even the v1 tables is not
      // proven SQLite corruption. Refuse to overwrite it; an operator can inspect it in place.
      db.close();
      return {
        status: "error",
        cause: new KnowledgeStoreError(
          `Knowledge-capsule store at ${dbPath} has an unexpected schema; refusing to quarantine without confirmed SQLite corruption.`,
        ),
      };
    }
    runMigrations(db);
    if (!expectedTablesPresent(db)) {
      db.close();
      return {
        status: "error",
        cause: new KnowledgeStoreError(
          `Knowledge-capsule store at ${dbPath} is missing expected tables after migration; refusing to quarantine without confirmed SQLite corruption.`,
        ),
      };
    }
    return { status: "ok", db };
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Ignore close failure; the original open/migration cause controls recovery classification.
    }
    return isSqliteCorruptionError(cause)
      ? { status: "corrupt", cause }
      : { status: "error", cause };
  }
}

function restrictStoreFilePermissions(dbPath: string): void {
  chmodIfPresent(dbPath, FILE_MODE);
  chmodIfPresent(`${dbPath}-wal`, FILE_MODE);
  chmodIfPresent(`${dbPath}-shm`, FILE_MODE);
}

// Both log sites below sit inside a catch block whose contract is that it introduces NO new
// failure: the quarantine path is mid-recovery, and the encryption path is about to rethrow the
// cause the caller must see. An injected sink is foreign code — the server's file sink can hit a
// full disk, and a test double can throw outright — so an unguarded `write` there would replace a
// diagnosable store failure with a logging failure. Evidence about a failure must never become
// the failure.
//
// The write is NOT swallowed, though: quarantine is the one data-losing decision this file makes,
// and a lost line about it that nobody can see is how four releases shipped against silence.
// `emitKnowledgeLogEvent` owns both halves — it never throws at this call site, AND it reports a
// failing sink once through the sink itself, or through the process warning channel when the sink
// is dead. Keeping that logic in `knowledge-log.ts` rather than here is deliberate: the same
// guarantee is owed by the indexing orchestrator and the embedding batcher, and one implementation
// cannot drift from itself.
function writeStoreLog(opts: OpenKnowledgeStoreOptions, event: KnowledgeLogEvent): void {
  emitKnowledgeLogEvent(opts.logSink, event);
}

// Recovering from confirmed SQLite corruption trades the old database for an empty one. That is
// the correct fail-forward, but it is a DATA-LOSING decision, so it is recorded at `error` even
// when the reopen succeeds — and separately when the reopen does not.
function logStoreQuarantine(
  opts: OpenKnowledgeStoreOptions,
  cause: unknown,
  reopened: boolean,
): void {
  writeStoreLog(opts, {
    level: "error",
    category: "diagnostic",
    op: "knowledge.store.quarantined",
    errorKind: knowledgeErrorKind(cause),
    extra: { reopened },
  });
}

export function openKnowledgeStore(opts: OpenKnowledgeStoreOptions): KnowledgeStore {
  ensureDirHardened(dirname(opts.dbPath));
  let attempt = tryOpenAndMigrate(opts.dbPath);
  if (attempt.status === "corrupt") {
    const corruptionCause = attempt.cause;
    quarantineFile(opts.dbPath, corruptionCause);
    attempt = tryOpenAndMigrate(opts.dbPath);
    logStoreQuarantine(opts, corruptionCause, attempt.status === "ok");
  }
  if (attempt.status !== "ok") {
    throw new KnowledgeStoreError(`Failed to open knowledge-capsule store at ${opts.dbPath}.`, {
      cause: attempt.cause,
    });
  }
  const db = attempt.db;
  // The cipher binds the key resolved for the migrated schema version. Reconcile the store's on-disk
  // encryption state before the handle is usable: this seals a legacy plaintext store forward, or
  // fails closed on a wrong key / missing provider for an already-encrypted store (ADR-0047 D4). A
  // failure here closes the handle so a half-open store never leaks.
  let contentCipher: StoreContentCipher;
  try {
    contentCipher = resolveContentCipher(opts, currentUserVersion(db));
    applyStoreContentEncryption(db, contentCipher, opts.logSink);
  } catch (cause) {
    db.close();
    // Fail-closed: a wrong key or a missing provider for an already-encrypted store. The throw
    // reaches the caller, but the reason is buried in a cause chain the server surfaces as an
    // opaque failure — the kind belongs in the log where an operator will actually find it.
    writeStoreLog(opts, {
      level: "error",
      category: "diagnostic",
      op: "knowledge.store.encryption-rejected",
      errorKind: knowledgeErrorKind(cause),
      extra: { protectionMode: opts.protection?.mode ?? "plaintext-local-file-permissions" },
    });
    throw cause;
  }
  restrictStoreFilePermissions(opts.dbPath);
  const now = opts.clock ?? defaultClock;
  const handle = db;
  return {
    close: (): void => {
      handle.close();
    },
    _internal: { db: handle, now, contentCipher },
  };
}

// ─── Store fingerprint (Wave 4a, epic #3233 §6.2) ──────────────────────────────
//
// A redacted, point-in-time snapshot of this store's schema/integrity state, embedded in the
// support bundle manifest's `storeFingerprints` array. Read-only and never throwing: a bundle
// export must not fail because the store it is reporting on is itself unhealthy — an unreadable
// signal degrades to its own closed-vocabulary "unavailable" reading rather than aborting the
// whole fingerprint.

// Genuinely read-only open for a diagnostic snapshot. Unlike `openKnowledgeStore` above, this
// never runs `runMigrations`, `applyStoreContentEncryption`, or the corruption-quarantine reopen
// loop — every one of those is a write, and a fingerprint export must not migrate, re-encrypt, or
// quarantine the very store an operator is trying to inspect. It also returns the raw handle
// rather than a `KnowledgeStore`, so a caller never needs to reach into `KnowledgeStore._internal`
// (deliberately package-private, see the doc comment on `KnowledgeStore` above) just to fingerprint
// a store. `computeStoreFingerprint` below needs only `PRAGMA user_version`/`quick_check` and fixed
// `SELECT COUNT(*)` reads, none of which need write access.
export function openKnowledgeStoreReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // A short busy_timeout (Finding 2) so a reader opened with no wait bound does not spuriously
  // report the store `open-failed` on an immediate SQLITE_BUSY from a concurrent WAL checkpoint
  // or schema-changing transaction on a live production server. Connection-local PRAGMA: no write,
  // does not throw on a `readOnly: true` handle, so the read-only guarantee above is unaffected.
  db.exec(`PRAGMA busy_timeout = ${String(LK_STORE_BUSY_TIMEOUT_MS)}`);
  return db;
}

// Reuses the SAME source list and comparison `runMigrations` already applies (`version` vs the
// current `PRAGMA user_version`), just inverted: applied, not pending. Migration-group names are
// `v<version>` — the manifest only carries `version`/`reason`, and `reason` is a free-text
// sentence unsafe to embed verbatim in a redacted manifest field.
function migrationsAppliedThrough(schemaVersion: number): readonly string[] {
  return KNOWLEDGE_CAPSULE_MIGRATIONS.filter((migration) => migration.version <= schemaVersion).map(
    (migration) => `v${String(migration.version)}`,
  );
}

interface RowCount {
  readonly n: number;
}

// `KNOWLEDGE_CAPSULE_TABLES` is the same FIXED, package-owned table list `expectedTablesPresent`
// already validates post-migration — never a dynamic walk of `sqlite_master`, and never a
// caller-influenced name reaching SQL text.
function tableRowCountsFor(db: DatabaseSync): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of KNOWLEDGE_CAPSULE_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as RowCount | undefined;
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

// A boolean projection of `assertQuickCheckOk`'s pass/fail — never the raw check-output rows,
// and never throwing: a fingerprint reports a bad quick_check as `false` rather than aborting the
// whole manifest assembly over one store's integrity.
function quickCheckOkFor(db: DatabaseSync): boolean {
  try {
    assertQuickCheckOk(db);
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes a {@link StoreFingerprint} for this package's capsule store. Read-only, pure
 * introspection over an already-open handle — never mutates, never throws.
 *
 * `keySource` is intentionally omitted: `KnowledgeStoreKeyProvider` carries only `providerId`,
 * with no key-resolution-tier concept to report (unlike the vault-backed stores this field also
 * covers), and this function takes only `db` so it has no provider to ask in any case.
 */
export function computeStoreFingerprint(db: DatabaseSync): StoreFingerprint {
  const schemaVersion = currentUserVersion(db);
  return {
    store: "local-knowledge",
    schemaVersion,
    migrationsApplied: migrationsAppliedThrough(schemaVersion),
    tableRowCounts: tableRowCountsFor(db),
    quickCheckOk: quickCheckOkFor(db),
    encryptionMode: readStoreEncryptionMode(db),
  };
}
