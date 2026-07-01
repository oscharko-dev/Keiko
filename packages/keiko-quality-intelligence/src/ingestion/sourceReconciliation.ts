// Quality Intelligence — source reconciliation (Epic #270, Issue #278).
//
// Deterministic merge of multiple envelope groups (e.g. requirements + Figma + repo
// context) into a single non-overlapping `ReconciledSourceSet` with provenance preserved
// per envelope id.
//
// Pure: no IO, no clock, no randomness. Operates only on contract types from
// @oscharko-dev/keiko-contracts.
//
// Structurally inspired by Test Intelligence reference (TI) source-reconciliation
// patterns, but the provenance shape is anchored on the Keiko contracts surface.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

type Envelope = QualityIntelligence.QualityIntelligenceSourceEnvelope;
type EnvelopeId = QualityIntelligence.QualityIntelligenceSourceEnvelopeId;
type EnvelopeIdentity = string;

/** A logical group of envelopes (e.g. one Conversation Center thread, one repo scan). */
export interface SourceGroup {
  /** Stable label for the group; used as the provenance origin. */
  readonly groupLabel: string;
  readonly envelopes: readonly Envelope[];
}

export interface ProvenanceEntry {
  readonly envelopeId: EnvelopeId;
  /** First group label that contributed this envelope. */
  readonly firstGroupLabel: string;
  /** All distinct group labels that contributed this envelope (insertion-stable). */
  readonly contributingGroupLabels: readonly string[];
}

export interface ReconciledSourceSet {
  /** Distinct envelopes in encounter order across the input groups. */
  readonly envelopes: readonly Envelope[];
  /** One provenance entry per distinct envelope identity (kind + id). */
  readonly provenance: readonly ProvenanceEntry[];
  /** Envelope ids that appeared in more than one group. */
  readonly duplicatedAcrossGroups: readonly EnvelopeId[];
  /** Envelopes that were skipped because the same id appeared with mismatched kind. */
  readonly conflictingEnvelopeIds: readonly EnvelopeId[];
}

const indexEnvelope = (
  envelope: Envelope,
  groupLabel: string,
  byIdentity: Map<EnvelopeIdentity, Envelope>,
  provByIdentity: Map<
    EnvelopeIdentity,
    { firstGroupLabel: string; contributingGroupLabels: string[] }
  >,
  conflicts: Set<EnvelopeId>,
  duplicates: Set<EnvelopeId>,
): void => {
  const identity = `${envelope.kind}\u0000${envelope.id}`;
  const existing = byIdentity.get(identity);
  if (existing === undefined) {
    byIdentity.set(identity, envelope);
    provByIdentity.set(identity, {
      firstGroupLabel: groupLabel,
      contributingGroupLabels: [groupLabel],
    });
    return;
  }
  duplicates.add(envelope.id);
  const prov = provByIdentity.get(identity);
  if (prov !== undefined && !prov.contributingGroupLabels.includes(groupLabel)) {
    prov.contributingGroupLabels.push(groupLabel);
  }
};

/**
 * Merge multiple envelope groups into a single non-overlapping set. Pure.
 *
 * Invariants:
 *   * Order: first appearance wins (encounter order across groups, then within group).
 *   * Identity: kind + id mirrors source-mix planning. Same id with different kind is distinct.
 *   * Duplicate: same kind + same id = first envelope kept; later groups appear in
 *     the provenance entry's `contributingGroupLabels`.
 */
export const reconcileSourceGroups = (groups: readonly SourceGroup[]): ReconciledSourceSet => {
  const byIdentity = new Map<EnvelopeIdentity, Envelope>();
  const provByIdentity = new Map<
    EnvelopeIdentity,
    { firstGroupLabel: string; contributingGroupLabels: string[] }
  >();
  const conflicts = new Set<EnvelopeId>();
  const duplicates = new Set<EnvelopeId>();

  for (const group of groups) {
    for (const envelope of group.envelopes) {
      indexEnvelope(envelope, group.groupLabel, byIdentity, provByIdentity, conflicts, duplicates);
    }
  }

  for (const id of conflicts) {
    duplicates.delete(id);
  }

  const envelopes: Envelope[] = [];
  const provenance: ProvenanceEntry[] = [];
  for (const [identity, envelope] of byIdentity) {
    const prov = provByIdentity.get(identity);
    envelopes.push(envelope);
    provenance.push({
      envelopeId: envelope.id,
      firstGroupLabel: prov?.firstGroupLabel ?? "",
      contributingGroupLabels: prov?.contributingGroupLabels ?? [],
    });
  }

  return {
    envelopes,
    provenance,
    duplicatedAcrossGroups: [...duplicates],
    conflictingEnvelopeIds: [...conflicts],
  };
};
