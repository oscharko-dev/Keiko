// Document-derived record contracts for the Local Knowledge Connector (Epic #189, Issue
// #191). Split from `local-knowledge.ts` to keep each file under the 400-LOC budget. Every
// record carries explicit capsuleId + sourceId + documentId lineage where applicable so a
// single global knowledge pool is unrepresentable (Foundry IQ invariant).

import type {
  CapsuleLifecycleState,
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParserIdentity,
  VectorId,
} from "./local-knowledge.js";

// ─── Document, page, section, parsed unit ─────────────────────────────────────
export type DocumentStatus = "pending" | "extracted" | "skipped" | "failed" | "unsupported";

export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  "pending",
  "extracted",
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
}

// ─── Capsule health + delete ──────────────────────────────────────────────────
export interface CapsuleHealth {
  readonly capsuleId: KnowledgeCapsuleId;
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
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly staleReasons: readonly string[];
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
