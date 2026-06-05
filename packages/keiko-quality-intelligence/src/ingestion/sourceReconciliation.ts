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
  /** One provenance entry per distinct envelope id. */
  readonly provenance: readonly ProvenanceEntry[];
  /** Envelope ids that appeared in more than one group. */
  readonly duplicatedAcrossGroups: readonly EnvelopeId[];
  /** Envelopes that were skipped because the same id appeared with mismatched kind. */
  readonly conflictingEnvelopeIds: readonly EnvelopeId[];
}

const indexEnvelope = (
  envelope: Envelope,
  groupLabel: string,
  byId: Map<EnvelopeId, Envelope>,
  provById: Map<EnvelopeId, { firstGroupLabel: string; contributingGroupLabels: string[] }>,
  conflicts: Set<EnvelopeId>,
  duplicates: Set<EnvelopeId>,
): void => {
  const existing = byId.get(envelope.id);
  if (existing === undefined) {
    byId.set(envelope.id, envelope);
    provById.set(envelope.id, {
      firstGroupLabel: groupLabel,
      contributingGroupLabels: [groupLabel],
    });
    return;
  }
  if (existing.kind !== envelope.kind) {
    conflicts.add(envelope.id);
    return;
  }
  duplicates.add(envelope.id);
  const prov = provById.get(envelope.id);
  if (prov !== undefined && !prov.contributingGroupLabels.includes(groupLabel)) {
    prov.contributingGroupLabels.push(groupLabel);
  }
};

/**
 * Merge multiple envelope groups into a single non-overlapping set. Pure.
 *
 * Invariants:
 *   * Order: first appearance wins (encounter order across groups, then within group).
 *   * Conflict: same id with different kind = both contributors are recorded in
 *     `conflictingEnvelopeIds` and neither appears in `envelopes`.
 *   * Duplicate: same id with same kind = first envelope kept; later groups appear in
 *     the provenance entry's `contributingGroupLabels`.
 */
export const reconcileSourceGroups = (groups: readonly SourceGroup[]): ReconciledSourceSet => {
  const byId = new Map<EnvelopeId, Envelope>();
  const provById = new Map<
    EnvelopeId,
    { firstGroupLabel: string; contributingGroupLabels: string[] }
  >();
  const conflicts = new Set<EnvelopeId>();
  const duplicates = new Set<EnvelopeId>();

  for (const group of groups) {
    for (const envelope of group.envelopes) {
      indexEnvelope(envelope, group.groupLabel, byId, provById, conflicts, duplicates);
    }
  }

  for (const id of conflicts) {
    byId.delete(id);
    provById.delete(id);
    duplicates.delete(id);
  }

  const envelopes: Envelope[] = [];
  const provenance: ProvenanceEntry[] = [];
  for (const [id, envelope] of byId) {
    const prov = provById.get(id);
    envelopes.push(envelope);
    provenance.push({
      envelopeId: id,
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
