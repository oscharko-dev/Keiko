import type { KnowledgeCapsule, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeStore,
  KnowledgeStoreKeyProvider,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { localKnowledgeProtectionOptions } from "./localKnowledgeKeyProvider.js";

export interface LocalKnowledgeRemediationScope {
  readonly capsules: number;
  readonly sources: number;
  readonly documents: number;
  readonly chunks: number;
  readonly vectors: number;
}

export interface StoreEnv {
  readonly store: KnowledgeStore;
  close(): void;
}

interface OpenRemediationStoreOptions {
  readonly runtimeStateDir?: string | undefined;
  readonly keyProvider?: KnowledgeStoreKeyProvider | undefined;
}

interface RunningJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly cancellation_requested: number;
}

function emptyScope(): LocalKnowledgeRemediationScope {
  return { capsules: 0, sources: 0, documents: 0, chunks: 0, vectors: 0 };
}

function addScope(
  left: LocalKnowledgeRemediationScope,
  right: LocalKnowledgeRemediationScope,
): LocalKnowledgeRemediationScope {
  return {
    capsules: left.capsules + right.capsules,
    sources: left.sources + right.sources,
    documents: left.documents + right.documents,
    chunks: left.chunks + right.chunks,
    vectors: left.vectors + right.vectors,
  };
}

function countForTable(
  store: KnowledgeStore,
  table: "documents" | "chunks" | "vectors",
  capsuleId: KnowledgeCapsuleId,
): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
    .get({ c: capsuleId }) as { readonly n: number };
  return row.n;
}

function scopeForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
): LocalKnowledgeRemediationScope {
  return {
    capsules: 1,
    sources: capsule.sourceIds.length,
    documents: countForTable(store, "documents", capsule.id),
    chunks: countForTable(store, "chunks", capsule.id),
    vectors: countForTable(store, "vectors", capsule.id),
  };
}

function recoverAbandonedIndexingJobs(store: KnowledgeStore): void {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, capsule_id, cancellation_requested",
        "FROM indexing_jobs",
        "WHERE status = 'running'",
        "ORDER BY started_at ASC, id ASC",
      ].join(" "),
    )
    .all() as unknown as readonly RunningJobRow[];
  const finishedAt = store._internal.now();
  for (const row of rows) {
    if (
      localKnowledgeIndexingRegistry.isActiveCapsule(row.capsule_id) ||
      localKnowledgeIndexingRegistry.isActiveJob(row.id)
    ) {
      continue;
    }
    const cancelled = row.cancellation_requested === 1;
    store._internal.db
      .prepare(
        [
          "UPDATE indexing_jobs SET",
          "  status = :status,",
          "  finished_at = :finished_at,",
          "  last_error_code = :error_code,",
          "  last_error_message = :error_message",
          "WHERE id = :id AND status = 'running'",
        ].join(" "),
      )
      .run({
        status: cancelled ? "cancelled" : "failed",
        finished_at: finishedAt,
        error_code: cancelled ? "CANCELLED" : "INDEXING_INTERRUPTED",
        error_message: cancelled
          ? "Indexing was cancelled before the run could be finalized."
          : "Indexing stopped unexpectedly before completion. Restart the run to finish indexing.",
        id: row.id,
      });
    try {
      updateCapsuleState(store, row.capsule_id as KnowledgeCapsuleId, "error");
    } catch {
      // The recovered job row is the durable signal; capsule state repair is best-effort.
    }
  }
}

export function openRemediationStore(options: OpenRemediationStoreOptions): StoreEnv {
  if (options.runtimeStateDir === undefined) {
    throw new Error("Local Knowledge runtime-state path is unavailable.");
  }
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: options.runtimeStateDir });
  const protection = localKnowledgeProtectionOptions(options.keyProvider);
  const store = openKnowledgeStore(protection === undefined ? { dbPath } : { dbPath, protection });
  recoverAbandonedIndexingJobs(store);
  return {
    store,
    close: (): void => {
      store.close();
    },
  };
}

export function inspectRemediationStore(store: KnowledgeStore): LocalKnowledgeRemediationScope {
  return listCapsules(store).reduce<LocalKnowledgeRemediationScope>(
    (acc, capsule) => addScope(acc, scopeForCapsule(store, capsule)),
    emptyScope(),
  );
}
