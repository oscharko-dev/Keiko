// Grounded context-pack assembler (Epic #189, Issue #199). Converts a list of
// `RetrievalReference` (the ranked output of `searchVectorsForScope`) into a
// `LocalKnowledgeGroundedContextPack` — a deliberately metadata-only projection that the
// future #200 Conversation Center integration hands to the LLM grounding prompt and the
// answer surface UI.
//
// This pack is structurally distinct from the connected-context layer's
// `GroundedAnswerContextPackSummary` (in `@oscharko-dev/keiko-contracts/bff-wire`): that
// one is shaped around `ConnectedContextPack`, scope kinds (workspace-root, directory,
// files), exploration usage / budget, and uncertainty. Local Knowledge has a different
// runtime model — capsule-set composition, citation-per-chunk — and a different privacy
// contract (we never carry raw text in this PR; `outputMode === "raw"` lands in #200
// where the workspace FS port is wired and we can read the parsed_unit's character
// span from disk). Keeping the two pack types distinct prevents accidental cross-wiring
// when the BFF layer eventually surfaces both.
//
// The pack is pure data — no IO, no allocation beyond the returned record + its
// citation array. Sorting and de-duplication are stable on `chunkId` so the pack is
// byte-identical across runs with the same inputs (load-bearing for the audit ledger).

import type {
  CitationReference,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

// Bumped when the wire shape changes. Consumers (audit ledger, future #200 wire) pin
// against this literal so an unrecognised pack is rejected at the boundary.
export const LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION = "1" as const;

export interface LocalKnowledgeGroundedContextScope {
  // Sorted, de-duplicated, lexicographic — the pack carries the *set* of capsules and
  // sources represented in the references, not the broader search scope (which may have
  // included capsules that contributed zero refs). A consumer reading this pack sees
  // exactly the tenancy the answer was grounded in.
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly capsuleCount: number;
  readonly sourceCount: number;
}

export interface LocalKnowledgeGroundedContextCounts {
  readonly totalReferences: number;
  readonly distinctCapsules: number;
  readonly distinctSources: number;
}

export interface LocalKnowledgeGroundedContextPack {
  readonly schemaVersion: typeof LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION;
  readonly scope: LocalKnowledgeGroundedContextScope;
  // The citations carried in `references` from the search, in the SAME order. Score-desc
  // ordering survives so the LLM grounding prompt can rely on rank-priority slicing
  // without re-sorting.
  readonly citations: readonly CitationReference[];
  readonly counts: LocalKnowledgeGroundedContextCounts;
}

export interface AssembleGroundedContextOptions {
  // Reserved for future use (capsule outputMode honoring, redaction policy). The current
  // implementation reads nothing from this object; it exists so the public signature is
  // stable when #200 wires in the workspace FS port for `outputMode === "raw"`.
  readonly reserved?: never;
}

export function assembleGroundedContext(
  references: readonly RetrievalReference[],
  _options: AssembleGroundedContextOptions = {},
): LocalKnowledgeGroundedContextPack {
  const capsuleIds = collectSortedUnique(references.map((r) => r.capsuleId));
  const sourceIds = collectSortedUnique(references.map((r) => r.citation.sourceId));
  return {
    schemaVersion: LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION,
    scope: {
      capsuleIds,
      sourceIds,
      capsuleCount: capsuleIds.length,
      sourceCount: sourceIds.length,
    },
    citations: references.map((r) => r.citation),
    counts: {
      totalReferences: references.length,
      distinctCapsules: capsuleIds.length,
      distinctSources: sourceIds.length,
    },
  };
}

function collectSortedUnique<T extends { toString(): string }>(values: readonly T[]): readonly T[] {
  const seen = new Map<string, T>();
  for (const value of values) {
    const key = String(value);
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => String(a).localeCompare(String(b)));
}
