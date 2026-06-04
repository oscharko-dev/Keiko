// Public type contracts for the Local Knowledge Connector surface (Epic #189, Issue #191).
// Pure types and pure validators only — no IO, no clock reads, no hashing, no randomness, no
// filesystem access. Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*`
// imports may appear in this module. The schemaVersion discriminant follows the same
// evolution rule as CONNECTED_CONTEXT_SCHEMA_VERSION (ADR-0010 D2): a breaking change
// introduces a NEW literal member rather than mutating "1".
//
// Foundry IQ composition (issue #191): KnowledgeSource, KnowledgeCapsule, and CapsuleSet are
// modelled as three separate concepts. Every document-derived record (DocumentRecord,
// ChunkRecord, VectorRecord, CitationReference, RetrievalReference) carries explicit
// capsuleId + sourceId + documentId lineage so a single global knowledge pool is
// unrepresentable in the type system.
//
// Browser safety: `ChunkRecord` carries `safeExcerptHash`, not raw extracted text, so the
// contract surface remains safe to send to a browser surface without re-redaction. Raw
// content lives only inside the local-knowledge runtime, never on the wire.

// ─── Schema version ───────────────────────────────────────────────────────────
export const LOCAL_KNOWLEDGE_SCHEMA_VERSION = "1" as const;

// ─── Branded IDs ──────────────────────────────────────────────────────────────
// Nominal branding via a phantom `unique symbol` property so `KnowledgeCapsuleId` is not
// assignable to a bare `string` without an explicit construction step. The brand carrier
// never lands at runtime — only the compiler reads it — so the values survive JSON
// serialization round-trips intact.
declare const KnowledgeCapsuleIdBrand: unique symbol;
declare const KnowledgeSourceIdBrand: unique symbol;
declare const CapsuleSetIdBrand: unique symbol;
declare const DocumentIdBrand: unique symbol;
declare const ChunkIdBrand: unique symbol;
declare const VectorIdBrand: unique symbol;

export type KnowledgeCapsuleId = string & { readonly [KnowledgeCapsuleIdBrand]: true };
export type KnowledgeSourceId = string & { readonly [KnowledgeSourceIdBrand]: true };
export type CapsuleSetId = string & { readonly [CapsuleSetIdBrand]: true };
export type DocumentId = string & { readonly [DocumentIdBrand]: true };
export type ChunkId = string & { readonly [ChunkIdBrand]: true };
export type VectorId = string & { readonly [VectorIdBrand]: true };

// ─── Embedding model + parser identity ────────────────────────────────────────
export type EmbeddingVectorMetric = "cosine" | "euclidean" | "dot";

export const EMBEDDING_VECTOR_METRICS: readonly EmbeddingVectorMetric[] = [
  "cosine",
  "euclidean",
  "dot",
] as const;

export interface EmbeddingModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly vectorDimensions: number;
  readonly vectorMetric: EmbeddingVectorMetric;
  readonly modelRevision?: string;
}

export interface ParserIdentity {
  readonly parserId: string;
  readonly parserVersion: string;
}

// ─── Knowledge source ─────────────────────────────────────────────────────────
export type KnowledgeSourceScope =
  | {
      readonly kind: "folder";
      readonly rootPath: string;
      readonly recursive: boolean;
      readonly includeGlobs?: readonly string[];
      readonly excludeGlobs?: readonly string[];
    }
  | {
      readonly kind: "repository";
      readonly repositoryRoot: string;
      readonly includeGlobs?: readonly string[];
      readonly excludeGlobs?: readonly string[];
    }
  | {
      readonly kind: "files";
      readonly rootPath: string;
      readonly files: readonly string[];
    };

export type KnowledgeSourceScopeKind = KnowledgeSourceScope["kind"];

export const KNOWLEDGE_SOURCE_SCOPE_KINDS: readonly KnowledgeSourceScopeKind[] = [
  "folder",
  "repository",
  "files",
] as const;

export interface KnowledgeSource {
  readonly id: KnowledgeSourceId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly scope: KnowledgeSourceScope;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── Capsule enums ────────────────────────────────────────────────────────────
export type CapsuleLifecycleState = "draft" | "indexing" | "ready" | "stale" | "deleting" | "error";

export const CAPSULE_LIFECYCLE_STATES: readonly CapsuleLifecycleState[] = [
  "draft",
  "indexing",
  "ready",
  "stale",
  "deleting",
  "error",
] as const;

export type CapsuleRetrievalEffort = "minimal" | "default" | "deep";

export const CAPSULE_RETRIEVAL_EFFORTS: readonly CapsuleRetrievalEffort[] = [
  "minimal",
  "default",
  "deep",
] as const;

export type CapsuleOutputMode = "answers" | "snippets" | "raw";

export const CAPSULE_OUTPUT_MODES: readonly CapsuleOutputMode[] = [
  "answers",
  "snippets",
  "raw",
] as const;

export type CapsuleAnswerGroundingPolicy =
  | "require-citations"
  | "require-citations-or-state-no-evidence"
  | "best-effort";

export const CAPSULE_ANSWER_GROUNDING_POLICIES: readonly CapsuleAnswerGroundingPolicy[] = [
  "require-citations",
  "require-citations-or-state-no-evidence",
  "best-effort",
] as const;

// ─── Knowledge capsule + set ──────────────────────────────────────────────────
export interface KnowledgeCapsule {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly sourceRoutingInstructions?: string;
  readonly alwaysQuery?: boolean;
  readonly retrievalEffort: CapsuleRetrievalEffort;
  readonly outputMode: CapsuleOutputMode;
  readonly answerGroundingPolicy: CapsuleAnswerGroundingPolicy;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly lifecycleState: CapsuleLifecycleState;
  // Path relative to the runtime-state directory; never absolute and never containing `..`.
  // The validator enforces this so storage references cannot escape the local-state root.
  readonly storageReference: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// CapsuleSet is a LOGICAL composition over multiple capsules. It deliberately holds only
// capsule IDs — no vectors, no chunks, no documents — so composition cannot accidentally
// duplicate vector data (Foundry IQ "no global pool" invariant).
export interface CapsuleSet {
  readonly id: CapsuleSetId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly composedAt: number;
}

// ─── Connector graph ──────────────────────────────────────────────────────────
export type ConnectorNodeKind = "files-window" | "local-knowledge" | "conversation-center";

export const CONNECTOR_NODE_KINDS: readonly ConnectorNodeKind[] = [
  "files-window",
  "local-knowledge",
  "conversation-center",
] as const;

export type LocalKnowledgeNodeTarget =
  | { readonly kind: "capsule"; readonly capsuleId: KnowledgeCapsuleId }
  | { readonly kind: "capsule-set"; readonly capsuleSetId: CapsuleSetId };

export type ConnectorNode =
  | {
      readonly kind: "files-window";
      readonly nodeId: string;
      readonly scope: KnowledgeSourceScope;
    }
  | {
      readonly kind: "local-knowledge";
      readonly nodeId: string;
      readonly target: LocalKnowledgeNodeTarget;
    }
  | {
      readonly kind: "conversation-center";
      readonly nodeId: string;
      readonly conversationId: string;
      readonly route: string;
    };

export interface ConnectorNodeRef {
  readonly nodeId: string;
  readonly kind: ConnectorNodeKind;
}

export interface ConnectorEdge {
  readonly from: ConnectorNodeRef;
  readonly to: ConnectorNodeRef;
  readonly createdAt: number;
}

export interface ConnectorGraphState {
  readonly schemaVersion: typeof LOCAL_KNOWLEDGE_SCHEMA_VERSION;
  readonly nodes: readonly ConnectorNode[];
  readonly edges: readonly ConnectorEdge[];
  readonly updatedAt: number;
}

