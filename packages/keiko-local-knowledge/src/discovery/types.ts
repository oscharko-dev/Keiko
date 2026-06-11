// Discovery + extraction types for the Local Knowledge Connector (Epic #189, Issue #194).
// The discovery layer is the bridge between a `KnowledgeSource` and a `KnowledgeStore`:
// it walks files in scope via the workspace `WorkspaceFs` port, hands each file to the
// parser registry, and persists the document/page/section/parsed-unit/diagnostic rows.
// Chunks and vectors are NOT written here — those are #195 (chunking) and #196 (indexing).
//
// `DiscoveryError.code` is a closed string union so downstream UI surfaces and the eventual
// audit ledger entries can branch on stable identifiers rather than free-form messages.

import type {
  DocumentId,
  DocumentRecord,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";

// ─── Discovered file (before parsing/persistence) ────────────────────────────
export interface DiscoveredFile {
  // POSIX-style path relative to the scope's rootPath. Never starts with `/`.
  readonly relativePath: string;
  // Stat-reported byte size — used to skip oversized files before we read them.
  readonly sizeBytes: number;
}

// ─── Discovery options ───────────────────────────────────────────────────────
export interface DiscoveryOptions {
  // Hard limit on recursion depth — defends against pathologically deep trees that pass
  // the realpath gate but still take O(depth) per node to walk.
  readonly maxDepth: number;
  // Cap on the total number of files yielded — keeps the walker bounded even when a
  // scope is mis-configured to point at a huge directory.
  readonly maxFiles: number;
  // Optional cancellation. The walker checks at each directory boundary so an abort lands
  // within one directory of work.
  readonly signal?: AbortSignal;
}

export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  maxDepth: 12,
  maxFiles: 5_000,
} as const;

// ─── Error code surface ──────────────────────────────────────────────────────
// Closed union. PATH_ESCAPE is the realpath-containment gate; UNSUPPORTED_FORMAT mirrors
// the parser-registry sentinel; OVERSIZED_FILE mirrors the parser limit; CANCELLED is the
// AbortSignal path; MALFORMED_INPUT / PARSER_TIMEOUT / PARSER_FAILED mirror parser-level
// failures; READ_FAILED captures any other IO surface error from WorkspaceFs.
export type DiscoveryErrorCode =
  | "PATH_ESCAPE"
  | "READ_FAILED"
  | "OVERSIZED_FILE"
  | "UNSUPPORTED_FORMAT"
  | "CANCELLED"
  | "MALFORMED_INPUT"
  | "PARSER_TIMEOUT"
  | "PARSER_FAILED"
  | "STAT_FAILED"
  | "INVALID_SCOPE";

export interface DiscoveryError {
  readonly code: DiscoveryErrorCode;
  readonly message: string;
  readonly relativePath?: string;
}

// ─── Extraction result (per file) ────────────────────────────────────────────
export type ExtractionOutcome =
  // Document parsed and persisted; pages/sections/parsed_units rows were written. The
  // returned `document.status` is either "extracted" or "unsupported" depending on the
  // parser result. `skipped` is reserved for the incremental fast-path.
  | { readonly kind: "persisted"; readonly document: DocumentRecord }
  // Content hash matched an existing extracted document — no re-parse.
  | { readonly kind: "skipped"; readonly document: DocumentRecord; readonly reason: "unchanged" }
  // Hard failure — the document row carries status "failed" and a diagnostic was logged.
  | { readonly kind: "failed"; readonly document: DocumentRecord; readonly error: DiscoveryError };

export interface ExtractionResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly relativePath: string;
  readonly outcome: ExtractionOutcome;
  readonly diagnostics: readonly ParserDiagnostic[];
}

// ─── Progress events from the runner ─────────────────────────────────────────
export type ExtractionEvent =
  | {
      readonly kind: "file-discovered";
      readonly relativePath: string;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "file-extracted";
      readonly result: ExtractionResult;
    }
  | {
      readonly kind: "scope-error";
      readonly error: DiscoveryError;
    }
  | {
      readonly kind: "cancelled";
      readonly reason: string;
    }
  | {
      readonly kind: "completed";
      readonly totalDiscovered: number;
      readonly totalExtracted: number;
      readonly totalSkipped: number;
      readonly totalFailed: number;
    };

// Internal type kept here (not exported from the barrel) so walk.ts and extract.ts share
// the same DocumentId minting convention without diverging.
export interface DocumentIdSource {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly relativePath: string;
}

// Branded helper so callers (extract.ts) don't need to repeat the cast. The returned id is
// deterministic in `(capsuleId, sourceId, relativePath)` so a re-walk of the same scope
// targets the SAME `documents` row — that's the lineage anchor for incremental updates.
//
// The `#` character is encoded as `%23` before embedding so that a file literally named
// `a#u0.md` cannot produce an id that collides with a parsed_unit suffix (`#u0`) or a
// diagnostic suffix (`#d0`) derived from a different document.
export function documentIdFor(input: DocumentIdSource): DocumentId {
  const encodedPath = input.relativePath.replace(/#/g, "%23");
  return `doc:${String(input.capsuleId)}:${String(input.sourceId)}:${encodedPath}` as DocumentId;
}
