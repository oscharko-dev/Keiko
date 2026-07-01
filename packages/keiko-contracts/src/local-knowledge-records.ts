// Document-derived record contracts for the Local Knowledge Connector (Epic #189, Issue
// #191). Split from `local-knowledge.ts` to keep each file under the 400-LOC budget. Every
// record carries explicit capsuleId + sourceId + documentId lineage where applicable so a
// single global knowledge pool is unrepresentable (Foundry IQ invariant).

import type {
  CapsuleLifecycleState,
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParserIdentity,
  VectorId,
} from "./local-knowledge.js";

// ─── Document, page, section, parsed unit ─────────────────────────────────────
export type DocumentStatus =
  "pending" | "extracted" | "extracted-image" | "skipped" | "failed" | "unsupported";

export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  "pending",
  "extracted",
  "extracted-image",
  "skipped",
  "failed",
  "unsupported",
] as const;

export interface DocumentRecord {
  readonly id: DocumentId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  // Path relative to the owning source's scope root. Validators reject `..`, NUL, tilde,
  // and absolute prefixes when this contract is exchanged through the local-knowledge
  // boundary (see issue #194 indexer for the enforcement site).
  readonly documentPath: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  // Hex-only content hash (e.g. SHA-256 digest). Validators enforce hex-only — never raw
  // text — so the contract carries no document body across the wire.
  readonly contentHash: string;
  readonly parser: ParserIdentity;
  readonly lastExtractedAt: number;
  readonly status: DocumentStatus;
  readonly safeDisplayName: string;
}

export interface PageBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PageRecord {
  readonly documentId: DocumentId;
  readonly pageNumber: number;
  readonly pageLabel?: string;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly boundingBox?: PageBoundingBox;
}

export interface SectionRecord {
  readonly documentId: DocumentId;
  // Hierarchical path through the section tree, e.g. ["Chapter 1", "1.2 Risk Controls"].
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
}

export type ParsedUnit =
  | {
      readonly kind: "page";
      readonly documentId: DocumentId;
      readonly pageNumber: number;
      readonly pageLabel?: string;
      readonly characterStart: number;
      readonly characterEnd: number;
    }
  | {
      readonly kind: "section";
      readonly documentId: DocumentId;
      readonly sectionPath: readonly string[];
      readonly characterStart: number;
      readonly characterEnd: number;
    }
  | {
      readonly kind: "json-path";
      readonly documentId: DocumentId;
      readonly jsonPointer: string;
      readonly characterStart: number;
      readonly characterEnd: number;
    }
  | {
      readonly kind: "csv-row";
      readonly documentId: DocumentId;
      readonly tableName: string;
      readonly rowIndex: number;
      readonly characterStart: number;
      readonly characterEnd: number;
    }
  | {
      readonly kind: "html-block";
      readonly documentId: DocumentId;
      readonly headingPath?: readonly string[];
      readonly characterStart: number;
      readonly characterEnd: number;
    }
  | {
      readonly kind: "unsupported-media";
      readonly documentId: DocumentId;
      readonly reason: string;
    };

export type ParsedUnitKind = ParsedUnit["kind"];

export const PARSED_UNIT_KINDS: readonly ParsedUnitKind[] = [
  "page",
  "section",
  "json-path",
  "csv-row",
  "html-block",
  "unsupported-media",
] as const;

// ─── Chunk + vector ───────────────────────────────────────────────────────────
export interface ChunkRecord {
  readonly id: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly parsedUnit: ParsedUnit;
  readonly orderIndex: number;
  readonly tokenCount: number;
  // Hash of the excerpt text (e.g. SHA-256 hex). Raw text is intentionally absent from the
  // contract surface — browser surfaces can render a chunk's citation safely without
  // pulling the body across the trust boundary.
  readonly safeExcerptHash: string;
}

export interface VectorRecord {
  readonly id: VectorId;
  readonly chunkId: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly embeddingIdentity: EmbeddingModelIdentity;
  readonly vectorDimensions: number;
  // Opaque store identifier (e.g. SQLite rowid, vector-store handle). Validators do not
  // interpret this beyond rejecting empty/NUL strings.
  readonly storageReference: string;
  readonly createdAt: number;
}

// ─── Citation + retrieval reference ───────────────────────────────────────────
export interface CitationReference {
  readonly documentId: DocumentId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly chunkId: ChunkId;
  readonly pageNumber?: number;
  readonly pageLabel?: string;
  readonly sectionPath?: readonly string[];
  readonly jsonPointer?: string;
  readonly tableName?: string;
  readonly rowIndex?: number;
  readonly characterStart?: number;
  readonly characterEnd?: number;
  readonly safeDisplayName: string;
}

export interface RetrievalReference {
  readonly chunkId: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly score: number;
  readonly citation: CitationReference;
}

// ─── Parser result + diagnostics ──────────────────────────────────────────────
export type ParserDiagnosticSeverity = "info" | "warning" | "error";

export const PARSER_DIAGNOSTIC_SEVERITIES: readonly ParserDiagnosticSeverity[] = [
  "info",
  "warning",
  "error",
] as const;

export interface ParserDiagnostic {
  readonly severity: ParserDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly documentId?: DocumentId;
  readonly pageNumber?: number;
}

export interface ParserResult {
  readonly documentId: DocumentId;
  readonly parser: ParserIdentity;
  readonly pages: readonly PageRecord[];
  readonly sections: readonly SectionRecord[];
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly extractedAt: number;
}

// ─── Indexing job ─────────────────────────────────────────────────────────────
export type IndexingJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const INDEXING_JOB_STATUSES: readonly IndexingJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

// `resume` continues interrupted large-document jobs from durable extraction checkpoints
// where the source, parser, policy, chunking strategy, and embedding identity remain
// compatible; incompatible checkpoints are refused and that document restarts cleanly
// (Epic #1160, Issue #1286).
export type CapsuleReindexMode =
  | "changed-files"
  | "repair-failed"
  | "resume"
  | "full-reembed"
  | "full-rebuild";

export const CAPSULE_REINDEX_MODES: readonly CapsuleReindexMode[] = [
  "changed-files",
  "repair-failed",
  "resume",
  "full-reembed",
  "full-rebuild",
] as const;

export interface CapsuleReindexRequest {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly mode?: CapsuleReindexMode;
  readonly force?: boolean;
}

export interface IndexingJobError {
  readonly code: string;
  readonly message: string;
}

export interface IndexingJobRecord {
  readonly id: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly status: IndexingJobStatus;
  readonly totalDocuments: number;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly lastError?: IndexingJobError;
  // Bounded large-document ingestion (Epic #1160, Issue #1286). Optional and content-free:
  // counts of documents that took the progressive large-document path, that completed with
  // partial coverage, and that hold a resumable checkpoint. Absent on jobs that predate the
  // large-document path so existing consumers stay backward-compatible.
  readonly largeDocumentCount?: number;
  readonly partialCoverageDocuments?: number;
  readonly resumableDocuments?: number;
}

export type CapsuleEmbeddingCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export type CapsuleEmbeddingCompatibilityReason =
  | "current-model-matches-pinned"
  | "gateway-config-missing"
  | "no-current-embedding-model"
  | "pinned-model-not-configured"
  | "configured-model-not-embedding"
  | "gateway-provider-mismatch";

export interface CapsuleEmbeddingCompatibility {
  readonly status: CapsuleEmbeddingCompatibilityStatus;
  readonly reason: CapsuleEmbeddingCompatibilityReason;
  readonly pinnedModelId: string;
  readonly pinnedProvider: string;
  readonly pinnedVectorDimensions: number;
  readonly pinnedVectorMetric: EmbeddingVectorMetric;
  readonly currentModelId?: string;
  readonly currentProvider?: string;
  readonly message: string;
}

export type CapsuleContextualRetrievalHealthSource = "capsule" | "env" | "default";

export type CapsuleContextualRetrievalHealthStatus =
  | "disabled"
  | "ready"
  | "rebuild-required"
  | "degraded"
  | "unavailable";

export interface CapsuleContextualRetrievalHealth {
  readonly enabled: boolean;
  readonly source: CapsuleContextualRetrievalHealthSource;
  readonly status: CapsuleContextualRetrievalHealthStatus;
  readonly strict: boolean;
  readonly rebuildRequired: boolean;
  readonly staleChunkCount: number;
  readonly degradedChunkCount: number;
  readonly modelId?: string;
  readonly maxContextChars?: number;
  readonly documentContextMaxChars?: number;
  readonly message: string;
}

// ─── Capsule health + delete ──────────────────────────────────────────────────
export interface CapsuleHealth {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly lifecycleState: CapsuleLifecycleState;
  readonly storageSizeBytes: number;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
  readonly lastIndexedAt?: number;
  readonly embeddingIdentity: EmbeddingModelIdentity;
  // False when the active embedding model identity differs from the capsule's pinned
  // identity (provider, modelId, vectorDimensions, vectorMetric). Downstream surfaces
  // treat `vectorCompatible: false` as a "stale" signal requiring reindex.
  readonly vectorCompatible: boolean;
  readonly embeddingCompatibility?: CapsuleEmbeddingCompatibility;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly unsupportedDocuments: number;
  readonly unsupportedGuidance: readonly string[];
  readonly staleReasons: readonly string[];
  readonly contextualRetrieval?: CapsuleContextualRetrievalHealth;
  // Bounded large-document ingestion (Epic #1160, Issue #1286). Optional and content-free.
  // `partialCoverageDocuments` counts documents indexed with explicit quality limits (e.g.
  // missing OCR/multimodal capability); `qualityWarnings` are browser-safe summaries that
  // describe retrieval-quality limits without implying pipeline instability;
  // `resumableDocuments` counts documents that hold a durable, compatible resume checkpoint.
  readonly partialCoverageDocuments?: number;
  readonly qualityWarnings?: readonly string[];
  readonly resumableDocuments?: number;
}

// Sources point at user-owned files that live OUTSIDE Keiko's local state. Deleting them
// would destroy user data. The contract pins `deleteSources` to the literal `false` so
// any caller attempting `deleteSources: true` fails type-checking; the index can still be
// dropped via `deleteIndex: true`.
export interface CapsuleDeleteRequest {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly deleteIndex: boolean;
  readonly deleteSources: false;
}
