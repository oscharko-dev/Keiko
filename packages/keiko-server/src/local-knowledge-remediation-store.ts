import type { KnowledgeCapsule, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeStore,
  KnowledgeStoreKeyProvider,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import { recoverAbandonedIndexingJobs } from "./local-knowledge-store-open.js";
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
