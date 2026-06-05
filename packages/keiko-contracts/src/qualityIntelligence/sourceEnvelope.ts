// Quality Intelligence source envelope (Epic #270, Issue #277).
//
// A source envelope carries refer-by-ref metadata about a single input scope used to
// derive evidence atoms. ENVELOPES NEVER CARRY RAW CONTENT — they carry an opaque
// `localRef` string the runtime resolves against the workspace, local-knowledge
// capsule store, or other adapter. No URLs, no credentials, no large content blobs.
//
// Discriminated union over `kind`:
//   * repository-context     — refer to a repo workspace path or scope id.
//   * local-knowledge-capsule — refer to a KnowledgeCapsuleId or sub-scope.
//   * figma-evidence          — refer to a local Figma evidence cache id.
//   * human-context           — refer to a human-authored note id (Conversation Center).
//   * connector-document      — refer to an opaque connector document id.
//
// Provenance + integrity hash give the audit ledger (#274) a stable footprint without
// embedding any payload.

import type { QualityIntelligenceSourceEnvelopeId } from "./ids.js";

export type QualityIntelligenceSourceKind =
  | "repository-context"
  | "local-knowledge-capsule"
  | "figma-evidence"
  | "human-context"
  | "connector-document";

export const QUALITY_INTELLIGENCE_SOURCE_KINDS: readonly QualityIntelligenceSourceKind[] = [
  "repository-context",
  "local-knowledge-capsule",
  "figma-evidence",
  "human-context",
  "connector-document",
] as const;

export interface QualityIntelligenceSourceProvenance {
  /** Free-form origin label (e.g. "workspace", "capsule:foo"). Display only. */
  readonly origin: string;
  /** ISO 8601 timestamp (UTC) when the envelope was registered. */
  readonly registeredAt: string;
  /**
   * Lowercase hex sha256 of the underlying content. The contract surface never
   * carries the content itself; this hash exists so the audit ledger can detect
   * drift between envelope registration and downstream reads.
   */
  readonly integrityHashSha256Hex: string;
}

interface QualityIntelligenceSourceEnvelopeCommon {
  readonly id: QualityIntelligenceSourceEnvelopeId;
  /** Non-secret display label. Must not contain credentials or URLs. */
  readonly displayLabel: string;
  readonly provenance: QualityIntelligenceSourceProvenance;
}

export interface QualityIntelligenceRepositoryContextEnvelope extends QualityIntelligenceSourceEnvelopeCommon {
  readonly kind: "repository-context";
  /** Opaque ref to a workspace scope or path (resolved by keiko-workspace). */
  readonly localRef: string;
}

export interface QualityIntelligenceLocalKnowledgeCapsuleEnvelope extends QualityIntelligenceSourceEnvelopeCommon {
  readonly kind: "local-knowledge-capsule";
  /** Opaque ref to a KnowledgeCapsule (resolved by keiko-local-knowledge). */
  readonly localRef: string;
}

export interface QualityIntelligenceFigmaEvidenceEnvelope extends QualityIntelligenceSourceEnvelopeCommon {
  readonly kind: "figma-evidence";
  /** Opaque ref to a local Figma evidence cache entry. NOT a Figma URL. */
  readonly localRef: string;
}

export interface QualityIntelligenceHumanContextEnvelope extends QualityIntelligenceSourceEnvelopeCommon {
  readonly kind: "human-context";
  /** Opaque ref to a Conversation Center human-context note id. */
  readonly localRef: string;
}

export interface QualityIntelligenceConnectorDocumentEnvelope extends QualityIntelligenceSourceEnvelopeCommon {
  readonly kind: "connector-document";
  /** Opaque ref to a connector-document id (resolved by an adapter). */
  readonly localRef: string;
  /**
   * Stable identifier of the connector adapter that vended `localRef`. Display only;
   * not authoritative for security decisions.
   */
  readonly adapterId: string;
}

export type QualityIntelligenceSourceEnvelope =
  | QualityIntelligenceRepositoryContextEnvelope
  | QualityIntelligenceLocalKnowledgeCapsuleEnvelope
  | QualityIntelligenceFigmaEvidenceEnvelope
  | QualityIntelligenceHumanContextEnvelope
  | QualityIntelligenceConnectorDocumentEnvelope;

/**
 * Cheap structural guard: rejects envelopes that look like they may carry credentials,
 * URLs, or oversized labels in their display surface. Pure, no IO.
 *
 * The runtime that builds envelopes is responsible for ALL redaction; this helper is
 * a defence-in-depth check the audit ledger can use before persisting.
 */
export const looksLikeBrowserSafeSourceEnvelope = (
  envelope: QualityIntelligenceSourceEnvelope,
): boolean => {
  const { displayLabel, provenance, localRef } = envelope;
  if (displayLabel.length === 0 || displayLabel.length > 256) return false;
  if (/https?:\/\//iu.test(displayLabel)) return false;
  if (/https?:\/\//iu.test(localRef)) return false;
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/u.test(displayLabel)) return false; // base64-ish
  if (!/^[0-9a-f]{64}$/u.test(provenance.integrityHashSha256Hex)) return false;
  return true;
};
