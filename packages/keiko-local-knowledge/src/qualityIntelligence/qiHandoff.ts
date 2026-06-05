// Local Knowledge → Quality Intelligence handoff adapter (Epic #270, Issue #278).
//
// Pure adapter that turns an existing local-knowledge `RetrievalReference` list (the
// result of a capsule retrieval) into a list of QI source envelopes with
// `kind: "local-knowledge-capsule"`. The QI ingestion pipeline then plans / reconciles
// these envelopes alongside repo-context envelopes through the same source-mix surface.
//
// Pure: no IO, no clock reads. The caller supplies a deterministic `registeredAt`
// timestamp and a per-citation SHA-256 integrity hash. The adapter reuses ONLY
// existing local-knowledge / contract types — it does not add a new retrieval port.
//
// Structurally inspired by Test Intelligence reference (TI) capsule handoffs, but the
// envelope shape is anchored on the QI contracts surface
// (@oscharko-dev/keiko-contracts/qualityIntelligence).

import type { RetrievalReference } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

type CapsuleEnvelope = QualityIntelligence.QualityIntelligenceLocalKnowledgeCapsuleEnvelope;
const { asQualityIntelligenceSourceEnvelopeId } = QualityIntelligence;

export type QiHandoffErrorCode =
  | "EMPTY_REFERENCE"
  | "EMPTY_HASH_TABLE"
  | "INVALID_INTEGRITY_HASH"
  | "INVALID_REGISTERED_AT"
  | "MISSING_INTEGRITY_HASH";

export class QiHandoffError extends Error {
  public readonly code: QiHandoffErrorCode;
  constructor(code: QiHandoffErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "QiHandoffError";
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const assertHash = (hash: string): void => {
  if (!HEX64.test(hash)) {
    throw new QiHandoffError(
      "INVALID_INTEGRITY_HASH",
      "integrityHashSha256Hex must be 64 lowercase hex chars",
    );
  }
};

const assertRegisteredAt = (timestamp: string): void => {
  if (!ISO_8601.test(timestamp)) {
    throw new QiHandoffError(
      "INVALID_REGISTERED_AT",
      "registeredAt must be ISO 8601 UTC (e.g. 2026-06-05T00:00:00Z)",
    );
  }
};

const clampLabel = (label: string): string => {
  if (label.length <= 256) return label;
  return `${label.slice(0, 253)}...`;
};

export interface BuildCapsuleEnvelopesInput {
  /** ISO 8601 UTC timestamp the consumer captured for envelope provenance. */
  readonly registeredAt: string;
  /** Retrieval references from `keiko-local-knowledge` for a single capsule query. */
  readonly references: readonly RetrievalReference[];
  /**
   * SHA-256 hex digest table keyed by the citation chunkId. The adapter rejects any
   * reference whose chunkId has no matching digest with `MISSING_INTEGRITY_HASH`.
   */
  readonly integrityHashByChunkId: Readonly<Record<string, string>>;
  /**
   * Caller-pre-validated id prefix. Each envelope id is `${idPrefix}:${chunkId}`. The
   * contract validator (asQualityIntelligenceSourceEnvelopeId) rejects forbidden
   * fragments — callers must guarantee the prefix passes those rules.
   */
  readonly idPrefix: string;
}

/**
 * Convert a list of `RetrievalReference` into local-knowledge-capsule envelopes. Pure.
 *
 * Each envelope's `localRef` is the citation chunkId (an opaque local-knowledge
 * identifier, never a URL or a path). The envelope display label combines the
 * capsule's `safeDisplayName` with the chunkId so the audit ledger has a
 * non-secret descriptor.
 */
export const buildCapsuleSourceEnvelopes = (
  input: BuildCapsuleEnvelopesInput,
): readonly CapsuleEnvelope[] => {
  if (input.references.length === 0) {
    throw new QiHandoffError("EMPTY_REFERENCE", "references list must not be empty");
  }
  if (Object.keys(input.integrityHashByChunkId).length === 0) {
    throw new QiHandoffError("EMPTY_HASH_TABLE", "integrityHashByChunkId must not be empty");
  }
  assertRegisteredAt(input.registeredAt);

  const envelopes: CapsuleEnvelope[] = [];
  for (const reference of input.references) {
    const chunkId = reference.chunkId;
    const hash = input.integrityHashByChunkId[chunkId];
    if (typeof hash !== "string") {
      throw new QiHandoffError(
        "MISSING_INTEGRITY_HASH",
        `No integrity hash supplied for chunkId "${chunkId}"`,
      );
    }
    assertHash(hash);
    const id = asQualityIntelligenceSourceEnvelopeId(`${input.idPrefix}:${chunkId}`);
    const safeName = reference.citation.safeDisplayName;
    const displayLabel = clampLabel(`local-knowledge:${safeName}#${chunkId}`);
    envelopes.push({
      id,
      kind: "local-knowledge-capsule",
      displayLabel,
      provenance: {
        origin: `local-knowledge-capsule:${reference.capsuleId}`,
        registeredAt: input.registeredAt,
        integrityHashSha256Hex: hash,
      },
      localRef: chunkId,
    });
  }
  return envelopes;
};
