// Type contracts for the retrieval layer (Epic #189, Issue #199). Retrieval is the
// runtime side of the Local Knowledge Connector pipeline that #196 fed: a query string +
// a `ComposedRetrievalScope` (#263) → a ranked list of `RetrievalReference` taken from the
// `vectors` table, plus a `GroundedContextPack` derived from those references (citations
// only, never raw text body unless the capsule's `outputMode === "raw"` — and even then
// the body is sourced from the parsed-units row, not embedded vectors).
//
// `RetrievalResult` carries an explicit `noEvidence` boolean rather than overloading an
// empty `references` array because the caller (#200 Conversation Center integration) needs
// to discriminate "we scanned and found nothing" from "the answer-grounding policy refused
// to release the references". A short, closed-enumeration `reason` string lets the UI map
// the result to a precise message without re-deriving state.
//
// `RetrievalError` extends KnowledgeStoreError so callers that catch the parent class
// still see the failure — same pattern as `IndexingError` in `../indexing/types.ts`.

import type {
  CapsuleSetId,
  CitationReference,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "../errors.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export type RetrievalErrorCode =
  | "EMBEDDING_ADAPTER_FAILED"
  | "INCOMPATIBLE_EMBEDDING_IDENTITY"
  | "CAPSULE_NOT_FOUND"
  | "INVALID_QUERY"
  | "STORE_READ_FAILED";

export class RetrievalError extends KnowledgeStoreError {
  public override readonly name: string = "RetrievalError";
  public readonly code: RetrievalErrorCode;
  public constructor(code: RetrievalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ─── Query / result shapes ───────────────────────────────────────────────────
// Exactly one of `capsuleSetId` or `capsuleId` is honoured. When neither is supplied the
// runner returns `noEvidence: true` with `reason: "no-scope"` — we never search globally.
export interface RetrievalQuery {
  readonly capsuleSetId?: CapsuleSetId;
  readonly capsuleId?: KnowledgeCapsuleId;
  readonly text: string;
  readonly topK?: number;
  readonly minScore?: number;
}

// Closed enumeration of `noEvidence` reasons. The strings line up with the BLOCKER
// taxonomy from the Epic #189 contracts so a UI/audit consumer can branch on `reason`
// without parsing free-form messages. `incompatible-embedding-identity` matches the
// indexing-layer code so a capsule re-bound to a new embedding model produces the same
// surface in both pipelines.
export type RetrievalNoEvidenceReason =
  | "no-scope"
  | "no-vectors"
  | "incompatible-embedding-identity"
  | "below-min-score"
  | "answer-grounding-rejected"
  | "empty-query"
  | "embedding-failed";

export interface RetrievalResult {
  readonly references: readonly RetrievalReference[];
  readonly noEvidence: boolean;
  readonly reason?: RetrievalNoEvidenceReason;
}

// ─── Defaults ────────────────────────────────────────────────────────────────
// Match the scope's contract maxima for #200 the conversation-center surface: 10 is a
// reasonable default that still fits in a small context budget for an LLM grounding
// prompt and matches the "Top-K = 10" convention from sibling vector-store products.
export const DEFAULT_RETRIEVAL_TOP_K = 10;
// Hard cap on `topK`. A caller asking for more than this is clamped silently — we never
// surface every vector in a large capsule because that breaks the "ranked top-K" contract
// the answer-grounding policy depends on.
export const MAX_RETRIEVAL_TOP_K = 100;

// Re-export so consumers can import the contract types from this barrel.
export type { CitationReference, RetrievalReference };
