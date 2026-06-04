// Type contracts for the retrieval evaluation harness (Epic #189, Issue #268). The
// harness is OFFLINE only — it composes #199 retrieval through a scripted (deterministic)
// embedding adapter so every scorecard is byte-identical across runs. That determinism is
// load-bearing for the audit ledger (#10): a non-deterministic eval result would force
// the manifest to encode timestamps or random salts and break the cross-machine equality
// check that the verification matrix relies on.
//
// `RetrievalEvalFixture` is the executable contract a fixture must satisfy: enough capsule
// + source + document + parsed-unit + chunk specs to materialise an in-memory store, plus
// a list of queries with ground truth (`expectedChunkIds`) or an explicit no-evidence flag.
//
// `RetrievalEvalScorecard` is the immutable result the runner returns. The dimensions are
// each in `[0, 1]` so a downstream aggregator can compare or threshold without re-deriving
// semantics. `passed` is the conjunction of per-dimension thresholds in `PASS_THRESHOLDS`
// — exposing the constant lets a UI display a "X met 4/5 thresholds" breakdown without
// re-implementing the comparison.

import type {
  CapsuleAnswerGroundingPolicy,
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

// ─── Fixture specs ───────────────────────────────────────────────────────────
// A fixture is the deterministic seed for a single eval run. The runner materialises the
// fixture into a fresh tmpdir SQLite store, then executes every query against the chosen
// retrieval scope. Only the shape needed to seed rows + score queries is encoded — the
// rest (e.g. the document parser) is implied by the parsed-unit kind.

export interface EvalChunkSpec {
  readonly id: ChunkId;
  readonly text: string;
  // Optional topic salt: when present, the scripted embedding adapter boosts this chunk's
  // cosine similarity for any query carrying the same topic salt. Lets a fixture make the
  // ground-truth chunk for a query verifiably the top result without resorting to actual
  // natural-language matching.
  readonly topic?: string;
}

export interface EvalParsedUnitSpec {
  // `documentId` is filled in by the runner from `EvalDocumentSpec.id` so a fixture cannot
  // accidentally specify a unit that points at the wrong document.
  readonly unit: Omit<Extract<ParsedUnit, { kind: "page" }>, "documentId">;
}

export interface EvalDocumentSpec {
  readonly id: DocumentId;
  readonly safeDisplayName: string;
  readonly parsedUnit: EvalParsedUnitSpec;
  readonly chunks: readonly EvalChunkSpec[];
}

export interface EvalSourceSpec {
  readonly id: KnowledgeSourceId;
  readonly documents: readonly EvalDocumentSpec[];
}

export interface EvalCapsuleSpec {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly answerGroundingPolicy: CapsuleAnswerGroundingPolicy;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly sources: readonly EvalSourceSpec[];
}

// Discriminator on retrieval scope. The runner translates this into either a `capsuleId`
// or a `capsuleSetId` parameter on the underlying `RetrievalQuery`. `capsuleSet` carries a
// human-readable id so a fixture can refer to it by name in tests.
export type EvalRetrievalScope =
  | { readonly kind: "capsule"; readonly capsuleId: KnowledgeCapsuleId }
  | {
      readonly kind: "capsule-set";
      readonly capsuleSetId: string;
      readonly capsuleIds: readonly KnowledgeCapsuleId[];
    };

export interface RetrievalEvalQuery {
  readonly id: string;
  readonly text: string;
  // Topic that the scripted adapter routes the query toward — chunks with the same `topic`
  // value get a deterministic similarity boost. Optional: an unsalted query still scores
  // every chunk but with hash-only similarity.
  readonly topic?: string;
  readonly scope: EvalRetrievalScope;
  readonly expectedChunkIds?: readonly ChunkId[];
  readonly expectedNoEvidence?: boolean;
  // Optional override of the retrieval `topK`. Used by the mutation-witness test.
  readonly topK?: number;
}

export interface RetrievalEvalFixture {
  readonly id: string;
  readonly description: string;
  readonly capsules: readonly EvalCapsuleSpec[];
  readonly queries: readonly RetrievalEvalQuery[];
}

// ─── Scorecard ───────────────────────────────────────────────────────────────
// Each dimension is in `[0, 1]`. The runner averages across queries — averaging is safe
// because every dimension is bounded and a missing input (no expected refs, no returned
// refs) yields a vacuous 1.0 rather than NaN.

export interface RetrievalEvalDimensionScores {
  readonly recall: number;
  readonly precision: number;
  readonly sourceIsolation: number;
  readonly citationQuality: number;
  readonly noEvidenceAccuracy: number;
  readonly latencyMs: number;
}

export interface RetrievalEvalScorecard {
  readonly fixtureId: string;
  readonly runId: string;
  readonly dimensions: RetrievalEvalDimensionScores;
  readonly passed: boolean;
}

// ─── Pass thresholds ─────────────────────────────────────────────────────────
// The thresholds match the issue brief — surfaced as an exported constant so a UI can
// render "met 4 of 5" without re-implementing the comparison. `noEvidenceAccuracy` and
// `sourceIsolation` are hard `=== 1.0` because both are tenant-isolation guarantees the
// retrieval contract MUST never violate.
export interface RetrievalEvalThresholds {
  readonly recall: number;
  readonly precision: number;
  readonly sourceIsolation: number;
  readonly citationQuality: number;
  readonly noEvidenceAccuracy: number;
}

export const PASS_THRESHOLDS: RetrievalEvalThresholds = Object.freeze({
  recall: 0.9,
  precision: 0.8,
  sourceIsolation: 1.0,
  citationQuality: 0.9,
  noEvidenceAccuracy: 1.0,
});
