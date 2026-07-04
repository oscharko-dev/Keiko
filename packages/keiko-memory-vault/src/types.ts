// Public port + supporting types for the memory vault. Package-local types (tombstone, embedding
// I/O, event union) live here so downstream packages compose them through the barrel without
// having to know the SQLite encoding.

import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
  MemoryValidityInterval,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryContentCipher } from "./cipher.js";
import type { MemoryAccessStat } from "./access.js";

export type { MemoryAccessStat } from "./access.js";

export type MemoryEmbeddingMetric = "cosine" | "euclidean" | "dot";

export interface MemoryEmbeddingInput {
  readonly provider: string;
  readonly modelId: string;
  readonly modelRevision?: string;
  readonly metric: MemoryEmbeddingMetric;
  readonly vector: Float32Array;
}

export interface MemoryEmbeddingRow {
  readonly memoryId: MemoryId;
  readonly provider: string;
  readonly modelId: string;
  readonly modelRevision?: string;
  readonly dimensions: number;
  readonly metric: MemoryEmbeddingMetric;
  readonly vector: Float32Array;
  readonly createdAt: number;
}

export interface MemoryTombstone {
  readonly id: string;
  readonly memoryId: MemoryId;
  readonly scopeKind: MemoryScopeKind;
  readonly scopeCoordinate: string;
  readonly type: MemoryType;
  readonly forgottenAt: number;
  readonly forgetterSurface: string;
  readonly bodyHash?: string;
  readonly reviewerId?: MemoryReviewerId;
  readonly originalStatus?: MemoryStatus;
  readonly reason?: string;
}

export interface MemoryMetadata {
  readonly id: MemoryId;
  readonly schemaVersion: "1";
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly sensitivity: MemorySensitivity;
  readonly pinned: boolean;
  readonly confidence: number;
  readonly validity: MemoryValidityInterval;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// Mutating-call event union for the optional onMemoryEvent callback. #214 wires the audit ledger
// here later; #206 only forwards the event after a successful commit.
export type MemoryEvent =
  | { readonly kind: "memory:inserted"; readonly record: MemoryRecord }
  | { readonly kind: "memory:updated"; readonly record: MemoryRecord }
  | {
      readonly kind: "memory:deleted";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
      readonly tombstoned: boolean;
    }
  | { readonly kind: "memory:tombstoned"; readonly tombstone: MemoryTombstone }
  | { readonly kind: "edge:inserted"; readonly edge: MemoryEdge }
  | { readonly kind: "edge:deleted"; readonly edgeId: MemoryEdgeId }
  | {
      readonly kind: "embedding:upserted";
      readonly memoryId: MemoryId;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly kind: "embedding:deleted"; readonly memoryId: MemoryId };

export type MemoryUpdatePatch = Partial<
  Omit<MemoryRecord, "id" | "schemaVersion" | "scope" | "createdAt">
>;

export interface MemoryBatchUpdate {
  readonly id: MemoryId;
  readonly patch: MemoryUpdatePatch;
  readonly nowMs: number;
}

export interface MemoryBatchDelete {
  readonly id: MemoryId;
  readonly options: DeleteMemoryOptions;
}

export interface MemoryDeleteResult {
  readonly memoryId: MemoryId;
  readonly scope: MemoryScope;
  readonly tombstone: MemoryTombstone | undefined;
}

export interface ListMemoriesOptions {
  readonly type?: readonly MemoryType[];
  readonly status?: readonly MemoryStatus[];
  readonly pinned?: boolean;
  readonly includeExpired?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "createdAt" | "updatedAt" | "validFrom";
  readonly orderDir?: "asc" | "desc";
  // For includeExpired === false the vault uses the deterministic `now()` from the factory; this
  // override only exists so a caller can pin "expired relative to T" without mutating the clock.
  readonly nowMs?: number;
}

export interface DeleteMemoryOptions {
  readonly tombstone: boolean;
  readonly forgetterSurface: string;
  readonly reviewerId?: MemoryReviewerId;
  readonly reason?: string;
  readonly nowMs: number;
}

export interface MemoryVaultStore {
  readonly insertMemory: (record: MemoryRecord) => MemoryRecord;
  readonly updateMemory: (id: MemoryId, patch: MemoryUpdatePatch, nowMs: number) => MemoryRecord;
  readonly updateMemories: (updates: readonly MemoryBatchUpdate[]) => readonly MemoryRecord[];
  readonly getMemory: (id: MemoryId) => MemoryRecord | undefined;
  readonly deleteMemory: (id: MemoryId, options: DeleteMemoryOptions) => void;
  readonly deleteMemories: (deletes: readonly MemoryBatchDelete[]) => readonly MemoryDeleteResult[];
  readonly listMemoryScopes: () => readonly MemoryScope[];
  readonly listMemoriesAcrossScopes: (
    scopes: readonly MemoryScope[],
    options?: ListMemoriesOptions,
  ) => readonly MemoryRecord[];
  readonly listMemoriesByScope: (
    scope: MemoryScope,
    options?: ListMemoriesOptions,
  ) => readonly MemoryRecord[];
  readonly listMemoryMetadataByScope: (
    scope: MemoryScope,
    options?: ListMemoriesOptions,
  ) => readonly MemoryMetadata[];
  readonly insertEdge: (edge: MemoryEdge) => MemoryEdge;
  readonly listOutgoingEdges: (memoryId: MemoryId) => readonly MemoryEdge[];
  readonly listIncomingEdges: (memoryId: MemoryId) => readonly MemoryEdge[];
  readonly listEdgesForMemories: (
    memoryIds: readonly MemoryId[],
  ) => ReadonlyMap<MemoryId, readonly MemoryEdge[]>;
  readonly deleteEdge: (edgeId: MemoryEdgeId) => void;
  readonly upsertEmbedding: (memoryId: MemoryId, embedding: MemoryEmbeddingInput) => void;
  readonly deleteEmbedding: (memoryId: MemoryId) => void;
  readonly getEmbedding: (memoryId: MemoryId) => MemoryEmbeddingRow | undefined;
  readonly getEmbeddings: (
    memoryIds: readonly MemoryId[],
  ) => ReadonlyMap<MemoryId, MemoryEmbeddingRow>;
  readonly listTombstonesByScope: (scope: MemoryScope) => readonly MemoryTombstone[];
  readonly hasForgetTombstoneForBody: (scope: MemoryScope, body: string) => boolean;
  // Sealed embeddings of forgotten memories in this scope (GEN-AI-MEMORY-003, RB-4). Lets a capture
  // boundary suppress a semantic paraphrase of a forgotten fact — cosine-similar but a different
  // body_hash — without ever exposing the forgotten body text itself.
  readonly forgetTombstoneVectors: (scope: MemoryScope) => readonly Float32Array[];
  readonly purgeTombstonesByScopeBefore: (scope: MemoryScope, forgottenBeforeMs: number) => number;
  // Access tracking (#204). `recordAccess` upserts an insert-or-increment counter for each id
  // (a recall reflex from the retrieval surface); `getAccessStats` reads the counters back for the
  // maintenance planner. Both operate on the cleartext `memory_access` table — no content.
  readonly recordAccess: (ids: readonly MemoryId[], nowMs: number) => void;
  // Outcome tracking (#204, O-V1). `recordOutcome` appends a governed retention judgement (utility
  // in [0,1]) for each id — a proposal accepted (1) / rejected (0), a conflict won (1) / lost (0),
  // an accepted correction superseding its origin (0). It never advances the access counter or
  // timestamp; the maintenance planner folds the mean utility into effective strength so a
  // proven-useful memory resists disuse-forgetting and a proven-bad one fades sooner.
  readonly recordOutcome: (ids: readonly MemoryId[], utility: number, nowMs: number) => void;
  readonly getAccessStats: (ids?: readonly MemoryId[]) => ReadonlyMap<MemoryId, MemoryAccessStat>;
  readonly close: () => void;
}

export interface MemoryVaultFactoryOptions {
  readonly memoryDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly newTombstoneId?: () => string;
  readonly redactString?: (input: string) => string;
  readonly onMemoryEvent?: (event: MemoryEvent) => void;
  // Called inside the delete transaction after all SQL changes have been applied and before
  // COMMIT. This is intentionally delete-only: privacy-critical forget/delete audit can throw here
  // to roll back the memory mutation, while the public onMemoryEvent contract remains post-commit.
  readonly onDeleteEventsBeforeCommit?: (events: readonly MemoryEvent[]) => void;
  // Test-only injection seams for encryption-at-rest (ADR-0035). Production callers pass neither:
  // createMemoryVault resolves the key internally via resolveVaultKey. `cipher` overrides the whole
  // cipher; `vaultKey` supplies a deterministic 32-byte key without touching the keychain/keyfile.
  readonly cipher?: MemoryContentCipher;
  readonly vaultKey?: Buffer;
}
