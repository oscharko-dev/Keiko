// Quality Intelligence — source-mix planning (Epic #270, Issue #278).
//
// Deterministic planner that takes a list of `QualityIntelligenceSourceEnvelope`s and
// returns a `SourceMixPlan`: a dedup'd, priority-ordered list of envelope ids together
// with an oversize-flag table the consumer uses to decide what to skip.
//
// Pure: no IO, no clock, no randomness. Operates only on contract types from
// @oscharko-dev/keiko-contracts.
//
// Structurally inspired by Test Intelligence reference (TI) source-mix planning, but the
// envelope-ref shape and the priority table are anchored on the Keiko contracts surface.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

type Envelope = QualityIntelligence.QualityIntelligenceSourceEnvelope;
type EnvelopeId = QualityIntelligence.QualityIntelligenceSourceEnvelopeId;
type SourceKind = QualityIntelligence.QualityIntelligenceSourceKind;

/** Per-kind priority weight: lower number = higher priority (planned earlier). */
export const SOURCE_KIND_PRIORITY: Readonly<Record<SourceKind, number>> = {
  "repository-context": 0,
  "local-knowledge-capsule": 1,
  "human-context": 2,
  "figma-evidence": 3,
  "connector-document": 4,
};

const DEFAULT_MAX_LABEL_BYTES = 256;

export interface SourceMixPlanOptions {
  /**
   * Envelope display-label byte budget. An envelope whose label exceeds this is flagged
   * as oversize but NOT dropped — the consumer decides what to do. Defaults to 256.
   */
  readonly maxLabelBytes?: number;
  /**
   * Hard cap on the number of envelopes the planner will keep. Defaults to 256. Extras
   * appear in `droppedForCap` in original priority order.
   */
  readonly maxEnvelopes?: number;
}

export interface SourceMixPlanEntry {
  readonly envelopeId: EnvelopeId;
  readonly kind: SourceKind;
  readonly priority: number;
  readonly oversize: boolean;
}

export interface SourceMixPlan {
  readonly entries: readonly SourceMixPlanEntry[];
  readonly droppedForDuplicate: readonly EnvelopeId[];
  readonly droppedForCap: readonly EnvelopeId[];
  readonly oversizeCount: number;
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const stableSecondaryKey = (envelope: Envelope): string => `${envelope.kind}\u0000${envelope.id}`;

const compareEntries = (a: SourceMixPlanEntry, b: SourceMixPlanEntry): number => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ka = `${a.kind}\u0000${a.envelopeId}`;
  const kb = `${b.kind}\u0000${b.envelopeId}`;
  return compareStrings(ka, kb);
};

/**
 * Build a deterministic plan from a list of envelopes. Stable, pure.
 */
export const planSourceMix = (
  envelopes: readonly Envelope[],
  options: SourceMixPlanOptions = {},
): SourceMixPlan => {
  const maxLabelBytes = options.maxLabelBytes ?? DEFAULT_MAX_LABEL_BYTES;
  const maxEnvelopes = options.maxEnvelopes ?? 256;

  const seen = new Set<string>();
  const droppedForDuplicate: EnvelopeId[] = [];
  const candidate: SourceMixPlanEntry[] = [];

  for (const envelope of envelopes) {
    const key = stableSecondaryKey(envelope);
    if (seen.has(key)) {
      droppedForDuplicate.push(envelope.id);
      continue;
    }
    seen.add(key);
    const oversize = utf8ByteLength(envelope.displayLabel) > maxLabelBytes;
    candidate.push({
      envelopeId: envelope.id,
      kind: envelope.kind,
      priority: SOURCE_KIND_PRIORITY[envelope.kind],
      oversize,
    });
  }

  const sorted = [...candidate].sort(compareEntries);
  const kept = sorted.slice(0, maxEnvelopes);
  const cappedTail = sorted.slice(maxEnvelopes);
  const droppedForCap = cappedTail.map((e) => e.envelopeId);
  const oversizeCount = kept.reduce((acc, e) => acc + (e.oversize ? 1 : 0), 0);

  return {
    entries: kept,
    droppedForDuplicate,
    droppedForCap,
    oversizeCount,
  };
};
