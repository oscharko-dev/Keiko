// Quality Intelligence evidence atom (Epic #270, Issue #277).
//
// An atom is the smallest reviewable provenance unit. Atoms are produced by
// dereferencing a `QualityIntelligenceSourceEnvelope` and slicing the underlying
// content into a single coherent claim. The contract surface NEVER carries raw
// content — only:
//   * the atom id
//   * the source envelope id it was derived from
//   * a canonical hash of the content (so audit can detect drift)
//   * a redaction status marker
//   * a lifecycle status
//
// Discriminated union over `kind`:
//   * requirement       — atomic acceptance criterion / behaviour statement
//   * design-fragment   — UI/UX intent fragment (e.g. a Figma frame caption)
//   * code-fragment     — code-level claim (e.g. a function signature)
//   * document-excerpt  — passage from a connector document
//   * human-statement   — human-authored claim (Conversation Center)

import type {
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceSourceEnvelopeId,
} from "./ids.js";

export type QualityIntelligenceEvidenceAtomKind =
  | "requirement"
  | "design-fragment"
  | "code-fragment"
  | "document-excerpt"
  | "human-statement";

export const QUALITY_INTELLIGENCE_EVIDENCE_ATOM_KINDS: readonly QualityIntelligenceEvidenceAtomKind[] =
  [
    "requirement",
    "design-fragment",
    "code-fragment",
    "document-excerpt",
    "human-statement",
  ] as const;

export type QualityIntelligenceRedactionStatus = "redacted" | "not-required";

export const QUALITY_INTELLIGENCE_REDACTION_STATUSES: readonly QualityIntelligenceRedactionStatus[] =
  ["redacted", "not-required"] as const;

export type QualityIntelligenceLifecycleStatus = "draft" | "finalised" | "archived";

export const QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES: readonly QualityIntelligenceLifecycleStatus[] =
  ["draft", "finalised", "archived"] as const;

interface QualityIntelligenceEvidenceAtomCommon {
  readonly id: QualityIntelligenceEvidenceAtomId;
  readonly sourceEnvelopeId: QualityIntelligenceSourceEnvelopeId;
  /** Lowercase hex sha256 of the canonical text of the atom. */
  readonly canonicalHashSha256Hex: string;
  readonly redactionStatus: QualityIntelligenceRedactionStatus;
  readonly lifecycleStatus: QualityIntelligenceLifecycleStatus;
}

export interface QualityIntelligenceRequirementAtom extends QualityIntelligenceEvidenceAtomCommon {
  readonly kind: "requirement";
}

export interface QualityIntelligenceDesignFragmentAtom extends QualityIntelligenceEvidenceAtomCommon {
  readonly kind: "design-fragment";
}

export interface QualityIntelligenceCodeFragmentAtom extends QualityIntelligenceEvidenceAtomCommon {
  readonly kind: "code-fragment";
}

export interface QualityIntelligenceDocumentExcerptAtom extends QualityIntelligenceEvidenceAtomCommon {
  readonly kind: "document-excerpt";
}

export interface QualityIntelligenceHumanStatementAtom extends QualityIntelligenceEvidenceAtomCommon {
  readonly kind: "human-statement";
}

export type QualityIntelligenceEvidenceAtom =
  | QualityIntelligenceRequirementAtom
  | QualityIntelligenceDesignFragmentAtom
  | QualityIntelligenceCodeFragmentAtom
  | QualityIntelligenceDocumentExcerptAtom
  | QualityIntelligenceHumanStatementAtom;

/** Pure structural guard: returns true if the atom's hash field looks like sha256 hex. */
export const hasCanonicalSha256Hash = (atom: QualityIntelligenceEvidenceAtom): boolean =>
  /^[0-9a-f]{64}$/u.test(atom.canonicalHashSha256Hex);
