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
import { randomUUID } from "node:crypto";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import { openMemoryDatabase } from "./db.js";
import { resolveMemoryDir, resolveMemoryDbPath } from "./paths.js";
import { createMemoryContentCipher, resolveVaultKey, type MemoryContentCipher } from "./cipher.js";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import {
  deleteMemoryRow,
  getMemoryRow,
  insertMemoryRow,
  listMemoriesRows,
  listMemoriesByScopeRows,
  updateMemoryRow,
} from "./memories.js";
import {
  deleteEdgeRow,
  insertEdgeRow,
  listIncomingEdgeRows,
  listOutgoingEdgeRows,
} from "./edges.js";
import { getEmbeddingRow, getEmbeddingRows, upsertEmbeddingRow } from "./embeddings.js";
import { getAccessStatsRows, recordAccessRows, type MemoryAccessStat } from "./access.js";
import {
  deleteTombstonesByScopeBeforeRows,
  insertTombstoneRow,
  listTombstonesByScopeRows,
} from "./tombstones.js";
import {
  gateDeleteOptions,
  gateEmbeddingInput,
  gateMemoryEdge,
  gateMemoryRecord,
  gateMemoryScope,
} from "./validate.js";
import { redactMemoryEdge, redactMemoryRecord, redactTombstone } from "./redact-record.js";
import { MemoryStorageError } from "./errors.js";
import type {
  MemoryBatchDelete,
  DeleteMemoryOptions,
  MemoryBatchUpdate,
  ListMemoriesOptions,
  MemoryDeleteResult,
  MemoryEmbeddingInput,
  MemoryEmbeddingRow,
  MemoryEvent,
  MemoryTombstone,
  MemoryUpdatePatch,
  MemoryVaultFactoryOptions,
  MemoryVaultStore,
} from "./types.js";

interface ResolvedOptions {
  readonly now: () => number;
  readonly newTombstoneId: () => string;
  readonly redactString: (input: string) => string;
  readonly emit: (event: MemoryEvent) => void;
  readonly cipher: MemoryContentCipher;
}

const IDENTITY: (s: string) => string = (s) => s;
const NOOP_EMIT: (e: MemoryEvent) => void = () => undefined;

// Single named entry point for the default environment read so the literal `process.env`
// reference does not appear inline in business logic (audit AC19).
function defaultEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

function resolveOptions(
  opts: MemoryVaultFactoryOptions | undefined,
  cipher: MemoryContentCipher,
): ResolvedOptions {
  return {
    now: opts?.now ?? ((): number => Date.now()),
    newTombstoneId: opts?.newTombstoneId ?? ((): string => randomUUID()),
    redactString: opts?.redactString ?? IDENTITY,
    emit: opts?.onMemoryEvent ?? NOOP_EMIT,
    cipher,
  };
}

// Resolve the content cipher. Precedence: an explicitly injected cipher (tests), then an injected
// raw key (tests/CI), then the real tiered resolver (KEIKO_MEMORY_KEY > keychain > keyfile). The
// public factory never requires any of these — production callers get the tiered resolver.
function resolveCipher(
  opts: MemoryVaultFactoryOptions | undefined,
  env: Readonly<Record<string, string | undefined>>,
): MemoryContentCipher {
  if (opts?.cipher !== undefined) return opts.cipher;
  if (opts?.vaultKey !== undefined) return createMemoryContentCipher(opts.vaultKey);
  const memoryDir = resolveMemoryDir(opts?.memoryDir, env);
  return createMemoryContentCipher(resolveVaultKey(env, memoryDir).key);
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
  const next: MemoryRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    schemaVersion: existing.schemaVersion,
    scope: existing.scope,
    createdAt: existing.createdAt,
    updatedAt: nowMs,
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
  const base = {
    id: opts.newTombstoneId(),
    memoryId: record.id,
    scopeKind: scopeKindOf(record.scope),
    scopeCoordinate: scopeCoordinateOf(record.scope),
    type: record.type,
    forgottenAt: options.nowMs,
    forgetterSurface: options.forgetterSurface,
    originalStatus: record.status,
  };
  return {
    ...base,
    ...(options.reviewerId === undefined ? {} : { reviewerId: options.reviewerId }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
}

type MemoryMutators = Pick<
  MemoryVaultStore,
  | "insertMemory"
  | "updateMemory"
  | "updateMemories"
  | "deleteMemory"
  | "deleteMemories"
  | "getMemory"
  | "listMemories"
  | "listMemoriesByScope"
>;

function prepareDelete(
  db: DatabaseSync,
  id: MemoryId,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): MemoryDeleteResult {
  gateDeleteOptions(options);
  const existing = existingMemoryOrThrow(db, id, opts.cipher);
  const tombstone = options.tombstone
    ? redactTombstone(buildTombstone(existing, options, opts), opts.redactString)
    : undefined;
  return { memoryId: id, scope: existing.scope, tombstone };
}

function applyPreparedDelete(
  db: DatabaseSync,
  result: MemoryDeleteResult,
  opts: ResolvedOptions,
): void {
  if (!deleteMemoryRow(db, result.memoryId)) {
    throw new MemoryStorageError("not-found", "Memory not found.");
  }
  if (result.tombstone !== undefined) {
    insertTombstoneRow(db, result.tombstone, opts.cipher);
  }
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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready;
}

function runBatchDeleteMemories(
  db: DatabaseSync,
  deletes: readonly MemoryBatchDelete[],
  opts: ResolvedOptions,
): readonly MemoryDeleteResult[] {
  const ready = deletes.map((entry) => prepareDelete(db, entry.id, entry.options, opts));
  db.exec("BEGIN");
  try {
    for (const result of ready) {
      applyPreparedDelete(db, result, opts);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready;
}

function updateMemoryInPlace(
  db: DatabaseSync,
  update: MemoryBatchUpdate,
  opts: ResolvedOptions,
): MemoryRecord {
  const existing = existingMemoryOrThrow(db, update.id, opts.cipher);
  const merged = mergePatch(existing, update.patch, update.nowMs);
  const ready = preparedForWrite(merged, opts);
  updateMemoryRow(db, ready, opts.cipher);
  return ready;
}

function runBatchUpdateMemories(
  db: DatabaseSync,
  updates: readonly MemoryBatchUpdate[],
  opts: ResolvedOptions,
): readonly MemoryRecord[] {
  const ready: MemoryRecord[] = [];
  db.exec("BEGIN");
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
  for (const result of results) {
    opts.emit({
      kind: "memory:deleted",
      memoryId: result.memoryId,
      scope: result.scope,
      tombstoned: result.tombstone !== undefined,
    });
    if (result.tombstone !== undefined) {
      opts.emit({ kind: "memory:tombstoned", tombstone: result.tombstone });
    }
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

function buildMemoryMutators(db: DatabaseSync, opts: ResolvedOptions): MemoryMutators {
  return {
    insertMemory: (record: MemoryRecord): MemoryRecord => {
      const ready = preparedForWrite(record, opts);
      insertMemoryRow(db, ready, opts.cipher);
      opts.emit({ kind: "memory:inserted", record: ready });
      return ready;
    },
    updateMemory: (id: MemoryId, patch: MemoryUpdatePatch, nowMs: number): MemoryRecord => {
      const ready = updateMemoryInPlace(db, { id, patch, nowMs }, opts);
      opts.emit({ kind: "memory:updated", record: ready });
      return ready;
    },
    updateMemories: (updates: readonly MemoryBatchUpdate[]): readonly MemoryRecord[] => {
      const ready = runBatchUpdateMemories(db, updates, opts);
      emitUpdatedRecords(ready, opts);
      return ready;
    },
    deleteMemory: (id: MemoryId, options: DeleteMemoryOptions): void => {
      deleteMemoryWithEvents(db, id, options, opts);
    },
    deleteMemories: (deletes: readonly MemoryBatchDelete[]): readonly MemoryDeleteResult[] => {
      const ready = runBatchDeleteMemories(db, deletes, opts);
      emitDeletedRecords(ready, opts);
      return ready;
    },
    getMemory: (id: MemoryId): MemoryRecord | undefined => getMemoryRow(db, id, opts.cipher),
    listMemories: (options?: ListMemoriesOptions): readonly MemoryRecord[] => {
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoriesRows(db, effective, nowMs, opts.cipher);
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
  };
}

type EdgeAndEmbeddingOps = Pick<
  MemoryVaultStore,
  | "insertEdge"
  | "listOutgoingEdges"
  | "listIncomingEdges"
  | "deleteEdge"
  | "upsertEmbedding"
  | "getEmbedding"
  | "getEmbeddings"
>;

type TombstoneAndAccessOps = Pick<
  MemoryVaultStore,
  "listTombstonesByScope" | "purgeTombstonesByScopeBefore" | "recordAccess" | "getAccessStats"
>;

function buildEdgeAndEmbeddingOps(db: DatabaseSync, opts: ResolvedOptions): EdgeAndEmbeddingOps {
  return {
    insertEdge: (edge: MemoryEdge): MemoryEdge => {
      const ready = preparedEdgeForWrite(edge, opts);
      insertEdgeRow(db, ready, opts.cipher);
      opts.emit({ kind: "edge:inserted", edge: ready });
      return ready;
    },
    listOutgoingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listOutgoingEdgeRows(db, memoryId, opts.cipher),
    listIncomingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listIncomingEdgeRows(db, memoryId, opts.cipher),
    deleteEdge: (edgeId: MemoryEdgeId): void => {
      const removed = deleteEdgeRow(db, edgeId);
      if (!removed) {
        throw new MemoryStorageError("not-found", "Edge not found.");
      }
      opts.emit({ kind: "edge:deleted", edgeId });
    },
    upsertEmbedding: (memoryId: MemoryId, embedding: MemoryEmbeddingInput): void => {
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
    },
    getEmbedding: (memoryId: MemoryId): MemoryEmbeddingRow | undefined =>
      getEmbeddingRow(db, memoryId, opts.cipher),
    getEmbeddings: (memoryIds: readonly MemoryId[]): ReadonlyMap<MemoryId, MemoryEmbeddingRow> =>
      getEmbeddingRows(db, memoryIds, opts.cipher),
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
    purgeTombstonesByScopeBefore: (scope: MemoryScope, forgottenBeforeMs: number): number => {
      gateMemoryScope(scope);
      return deleteTombstonesByScopeBeforeRows(db, scope, forgottenBeforeMs);
    },
    recordAccess: (ids: readonly MemoryId[], nowMs: number): void => {
      recordAccessRows(db, ids, nowMs);
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

export function createMemoryVault(options?: MemoryVaultFactoryOptions): MemoryVaultStore {
  const env = options?.env ?? defaultEnv();
  const dbPath = resolveMemoryDbPath(options?.memoryDir, env);
  const cipher = resolveCipher(options, env);
  const db = openMemoryDatabase(dbPath, cipher);
  return buildStore(db, resolveOptions(options, cipher));
}
