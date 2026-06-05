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
import { resolveMemoryDbPath } from "./paths.js";
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
import { getEmbeddingRow, upsertEmbeddingRow } from "./embeddings.js";
import { insertTombstoneRow, listTombstonesByScopeRows } from "./tombstones.js";
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
  DeleteMemoryOptions,
  ListMemoriesOptions,
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
}

const IDENTITY: (s: string) => string = (s) => s;
const NOOP_EMIT: (e: MemoryEvent) => void = () => undefined;

// Single named entry point for the default environment read so the literal `process.env`
// reference does not appear inline in business logic (audit AC19).
function defaultEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

function resolveOptions(opts: MemoryVaultFactoryOptions | undefined): ResolvedOptions {
  return {
    now: opts?.now ?? ((): number => Date.now()),
    newTombstoneId: opts?.newTombstoneId ?? ((): string => randomUUID()),
    redactString: opts?.redactString ?? IDENTITY,
    emit: opts?.onMemoryEvent ?? NOOP_EMIT,
  };
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

function existingMemoryOrThrow(db: DatabaseSync, id: MemoryId): MemoryRecord {
  const existing = getMemoryRow(db, id);
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
  };
  return options.reason === undefined ? base : { ...base, reason: options.reason };
}

function runDelete(
  db: DatabaseSync,
  id: MemoryId,
  options: DeleteMemoryOptions,
  opts: ResolvedOptions,
): { tombstone: MemoryTombstone | undefined } {
  const existing = getMemoryRow(db, id);
  if (existing === undefined) {
    throw new MemoryStorageError("not-found", "Memory not found.");
  }
  const tombstone = options.tombstone
    ? redactTombstone(buildTombstone(existing, options, opts), opts.redactString)
    : undefined;
  db.exec("BEGIN");
  try {
    deleteMemoryRow(db, id);
    if (tombstone !== undefined) {
      insertTombstoneRow(db, tombstone);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { tombstone };
}

type MemoryMutators = Pick<
  MemoryVaultStore,
  "insertMemory" | "updateMemory" | "deleteMemory" | "getMemory" | "listMemories" | "listMemoriesByScope"
>;

function buildMemoryMutators(db: DatabaseSync, opts: ResolvedOptions): MemoryMutators {
  return {
    insertMemory: (record: MemoryRecord): MemoryRecord => {
      const ready = preparedForWrite(record, opts);
      insertMemoryRow(db, ready);
      opts.emit({ kind: "memory:inserted", record: ready });
      return ready;
    },
    updateMemory: (id: MemoryId, patch: MemoryUpdatePatch, nowMs: number): MemoryRecord => {
      const existing = existingMemoryOrThrow(db, id);
      const merged = mergePatch(existing, patch, nowMs);
      const ready = preparedForWrite(merged, opts);
      updateMemoryRow(db, ready);
      opts.emit({ kind: "memory:updated", record: ready });
      return ready;
    },
    deleteMemory: (id: MemoryId, options: DeleteMemoryOptions): void => {
      gateDeleteOptions(options);
      const existing = existingMemoryOrThrow(db, id);
      const { tombstone } = runDelete(db, id, options, opts);
      opts.emit({
        kind: "memory:deleted",
        memoryId: id,
        scope: existing.scope,
        tombstoned: tombstone !== undefined,
      });
      if (tombstone !== undefined) {
        opts.emit({ kind: "memory:tombstoned", tombstone });
      }
    },
    getMemory: (id: MemoryId): MemoryRecord | undefined => getMemoryRow(db, id),
    listMemories: (options?: ListMemoriesOptions): readonly MemoryRecord[] => {
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoriesRows(db, effective, nowMs);
    },
    listMemoriesByScope: (
      scope: MemoryScope,
      options?: ListMemoriesOptions,
    ): readonly MemoryRecord[] => {
      gateMemoryScope(scope);
      const effective = options ?? {};
      const nowMs = effective.nowMs ?? opts.now();
      return listMemoriesByScopeRows(db, scope, effective, nowMs);
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
  | "listTombstonesByScope"
>;

function buildEdgeAndEmbeddingOps(db: DatabaseSync, opts: ResolvedOptions): EdgeAndEmbeddingOps {
  return {
    insertEdge: (edge: MemoryEdge): MemoryEdge => {
      const ready = preparedEdgeForWrite(edge, opts);
      insertEdgeRow(db, ready);
      opts.emit({ kind: "edge:inserted", edge: ready });
      return ready;
    },
    listOutgoingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listOutgoingEdgeRows(db, memoryId),
    listIncomingEdges: (memoryId: MemoryId): readonly MemoryEdge[] =>
      listIncomingEdgeRows(db, memoryId),
    deleteEdge: (edgeId: MemoryEdgeId): void => {
      const removed = deleteEdgeRow(db, edgeId);
      if (!removed) {
        throw new MemoryStorageError("not-found", "Edge not found.");
      }
      opts.emit({ kind: "edge:deleted", edgeId });
    },
    upsertEmbedding: (memoryId: MemoryId, embedding: MemoryEmbeddingInput): void => {
      gateEmbeddingInput(embedding);
      if (getMemoryRow(db, memoryId) === undefined) {
        throw new MemoryStorageError("not-found", "Memory not found.");
      }
      upsertEmbeddingRow(db, memoryId, embedding, opts.now());
      opts.emit({
        kind: "embedding:upserted",
        memoryId,
        provider: embedding.provider,
        modelId: embedding.modelId,
      });
    },
    getEmbedding: (memoryId: MemoryId): MemoryEmbeddingRow | undefined =>
      getEmbeddingRow(db, memoryId),
    listTombstonesByScope: (scope: MemoryScope): readonly MemoryTombstone[] => {
      gateMemoryScope(scope);
      return listTombstonesByScopeRows(db, scope);
    },
  };
}

function buildStore(db: DatabaseSync, opts: ResolvedOptions): MemoryVaultStore {
  return {
    ...buildMemoryMutators(db, opts),
    ...buildEdgeAndEmbeddingOps(db, opts),
    close: (): void => {
      db.close();
    },
  };
}

export function createMemoryVault(options?: MemoryVaultFactoryOptions): MemoryVaultStore {
  const env = options?.env ?? defaultEnv();
  const dbPath = resolveMemoryDbPath(options?.memoryDir, env);
  const db = openMemoryDatabase(dbPath);
  return buildStore(db, resolveOptions(options));
}
