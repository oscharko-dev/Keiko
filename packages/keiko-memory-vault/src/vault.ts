// createMemoryVault — the integration layer. Composes path resolution, DB lifecycle, validator
// gate, boundary redaction, prepared-SQL adapters, and the optional onMemoryEvent callback into
// a single MemoryVaultStore port. Every public method follows the same order:
//
//   1. validate (throws MemoryStorageValidationError before any SQL touches)
//   2. redact at the boundary (applies the factory redactString to free-text fields)
//   3. execute the prepared SQL (transactional when the method writes more than one row)
//   4. fire onMemoryEvent (AFTER commit, never on rollback)
//
// Steps 1-3 are pure-functional in TS-space until the SQL prepare() runs, so a thrown validator
// or redact exception leaves the database untouched. Step 4 sees only the post-commit truth.

import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts/memory";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { chmodIfPresent, openMemoryDatabase } from "./db.js";
import { resolveMemoryDir, resolveMemoryDbPath } from "./paths.js";
import {
  createMemoryContentCipher,
  keyFromKeychain,
  resolveVaultKey,
  type MemoryContentCipher,
  type VaultKeySource,
} from "./cipher.js";
import {
  emitMemoryVaultLogEvent,
  startMemoryVaultLogTimer,
  type MemoryVaultLogSink,
} from "./vault-log.js";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import {
  deleteMemoryRow,
  getMemoryRow,
  insertMemoryRow,
  listMemoriesAcrossScopeRows,
  listMemoryScopeRows,
  listMemoryMetadataByScopeRows,
  listMemoriesByScopeRows,
  updateMemoryRow,
} from "./memories.js";
import {
  deleteEdgeRow,
  insertEdgeRow,
  listEdgeRowsForMemoryIds,
  listIncomingEdgeRows,
  listOutgoingEdgeRows,
} from "./edges.js";
import {
  deleteEmbeddingRow,
  getEmbeddingRow,
  getEmbeddingRows,
  upsertEmbeddingRow,
} from "./embeddings.js";
import {
  getAccessStatsRows,
  recordAccessRows,
  recordOutcomeRows,
  type MemoryAccessStat,
} from "./access.js";
import {
  deleteTombstonesByScopeBeforeRows,
  hasSemanticallySimilarForgetTombstoneRow,
  insertTombstoneRow,
  listTombstonesPageRows,
  listTombstonesByScopeRows,
  selectForgetSuppressionBodyHashPresence,
  tombstoneLedgerCursorBelongsToScopes,
  updateTombstoneBodyHashByScopeRows,
} from "./tombstones.js";
import {
  gateDeleteOptions,
  gateEmbeddingInput,
  gateMemoryEdge,
  gateMemoryRecord,
  gateMemoryScope,
} from "./validate.js";
import { redactMemoryEdge, redactMemoryRecord, redactTombstone } from "./redact-record.js";
import {
  MemoryStorageError,
  MemoryStoragePreconditionError,
  MemoryStorageValidationError,
} from "./errors.js";
import {
  memoryBodySuppressionHash,
  memoryBodySuppressionHashForVault,
} from "./body-fingerprint.js";
import { sanitizeMemoryTombstoneReason } from "./tombstone-reason.js";
import type {
  MemoryBatchDelete,
  DeleteMemoryOptions,
  MemoryBatchUpdate,
  ListMemoriesOptions,
  MemoryDeleteResult,
  MemoryEmbeddingInput,
  MemoryEmbeddingRow,
  MemoryEvent,
  MemoryGraphMutation,
  MemoryGraphPrecondition,
  MemoryGraphMutationResult,
  MemoryTombstone,
  MemoryTombstoneLedgerCursor,
  MemoryTombstonePage,
  MemoryUpdatePatch,
  MemoryVaultFactoryOptions,
  MemoryVaultStore,
} from "./types.js";

interface ResolvedOptions {
  readonly now: () => number;
  readonly newTombstoneId: () => string;
  readonly redactString: (input: string) => string;
  readonly emit: (event: MemoryEvent) => void;
  readonly beforeDeleteCommit: (events: readonly MemoryEvent[]) => void;
  readonly hardenSidecars: () => void;
  readonly cipher: MemoryContentCipher;
  readonly bodySuppressionHash: (body: string) => string;
}

const IDENTITY: (s: string) => string = (s) => s;
const DEFAULT_NOW: () => number = () => Date.now();
const DEFAULT_NEW_TOMBSTONE_ID: () => string = () => randomUUID();
const NOOP_EMIT: (e: MemoryEvent) => void = () => undefined;
const NOOP_BEFORE_DELETE_COMMIT: (events: readonly MemoryEvent[]) => void = () => undefined;

// Single named entry point for the default environment read so the literal `process.env`
// reference does not appear inline in business logic (audit AC19).
function defaultEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

function resolveOptions(
  opts: MemoryVaultFactoryOptions | undefined,
  cipher: MemoryContentCipher,
  dbPath: string,
  bodySuppressionKey: Buffer,
): ResolvedOptions {
  const resolved: MemoryVaultFactoryOptions = opts ?? {};
  return {
    now: resolved.now ?? DEFAULT_NOW,
    newTombstoneId: resolved.newTombstoneId ?? DEFAULT_NEW_TOMBSTONE_ID,
    redactString: resolved.redactString ?? IDENTITY,
    emit: resolved.onMemoryEvent ?? NOOP_EMIT,
    beforeDeleteCommit: resolved.onDeleteEventsBeforeCommit ?? NOOP_BEFORE_DELETE_COMMIT,
    hardenSidecars: (): void => {
      hardenVaultSidecars(dbPath);
    },
    cipher,
    bodySuppressionHash: (body: string): string =>
      memoryBodySuppressionHashForVault(body, bodySuppressionKey),
  };
}

function hardenVaultSidecars(dbPath: string): void {
  chmodIfPresent(dbPath, 0o600);
  chmodIfPresent(`${dbPath}-wal`, 0o600);
  chmodIfPresent(`${dbPath}-shm`, 0o600);
}

function withSidecarHardening<T>(opts: ResolvedOptions, write: () => T): T {
  try {
    return write();
  } finally {
    opts.hardenSidecars();
  }
}

// Atomic vault-wide REPLACE for `keiko memory reembed --force` — the ONLY caller. One
// transaction: enumerate → concurrent-write check → delete every existing embedding row →
// reinsert the staged set. Any failure inside the swap rolls the whole transaction back
// so the prior vector space is preserved. The embedding-row schema check rejects a new
// (provider, modelId, dimensions, metric) tuple while any pre-existing row from the OLD
// tuple survives, so the delete phase must complete before the first insert; performing
// both under one BEGIN IMMEDIATE/COMMIT guarantees that AND takes the RESERVED lock up
// front so no other writer can slip an embedding row in between the enumeration and the
// delete phase.
interface EmbeddingRowSnapshot {
  readonly memory_id: string;
  readonly created_at: number;
}

// PR-review follow-up (Codex threads 3769711634 + 3769903807 + 3770110875): concurrent
// INSERT, UPDATE, and DELETE detection for --force. The CLI staged vectors OUTSIDE this
// transaction (network embed calls are slow), so between snapshot and swap another writer
// may have inserted a new embedding row (id not in stagedIds), upserted a fresh vector
// for one of our staged rows (created_at differs from the snapshot), or deleted a row
// that WAS in the snapshot. All three would silently corrupt the swap:
//   - INSERT: our vault-wide delete drops the new row.
//   - UPDATE: our staged vector overwrites the newer vector with a stale one.
//   - DELETE: our staged vector recreates the row the deleter meant to remove.
// Refuse and let the operator retry.
function assertReembedSetUnchanged(
  existing: readonly EmbeddingRowSnapshot[],
  stagedIds: ReadonlySet<MemoryId>,
  expectedSnapshot: ReadonlyMap<MemoryId, number> | undefined,
): void {
  const extras = existing.filter((row) => !stagedIds.has(row.memory_id as MemoryId));
  if (extras.length > 0) {
    throw new MemoryStorageError(
      "precondition-failed",
      "Embedding vector space changed during --force staging; rerun.",
    );
  }
  if (expectedSnapshot === undefined) return;
  const currentIds = new Set<MemoryId>(existing.map((row) => row.memory_id as MemoryId));
  for (const [expectedId] of expectedSnapshot) {
    if (!currentIds.has(expectedId)) {
      throw new MemoryStorageError(
        "precondition-failed",
        "Embedding row deleted during --force staging; rerun.",
      );
    }
  }
  for (const row of existing) {
    const expected = expectedSnapshot.get(row.memory_id as MemoryId);
    if (expected === undefined || expected !== row.created_at) {
      throw new MemoryStorageError(
        "precondition-failed",
        "Embedding row changed during --force staging; rerun.",
      );
    }
  }
}

// PR-review follow-up (Codex thread 3770211415): a memory whose body was edited during the
// CLI's network-backed staging phase would otherwise get committed with a vector generated
// from the OLD body — the embedding-row snapshot never sees the mutation because a new
// memory has no prior embedding row and the BFF's best-effort refresh may fail silently.
// Read each expected memory's current updated_at inside the transaction and refuse the
// swap on any drift. Missing rows are also drift (concurrent delete). Absent expectation
// map skips the check for backward callers.
function assertMemoryVersionsUnchanged(
  db: DatabaseSync,
  expectedMemoryVersions: ReadonlyMap<MemoryId, number> | undefined,
): void {
  if (!expectedMemoryVersions?.size) return;
  const stmt = db.prepare("SELECT updated_at FROM memories WHERE id = ?");
  for (const [memoryId, expectedUpdatedAt] of expectedMemoryVersions) {
    const row = stmt.get(memoryId) as { readonly updated_at: number } | undefined;
    if (row?.updated_at !== expectedUpdatedAt) {
      throw new MemoryStorageError(
        "precondition-failed",
        "Memory revision changed during --force staging; rerun.",
      );
    }
  }
}

// PR-review follow-ups (Codex 3771128741 + 3771970107): the accepted-memory set must be
// checked for equality against the expectation in BOTH directions — a newly-accepted memory
// that is missing from the expectation, AND a previously-accepted memory that has since
// been archived (or otherwise left the accepted set). One-way inclusion is not enough:
// consider a memory M in the CLI's target snapshot that is archived after the target
// snapshot but before its row is read, so the CLI captures its post-archive updated_at as
// the expected memory-version. assertMemoryVersionsUnchanged would then observe the same
// updated_at and pass, and a one-way accepted check would also pass (M is absent from BOTH
// current rows and the expectation-covered slice of them). The swap would then attach a
// new embedding to a memory that is no longer accepted. Enforcing set equality closes that
// window: any status drift — addition or removal — aborts the force swap. Absent
// expectation set skips the check for backward callers.
function assertAcceptedSetUnchanged(
  db: DatabaseSync,
  expectedAcceptedIds: ReadonlySet<MemoryId> | undefined,
): void {
  if (expectedAcceptedIds === undefined) return;
  const rows = db.prepare("SELECT id FROM memories WHERE status = 'accepted'").all() as {
    readonly id: string;
  }[];
  const currentAcceptedIds = new Set<MemoryId>(rows.map((row) => row.id as MemoryId));
  for (const currentId of currentAcceptedIds) {
    if (!expectedAcceptedIds.has(currentId)) {
      throw new MemoryStorageError(
        "precondition-failed",
        "Accepted memory set changed during --force staging; rerun.",
      );
    }
  }
  for (const expectedId of expectedAcceptedIds) {
    if (!currentAcceptedIds.has(expectedId)) {
      throw new MemoryStorageError(
        "precondition-failed",
        "Accepted memory set changed during --force staging; rerun.",
      );
    }
  }
}

function snapshotEmbeddedMemoryIdsFromDb(db: DatabaseSync): ReadonlyMap<MemoryId, number> {
  const rows = db
    .prepare("SELECT memory_id, created_at FROM memory_embeddings")
    .all() as unknown as EmbeddingRowSnapshot[];
  const snapshot = new Map<MemoryId, number>();
  for (const row of rows) snapshot.set(row.memory_id as MemoryId, row.created_at);
  return snapshot;
}

function replaceAllEmbeddingRowsAtomically(
  db: DatabaseSync,
  opts: ResolvedOptions,
  pairs: readonly { readonly memoryId: MemoryId; readonly input: MemoryEmbeddingInput }[],
  expectedSnapshot: ReadonlyMap<MemoryId, number> | undefined,
  expectedMemoryVersions: ReadonlyMap<MemoryId, number> | undefined,
  expectedAcceptedIds: ReadonlySet<MemoryId> | undefined,
): void {
  // PR-review follow-up (Codex thread 3769903813): the bulk path used to skip
  // gateEmbeddingInput, so a provider returning a vector above MAX_EMBEDDING_DIMENSIONS
  // (or with a non-finite element, empty vector, unknown metric, etc.) could be persisted
  // via upsertEmbeddingRow. Validate every pair up front so the vault-wide swap enforces
  // the same input bounds the single-row upsert does.
  for (const pair of pairs) gateEmbeddingInput(pair.input);
  const stagedIds = new Set<MemoryId>(pairs.map((pair) => pair.memoryId));
  db.exec("BEGIN IMMEDIATE");
  let existing: readonly EmbeddingRowSnapshot[] = [];
  try {
    existing = db
      .prepare("SELECT memory_id, created_at FROM memory_embeddings")
      .all() as unknown as EmbeddingRowSnapshot[];
    assertReembedSetUnchanged(existing, stagedIds, expectedSnapshot);
    assertMemoryVersionsUnchanged(db, expectedMemoryVersions);
    assertAcceptedSetUnchanged(db, expectedAcceptedIds);
    for (const row of existing) {
      deleteEmbeddingRow(db, row.memory_id as MemoryId);
    }
    for (const pair of pairs) {
      upsertEmbeddingRow(db, pair.memoryId, pair.input, opts.now(), opts.cipher);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const row of existing) {
    opts.emit({ kind: "embedding:deleted", memoryId: row.memory_id as MemoryId });
  }
  for (const pair of pairs) {
    opts.emit({
      kind: "embedding:upserted",
      memoryId: pair.memoryId,
      provider: pair.input.provider,
      modelId: pair.input.modelId,
    });
  }
}

const SUPPRESSION_HMAC_KEY_NAME = "body-suppression-hmac-v1";
const SUPPRESSION_HMAC_KEY_BYTES = 32;

function decodeSuppressionKey(raw: string): Buffer | undefined {
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === SUPPRESSION_HMAC_KEY_BYTES ? decoded : undefined;
}

function resolveBodySuppressionKey(db: DatabaseSync, cipher: MemoryContentCipher): Buffer {
  const existing = db
    .prepare("SELECT value FROM memory_vault_secrets WHERE name = ?")
    .get(SUPPRESSION_HMAC_KEY_NAME) as { value?: string } | undefined;
  if (typeof existing?.value === "string") {
    const opened = decodeSuppressionKey(cipher.openString(existing.value));
    if (opened !== undefined) return opened;
  }
  const key = randomBytes(SUPPRESSION_HMAC_KEY_BYTES);
  db.prepare("INSERT OR REPLACE INTO memory_vault_secrets (name, value) VALUES (?, ?)").run(
    SUPPRESSION_HMAC_KEY_NAME,
    cipher.sealString(key.toString("base64")),
  );
  return key;
}

interface ResolvedCipherWithSource {
  readonly cipher: MemoryContentCipher;
  // `undefined` for a test-injected cipher/vaultKey, where no key-resolution tier ran at all —
  // never a made-up label for a tier that was never actually consulted.
  readonly keySource: VaultKeySource | undefined;
}

// Resolve the content cipher. Precedence: an explicitly injected cipher (tests), then an injected
// raw key (tests/CI), then the real tiered resolver (KEIKO_MEMORY_KEY > keychain > keyfile). The
// public factory never requires any of these — production callers get the tiered resolver.
//
// The resolved tier is RETAINED here rather than discarded (previously `resolveVaultKey(...).key`
// threw the `source` half away — the store-open event this file now emits is exactly the field an
// operator needs to tell "the vault opened using an env override" from "the vault fell all the way
// through to the weaker keyfile tier" without re-deriving it from a second key-resolution call).
//
// `securityLogSink` (Wave 4a, epic #3233 §8) is threaded into the keychain tier's own bounded
// reader (`keyFromKeychain`, `cipher.ts`) rather than into `resolveVaultKey` itself: neither an
// injected cipher nor an injected raw key ever touches the keychain, so building the sink-wired
// closure only on the path that actually resolves through it keeps a test-injected key from paying
// for, or depending on, a sink it will never call.
function resolveCipherWithSource(
  opts: MemoryVaultFactoryOptions | undefined,
  env: Readonly<Record<string, string | undefined>>,
  securityLogSink: SecurityLogSink | undefined,
): ResolvedCipherWithSource {
  if (opts?.cipher !== undefined) return { cipher: opts.cipher, keySource: undefined };
  if (opts?.vaultKey !== undefined) {
    return { cipher: createMemoryContentCipher(opts.vaultKey), keySource: undefined };
  }
  const memoryDir = resolveMemoryDir(opts?.memoryDir, env);
  const resolved = resolveVaultKey(env, memoryDir, () =>
    keyFromKeychain({ sink: securityLogSink }),
  );
  return { cipher: createMemoryContentCipher(resolved.key), keySource: resolved.source };
}

function emitVaultOpened(
  sink: MemoryVaultLogSink | undefined,
  keySource: VaultKeySource | undefined,
  durationMs: number,
): void {
  emitMemoryVaultLogEvent(sink, {
    category: "memory",
    op: "memory-vault.store.opened",
    durationMs,
    ...(keySource === undefined ? {} : { extra: { keySource } }),
  });
}

// Validate-then-redact for inserts. The validator runs on the CALLER-SUPPLIED record so a
// validation failure carries the caller's exact failure list. Redaction runs SECOND so the SQL
// row is the redacted form — a secret-shaped string that slipped past the capture-layer gate
// in #207 is scrubbed before persistence.
function preparedForWrite(record: MemoryRecord, opts: ResolvedOptions): MemoryRecord {
  const validated = gateMemoryRecord(record);
  return redactMemoryRecord(validated, opts.redactString);
}

function preparedEdgeForWrite(edge: MemoryEdge, opts: ResolvedOptions): MemoryEdge {
  const validated = gateMemoryEdge(edge);
  return redactMemoryEdge(validated, opts.redactString);
}

function mergePatch(existing: MemoryRecord, patch: MemoryUpdatePatch, nowMs: number): MemoryRecord {
  // updatedAt is owned by the vault, not the patch, so the caller cannot regress it. createdAt
  // and the scope coordinate are immutable on update (scope changes require supersession +
  // re-insert by design — moving a record across scopes is an audit event, not a field write).
  //
  // PR-review follow-up (Codex thread 3771815009): assign a strictly-monotonic revision by
  // bumping updatedAt past the existing value when the clock cannot separate two writes
  // (same-millisecond retry, backwards clock adjustment). Without this bump, --force's
  // assertMemoryVersionsUnchanged precondition could accept a concurrent body/status
  // mutation whose updatedAt collides with the observed value, letting a vector generated
  // from the old body commit against the new record.
  const next: MemoryRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    schemaVersion: existing.schemaVersion,
    scope: existing.scope,
    createdAt: existing.createdAt,
    updatedAt: Math.max(nowMs, existing.updatedAt + 1),
  };
  return next;
}

function existingMemoryOrThrow(
  db: DatabaseSync,
  id: MemoryId,
  cipher: MemoryContentCipher,
): MemoryRecord {
  const existing = getMemoryRow(db, id, cipher);
  if (existing === undefined) {
    throw new MemoryStorageError("not-found", "Memory not found.");
  }
  return existing;
}

function buildTombstone(
  record: MemoryRecord,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): MemoryTombstone {
  const reason = sanitizeMemoryTombstoneReason(options.reason);
  const base = {
    id: opts.newTombstoneId(),
    memoryId: record.id,
    scopeKind: scopeKindOf(record.scope),
    scopeCoordinate: scopeCoordinateOf(record.scope),
    type: record.type,
    forgottenAt: options.nowMs,
    forgetterSurface: options.forgetterSurface,
    bodyHash: opts.bodySuppressionHash(record.body),
    originalStatus: record.status,
  };
  return {
    ...base,
    ...(options.reviewerId === undefined ? {} : { reviewerId: options.reviewerId }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function assertTombstoneMatchesRecord(record: MemoryRecord, tombstone: MemoryTombstone): void {
  if (
    tombstone.memoryId !== record.id ||
    tombstone.scopeKind !== scopeKindOf(record.scope) ||
    tombstone.scopeCoordinate !== scopeCoordinateOf(record.scope)
  ) {
    throw new MemoryStorageError(
      "internal",
      "Tombstone scope invariant violated for deleted memory.",
    );
  }
}

type MemoryMutators = Pick<
  MemoryVaultStore,
  | "insertMemory"
  | "updateMemory"
  | "updateMemories"
  | "applyGraphMutation"
  | "deleteMemory"
  | "deleteMemories"
  | "getMemory"
  | "listMemoryScopes"
  | "listMemoriesAcrossScopes"
  | "listMemoriesByScope"
  | "listMemoryMetadataByScope"
  | "listMemoryIdsByStatus"
  | "listAcceptedMemoryIdsMissingEmbedding"
  | "countMemoriesByStatus"
  | "countAcceptedMemoriesMissingEmbedding"
>;

// Internal-only: carries the forgotten memory's embedding (fetched BEFORE the row is deleted,
// since ON DELETE CASCADE removes memory_embeddings with it) alongside the public delete result, so
// applyPreparedDelete can seal it onto the tombstone. Never surfaced on MemoryDeleteResult itself —
// that public contract is unchanged (GEN-AI-MEMORY-003, RB-4).
interface PreparedDelete {
  readonly result: MemoryDeleteResult;
  readonly bodyEmbedding: Float32Array | undefined;
}

function prepareDelete(
  db: DatabaseSync,
  id: MemoryId,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): PreparedDelete {
  gateDeleteOptions(options);
  const existing = existingMemoryOrThrow(db, id, opts.cipher);
  const tombstone = options.tombstone
    ? redactTombstone(buildTombstone(existing, options, opts), opts.redactString)
    : undefined;
  if (tombstone !== undefined) {
    assertTombstoneMatchesRecord(existing, tombstone);
  }
  const bodyEmbedding =
    tombstone === undefined ? undefined : getEmbeddingRow(db, id, opts.cipher)?.vector;
  return { result: { memoryId: id, scope: existing.scope, tombstone }, bodyEmbedding };
}

function applyPreparedDelete(
  db: DatabaseSync,
  prepared: PreparedDelete,
  opts: ResolvedOptions,
): void {
  const { result } = prepared;
  if (!deleteMemoryRow(db, result.memoryId)) {
    throw new MemoryStorageError("not-found", "Memory not found.");
  }
  if (result.tombstone !== undefined) {
    insertTombstoneRow(db, result.tombstone, opts.cipher, prepared.bodyEmbedding);
  }
}

function eventsForDeletedRecords(results: readonly MemoryDeleteResult[]): readonly MemoryEvent[] {
  const events: MemoryEvent[] = [];
  for (const result of results) {
    events.push({
      kind: "memory:deleted",
      memoryId: result.memoryId,
      scope: result.scope,
      tombstoned: result.tombstone !== undefined,
    });
    if (result.tombstone !== undefined) {
      events.push({ kind: "memory:tombstoned", tombstone: result.tombstone });
    }
  }
  return events;
}

function runDelete(
  db: DatabaseSync,
  id: MemoryId,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): MemoryDeleteResult {
  const ready = prepareDelete(db, id, options, opts);
  db.exec("BEGIN");
  try {
    applyPreparedDelete(db, ready, opts);
    opts.beforeDeleteCommit(eventsForDeletedRecords([ready.result]));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready.result;
}

// Dedupe the batch by memory id BEFORE preparing/applying any delete. A repeated id in one batch
// call otherwise causes the second occurrence's applyPreparedDelete to observe changes===0 (the
// row was already removed by the first pass within the same transaction) and throw not-found,
// which rolls back every other valid deletion. Semantics are last-wins: when the same id appears
// more than once, the LAST occurrence's options survive (matching how a Map collapses duplicate
// keys). Audit KEIKO-0442.
function runBatchDeleteMemories(
  db: DatabaseSync,
  deletes: readonly MemoryBatchDelete[],
  opts: ResolvedOptions,
): readonly MemoryDeleteResult[] {
  const deduped = [...new Map(deletes.map((entry) => [entry.id, entry])).values()];
  const ready = deduped.map((entry) => prepareDelete(db, entry.id, entry.options, opts));
  db.exec("BEGIN");
  try {
    for (const prepared of ready) {
      applyPreparedDelete(db, prepared, opts);
    }
    opts.beforeDeleteCommit(eventsForDeletedRecords(ready.map((prepared) => prepared.result)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready.map((prepared) => prepared.result);
}

function updateMemoryInPlace(
  db: DatabaseSync,
  update: MemoryBatchUpdate,
  opts: ResolvedOptions,
): MemoryRecord {
  const existing = existingMemoryOrThrow(db, update.id, opts.cipher);
  if (update.expectedStatus !== undefined && existing.status !== update.expectedStatus) {
    throw new MemoryStoragePreconditionError("status");
  }
  if (update.expectedUpdatedAt !== undefined && existing.updatedAt !== update.expectedUpdatedAt) {
    throw new MemoryStoragePreconditionError("updatedAt");
  }
  const merged = mergePatch(existing, update.patch, update.nowMs);
  const ready = preparedForWrite(merged, opts);
  updateMemoryRow(db, ready, opts.cipher);
  return ready;
}

function runGraphMutation(
  db: DatabaseSync,
  mutation: MemoryGraphMutation,
  opts: ResolvedOptions,
): MemoryGraphMutationResult {
  const edges = mutation.edges.map((edge) => preparedEdgeForWrite(edge, opts));
  const memories: MemoryRecord[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const precondition of mutation.preconditions ?? []) {
      assertGraphPrecondition(db, precondition, opts.cipher);
    }
    for (const update of mutation.updates) {
      memories.push(updateMemoryInPlace(db, update, opts));
    }
    for (const edge of edges) {
      insertEdgeRow(db, edge, opts.cipher);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { memories, edges };
}

function assertGraphPrecondition(
  db: DatabaseSync,
  precondition: MemoryGraphPrecondition,
  cipher: MemoryContentCipher,
): void {
  const existing = existingMemoryOrThrow(db, precondition.id, cipher);
  if (existing.status !== precondition.expectedStatus) {
    throw new MemoryStoragePreconditionError("status");
  }
  if (existing.updatedAt !== precondition.expectedUpdatedAt) {
    throw new MemoryStoragePreconditionError("updatedAt");
  }
}

// PR-review follow-up (Codex thread 3772030490): single-row updateMemory used to run
// read-then-write without a transaction, so two concurrent writers on the same row could
// both read the same existing.updatedAt and compute the same +1 revision. That collision
// let --force's assertMemoryVersionsUnchanged accept a stale vector against a body that had
// been overwritten between snapshot and swap. Wrap in BEGIN IMMEDIATE so the write lock is
// held BEFORE the read — matching runBatchUpdateMemories' envelope — and no other writer
// can interleave. The mergePatch +1 monotonic bump stays load-bearing for same-millisecond
// writes within one connection.
function runSingleUpdateMemory(
  db: DatabaseSync,
  update: MemoryBatchUpdate,
  opts: ResolvedOptions,
): MemoryRecord {
  db.exec("BEGIN IMMEDIATE");
  try {
    const ready = updateMemoryInPlace(db, update, opts);
    db.exec("COMMIT");
    return ready;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runBatchUpdateMemories(
  db: DatabaseSync,
  updates: readonly MemoryBatchUpdate[],
  opts: ResolvedOptions,
): readonly MemoryRecord[] {
  const ready: MemoryRecord[] = [];
  // PR-review follow-up (Codex thread 3772030490): BEGIN (deferred) only takes the write lock
  // on the first UPDATE, leaving room for another writer to interleave a read of the same
  // updated_at before we do. BEGIN IMMEDIATE reserves the write lock up front so every
  // read + monotonic-revision compute happens under exclusive write access.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const update of updates) {
      ready.push(updateMemoryInPlace(db, update, opts));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready;
}

function emitUpdatedRecords(records: readonly MemoryRecord[], opts: ResolvedOptions): void {
  for (const record of records) {
    opts.emit({ kind: "memory:updated", record });
  }
}

function emitDeletedRecords(results: readonly MemoryDeleteResult[], opts: ResolvedOptions): void {
  for (const event of eventsForDeletedRecords(results)) {
    opts.emit(event);
  }
}

function deleteMemoryWithEvents(
  db: DatabaseSync,
  id: MemoryId,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): void {
  const result = runDelete(db, id, options, opts);
  emitDeletedRecords([result], opts);
}

type MemoryWriteOps = Pick<
  MemoryMutators,
  | "insertMemory"
  | "updateMemory"
  | "updateMemories"
  | "applyGraphMutation"
  | "deleteMemory"
  | "deleteMemories"
>;

type MemoryReadOps = Pick<
  MemoryMutators,
  | "getMemory"
  | "listMemoryScopes"
  | "listMemoriesAcrossScopes"
  | "listMemoriesByScope"
  | "listMemoryMetadataByScope"
  | "listMemoryIdsByStatus"
  | "listAcceptedMemoryIdsMissingEmbedding"
  | "countMemoriesByStatus"
  | "countAcceptedMemoriesMissingEmbedding"
>;

function buildMemoryWriteOps(db: DatabaseSync, opts: ResolvedOptions): MemoryWriteOps {
  return {
    insertMemory: (record: MemoryRecord): MemoryRecord => {
      return withSidecarHardening(opts, () => {
        const ready = preparedForWrite(record, opts);
        insertMemoryRow(db, ready, opts.cipher);
        opts.emit({ kind: "memory:inserted", record: ready });
        return ready;
      });
    },
    updateMemory: (id: MemoryId, patch: MemoryUpdatePatch, nowMs: number): MemoryRecord => {
      return withSidecarHardening(opts, () => {
        const ready = runSingleUpdateMemory(db, { id, patch, nowMs }, opts);
        opts.emit({ kind: "memory:updated", record: ready });
        return ready;
      });
    },
    updateMemories: (updates: readonly MemoryBatchUpdate[]): readonly MemoryRecord[] => {
      return withSidecarHardening(opts, () => {
        const ready = runBatchUpdateMemories(db, updates, opts);
        emitUpdatedRecords(ready, opts);
        return ready;
      });
    },
    applyGraphMutation: (mutation: MemoryGraphMutation): MemoryGraphMutationResult => {
      return withSidecarHardening(opts, () => {
        const ready = runGraphMutation(db, mutation, opts);
        emitUpdatedRecords(ready.memories, opts);
        for (const edge of ready.edges) {
          opts.emit({ kind: "edge:inserted", edge });
        }
        return ready;
      });
    },
    deleteMemory: (id: MemoryId, options: DeleteMemoryOptions): void => {
      withSidecarHardening(opts, () => {
        deleteMemoryWithEvents(db, id, options, opts);
      });
    },
    deleteMemories: (deletes: readonly MemoryBatchDelete[]): readonly MemoryDeleteResult[] => {
      return withSidecarHardening(opts, () => {
        const ready = runBatchDeleteMemories(db, deletes, opts);
        emitDeletedRecords(ready, opts);
        return ready;
      });
    },
  };
}

function buildMemoryReadOps(db: DatabaseSync, opts: ResolvedOptions): MemoryReadOps {
  return {
    getMemory: (id: MemoryId): MemoryRecord | undefined => getMemoryRow(db, id, opts.cipher),
    listMemoryScopes: (): readonly MemoryScope[] => listMemoryScopeRows(db),
    listMemoriesAcrossScopes: (
      scopes: readonly MemoryScope[],
      options?: ListMemoriesOptions,
    ): readonly MemoryRecord[] => {
      for (const scope of scopes) gateMemoryScope(scope);
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoriesAcrossScopeRows(db, scopes, effective, nowMs, opts.cipher);
    },
    listMemoriesByScope: (
      scope: MemoryScope,
      options?: ListMemoriesOptions,
    ): readonly MemoryRecord[] => {
      gateMemoryScope(scope);
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoriesByScopeRows(db, scope, effective, nowMs, opts.cipher);
    },
    listMemoryMetadataByScope: (
      scope: MemoryScope,
      options?: ListMemoriesOptions,
    ): ReturnType<MemoryVaultStore["listMemoryMetadataByScope"]> => {
      gateMemoryScope(scope);
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoryMetadataByScopeRows(db, scope, effective, nowMs);
    },
    listMemoryIdsByStatus: (status: MemoryStatus): readonly MemoryId[] =>
      listMemoryIdsByStatusFromDb(db, status),
    listAcceptedMemoryIdsMissingEmbedding: (limit: number): readonly MemoryId[] =>
      listAcceptedMemoryIdsMissingEmbeddingFromDb(db, limit),
    countMemoriesByStatus: (status: MemoryStatus): number =>
      countMemoriesByStatusFromDb(db, status),
    countAcceptedMemoriesMissingEmbedding: (): number =>
      countAcceptedMemoriesMissingEmbeddingFromDb(db),
  };
}

function countMemoriesByStatusFromDb(db: DatabaseSync, status: MemoryStatus): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = ?").get(status) as {
    readonly n: number;
  };
  return row.n;
}

function countAcceptedMemoriesMissingEmbeddingFromDb(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories AS m
       WHERE m.status = 'accepted'
         AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)`,
    )
    .get() as { readonly n: number };
  return row.n;
}

function listMemoryIdsByStatusFromDb(db: DatabaseSync, status: MemoryStatus): readonly MemoryId[] {
  const rows = db.prepare("SELECT id FROM memories WHERE status = ?").all(status) as {
    readonly id: string;
  }[];
  return rows.map((row) => row.id as MemoryId);
}

function listAcceptedMemoryIdsMissingEmbeddingFromDb(
  db: DatabaseSync,
  limit: number,
): readonly MemoryId[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT m.id FROM memories AS m
       WHERE m.status = 'accepted'
         AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)
       LIMIT ?`,
    )
    .all(limit) as { readonly id: string }[];
  return rows.map((row) => row.id as MemoryId);
}

function buildMemoryMutators(db: DatabaseSync, opts: ResolvedOptions): MemoryMutators {
  return {
    ...buildMemoryWriteOps(db, opts),
    ...buildMemoryReadOps(db, opts),
  };
}

type EdgeAndEmbeddingOps = Pick<
  MemoryVaultStore,
  | "insertEdge"
  | "listOutgoingEdges"
  | "listIncomingEdges"
  | "listEdgesForMemories"
  | "deleteEdge"
  | "upsertEmbedding"
  | "deleteEmbedding"
  | "replaceAllEmbeddings"
  | "listEmbeddedMemoryIds"
  | "snapshotEmbeddedMemoryIds"
  | "getEmbedding"
  | "getEmbeddings"
>;

type EdgeOps = Pick<
  MemoryVaultStore,
  "insertEdge" | "listOutgoingEdges" | "listIncomingEdges" | "listEdgesForMemories" | "deleteEdge"
>;

type EmbeddingOps = Pick<
  MemoryVaultStore,
  | "upsertEmbedding"
  | "deleteEmbedding"
  | "replaceAllEmbeddings"
  | "listEmbeddedMemoryIds"
  | "snapshotEmbeddedMemoryIds"
  | "getEmbedding"
  | "getEmbeddings"
>;

type TombstoneAndAccessOps = Pick<
  MemoryVaultStore,
  | "listTombstonesByScope"
  | "listTombstonesPage"
  | "hasForgetTombstoneForBody"
  | "hasSemanticallySimilarForgetTombstone"
  | "purgeTombstonesByScopeBefore"
  | "recordAccess"
  | "recordOutcome"
  | "getAccessStats"
>;

// The public route requests one look-ahead row beyond its maximum 200-item response page so it can
// issue a continuation cursor without an unbounded count/materialization read.
const MAX_TOMBSTONE_LEDGER_PAGE_ROWS = 201;

function gateTombstonePageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TOMBSTONE_LEDGER_PAGE_ROWS) {
    throw new MemoryStorageValidationError("Invalid tombstone page limit.", []);
  }
  return limit;
}

function gateTombstoneLedgerCursor(
  db: DatabaseSync,
  scopes: readonly MemoryScope[],
  after: MemoryTombstoneLedgerCursor | undefined,
): void {
  if (after === undefined) return;
  const shapeIsValid =
    Number.isSafeInteger(after.forgottenAt) &&
    after.forgottenAt >= 0 &&
    after.id.length > 0 &&
    after.id.length <= 200;
  if (!shapeIsValid || !tombstoneLedgerCursorBelongsToScopes(db, scopes, after)) {
    throw new MemoryStorageValidationError("Invalid tombstone page cursor.", []);
  }
}

function validatedTombstonePage(
  db: DatabaseSync,
  opts: ResolvedOptions,
  scopes: readonly MemoryScope[],
  limit: number,
  after: MemoryTombstoneLedgerCursor | undefined,
): MemoryTombstonePage {
  for (const scope of scopes) gateMemoryScope(scope);
  const boundedLimit = gateTombstonePageLimit(limit);
  gateTombstoneLedgerCursor(db, scopes, after);
  return listTombstonesPageRows(db, scopes, opts.cipher, boundedLimit, after);
}

function buildEdgeOps(db: DatabaseSync, opts: ResolvedOptions): EdgeOps {
  return {
    insertEdge: (edge: MemoryEdge): MemoryEdge => {
      return withSidecarHardening(opts, () => {
        const ready = preparedEdgeForWrite(edge, opts);
        insertEdgeRow(db, ready, opts.cipher);
        opts.emit({ kind: "edge:inserted", edge: ready });
        return ready;
      });
    },
    listOutgoingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listOutgoingEdgeRows(db, memoryId, opts.cipher),
    listIncomingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listIncomingEdgeRows(db, memoryId, opts.cipher),
    listEdgesForMemories: (
      memoryIds: readonly MemoryId[],
    ): ReturnType<MemoryVaultStore["listEdgesForMemories"]> =>
      listEdgeRowsForMemoryIds(db, memoryIds, opts.cipher),
    deleteEdge: (edgeId: MemoryEdgeId): void => {
      withSidecarHardening(opts, () => {
        const removed = deleteEdgeRow(db, edgeId);
        if (!removed) {
          throw new MemoryStorageError("not-found", "Edge not found.");
        }
        opts.emit({ kind: "edge:deleted", edgeId });
      });
    },
  };
}

function buildEmbeddingOps(db: DatabaseSync, opts: ResolvedOptions): EmbeddingOps {
  return {
    upsertEmbedding: (memoryId: MemoryId, embedding: MemoryEmbeddingInput): void => {
      upsertSingleEmbedding(db, opts, memoryId, embedding);
    },
    deleteEmbedding: (memoryId: MemoryId): void => {
      deleteSingleEmbedding(db, opts, memoryId);
    },
    replaceAllEmbeddings: (
      pairs: readonly { readonly memoryId: MemoryId; readonly input: MemoryEmbeddingInput }[],
      expectedSnapshot?: ReadonlyMap<MemoryId, number>,
      expectedMemoryVersions?: ReadonlyMap<MemoryId, number>,
      expectedAcceptedIds?: ReadonlySet<MemoryId>,
    ): void => {
      withSidecarHardening(opts, () => {
        replaceAllEmbeddingRowsAtomically(
          db,
          opts,
          pairs,
          expectedSnapshot,
          expectedMemoryVersions,
          expectedAcceptedIds,
        );
      });
    },
    listEmbeddedMemoryIds: (): readonly MemoryId[] => {
      const rows = db.prepare("SELECT memory_id FROM memory_embeddings").all() as {
        readonly memory_id: string;
      }[];
      return rows.map((row) => row.memory_id as MemoryId);
    },
    snapshotEmbeddedMemoryIds: (): ReadonlyMap<MemoryId, number> =>
      snapshotEmbeddedMemoryIdsFromDb(db),
    getEmbedding: (memoryId: MemoryId): MemoryEmbeddingRow | undefined =>
      getEmbeddingRow(db, memoryId, opts.cipher),
    getEmbeddings: (memoryIds: readonly MemoryId[]): ReadonlyMap<MemoryId, MemoryEmbeddingRow> =>
      getEmbeddingRows(db, memoryIds, opts.cipher),
  };
}

function upsertSingleEmbedding(
  db: DatabaseSync,
  opts: ResolvedOptions,
  memoryId: MemoryId,
  embedding: MemoryEmbeddingInput,
): void {
  withSidecarHardening(opts, () => {
    gateEmbeddingInput(embedding);
    if (getMemoryRow(db, memoryId, opts.cipher) === undefined) {
      throw new MemoryStorageError("not-found", "Memory not found.");
    }
    upsertEmbeddingRow(db, memoryId, embedding, opts.now(), opts.cipher);
    opts.emit({
      kind: "embedding:upserted",
      memoryId,
      provider: embedding.provider,
      modelId: embedding.modelId,
    });
  });
}

function deleteSingleEmbedding(db: DatabaseSync, opts: ResolvedOptions, memoryId: MemoryId): void {
  withSidecarHardening(opts, () => {
    if (getMemoryRow(db, memoryId, opts.cipher) === undefined) {
      throw new MemoryStorageError("not-found", "Memory not found.");
    }
    if (deleteEmbeddingRow(db, memoryId)) {
      opts.emit({ kind: "embedding:deleted", memoryId });
    }
  });
}

function buildEdgeAndEmbeddingOps(db: DatabaseSync, opts: ResolvedOptions): EdgeAndEmbeddingOps {
  return {
    ...buildEdgeOps(db, opts),
    ...buildEmbeddingOps(db, opts),
  };
}

function buildTombstoneAndAccessOps(
  db: DatabaseSync,
  opts: ResolvedOptions,
): TombstoneAndAccessOps {
  return {
    listTombstonesByScope: (scope: MemoryScope): readonly MemoryTombstone[] => {
      gateMemoryScope(scope);
      return listTombstonesByScopeRows(db, scope, opts.cipher);
    },
    listTombstonesPage: (scopes, limit, after): MemoryTombstonePage =>
      validatedTombstonePage(db, opts, scopes, limit, after),
    hasForgetTombstoneForBody: (scope: MemoryScope, body: string): boolean => {
      gateMemoryScope(scope);
      const currentHash = opts.bodySuppressionHash(body);
      const legacyHash = memoryBodySuppressionHash(body);
      // GEN-PERF-PERSISTENCE-014 — presence-only check keyed on body_hash; never decrypts the sealed
      // reason column. Same suppression decision as scanning + decrypting every tombstone, but O(1)
      // rows and zero reason decrypts (strengthens confidentiality on this hot path).
      const presence = selectForgetSuppressionBodyHashPresence(db, scope, currentHash, legacyHash);
      if (presence.current) return true;
      if (!presence.legacy) return false;
      withSidecarHardening(opts, () => {
        updateTombstoneBodyHashByScopeRows(db, scope, legacyHash, currentHash);
      });
      return true;
    },
    hasSemanticallySimilarForgetTombstone: (scope, candidate, threshold): boolean => {
      gateMemoryScope(scope);
      return hasSemanticallySimilarForgetTombstoneRow(db, scope, opts.cipher, candidate, threshold);
    },
    purgeTombstonesByScopeBefore: (scope: MemoryScope, forgottenBeforeMs: number): number => {
      return withSidecarHardening(opts, () => {
        gateMemoryScope(scope);
        return deleteTombstonesByScopeBeforeRows(db, scope, forgottenBeforeMs);
      });
    },
    recordAccess: (ids: readonly MemoryId[], nowMs: number): void => {
      withSidecarHardening(opts, () => {
        recordAccessRows(db, ids, nowMs);
      });
    },
    recordOutcome: (ids: readonly MemoryId[], utility: number, nowMs: number): void => {
      withSidecarHardening(opts, () => {
        recordOutcomeRows(db, ids, utility, nowMs);
      });
    },
    getAccessStats: (ids?: readonly MemoryId[]): ReadonlyMap<MemoryId, MemoryAccessStat> =>
      getAccessStatsRows(db, ids),
  };
}

function buildStore(db: DatabaseSync, opts: ResolvedOptions): MemoryVaultStore {
  return {
    ...buildMemoryMutators(db, opts),
    ...buildEdgeAndEmbeddingOps(db, opts),
    ...buildTombstoneAndAccessOps(db, opts),
    close: (): void => {
      db.close();
    },
  };
}

// `logSink`/`securityLogSink` are intentionally not on `MemoryVaultFactoryOptions` itself: an
// intersection at the factory's own call boundary is enough for full external usability, since a
// re-export preserves the exact function type TypeScript infers here, and object-literal
// assignability at a call site is checked structurally rather than by the type's name being
// importable — the same property that lets a bare `ServerLogSink` object literal satisfy either
// seam with no adapter (see `log-port.ts`/`vault-log.ts`).
export type CreateMemoryVaultOptions = MemoryVaultFactoryOptions & {
  /**
   * Optional activity-log seam (ADR-0019; see `vault-log.ts`). When wired, vault-open records the
   * retained key-resolution tier on `memory-vault.store.opened`, and a corruption recovery emits
   * `memory-vault.store.quarantined`. Omitted or `undefined` keeps the vault exactly as silent as
   * before this change.
   */
  readonly logSink?: MemoryVaultLogSink;
  /**
   * Optional activity-log seam for the shared macOS Keychain tier (ADR-0019, Wave 4a epic #3233
   * §8; see `@oscharko-dev/keiko-security/log-port.ts` and `cipher.ts`'s `keyFromKeychain`). When
   * wired, a keychain spawn that falls through to the keyfile tier emits one
   * `security.keychain.fallback` event on this sink instead of failing silently. A `ServerLogSink`
   * (`processServerLogSink()`) is structurally assignable here with no adapter, mirroring `logSink`
   * above. Omitted or `undefined` keeps the keychain tier exactly as silent as before this change.
   */
  readonly securityLogSink?: SecurityLogSink;
};

export function createMemoryVault(options?: CreateMemoryVaultOptions): MemoryVaultStore {
  const env = options?.env ?? defaultEnv();
  const dbPath = resolveMemoryDbPath(options?.memoryDir, env);
  const { cipher, keySource } = resolveCipherWithSource(options, env, options?.securityLogSink);
  const elapsedMs = startMemoryVaultLogTimer();
  const db = openMemoryDatabase(dbPath, cipher, options?.logSink);
  // Emitted only after BOTH remaining initialization steps succeed (Finding: store-open ordering)
  // — a body-suppression-key failure or a sidecar-hardening failure must fail `createMemoryVault`
  // without the activity log ever reporting the open as having succeeded. Emitting right after
  // `openMemoryDatabase` (as this line used to) reported a successful open even when either
  // operation below then threw and the vault never actually became usable.
  const bodySuppressionKey = resolveBodySuppressionKey(db, cipher);
  hardenVaultSidecars(dbPath);
  emitVaultOpened(options?.logSink, keySource, elapsedMs());
  return buildStore(db, resolveOptions(options, cipher, dbPath, bodySuppressionKey));
}
