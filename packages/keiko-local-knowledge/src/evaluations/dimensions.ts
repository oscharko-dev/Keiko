// Pure scoring functions for the retrieval evaluation harness (Epic #189, Issue #268).
// Each function takes structural inputs (no store, no IO) and returns a number in
// `[0, 1]` — that range invariant is enforced by every branch and is load-bearing for the
// aggregator in `runner.ts`, which averages dimensions across queries.
//
// Vacuous cases:
//   - `scoreRecall` with empty `expected` ⇒ 1.0 (nothing was missed).
//   - `scorePrecision` with empty `returned` ⇒ 1.0 (no false positives possible). Callers
//     that want "no refs is a failure" should reach for `scoreNoEvidenceAccuracy` instead.
//   - `scoreSourceIsolation` with empty `returned` ⇒ 1.0 (no leak possible).
//   - `scoreCitationQuality` with empty `references` ⇒ 1.0 (no malformed citations).
//
// These vacuous-1.0 conventions are deliberate: a fixture that expects no evidence should
// not be penalised on recall/precision/etc. The `noEvidenceAccuracy` dimension is the one
// that discriminates "expected nothing AND got nothing" vs "expected nothing but got
// something" vs "expected something but got nothing".

import type {
  ChunkId,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";

// ─── Recall ──────────────────────────────────────────────────────────────────
// `expected ∩ returned / |expected|`. We compare on `chunkId` because `RetrievalReference`
// carries the chunk id verbatim and that is the smallest discriminator the fixtures use.

export function scoreRecall(
  returned: readonly RetrievalReference[],
  expected: readonly ChunkId[],
): number {
  if (expected.length === 0) return 1;
  const returnedIds = new Set<string>();
  for (const ref of returned) returnedIds.add(String(ref.chunkId));
  let hits = 0;
  for (const id of expected) {
    if (returnedIds.has(String(id))) hits += 1;
  }
  return hits / expected.length;
}

// ─── Precision ───────────────────────────────────────────────────────────────
// `expected ∩ returned / |returned|`.

export function scorePrecision(
  returned: readonly RetrievalReference[],
  expected: readonly ChunkId[],
): number {
  if (returned.length === 0) return 1;
  const expectedIds = new Set<string>();
  for (const id of expected) expectedIds.add(String(id));
  let hits = 0;
  for (const ref of returned) {
    if (expectedIds.has(String(ref.chunkId))) hits += 1;
  }
  return hits / returned.length;
}

// ─── Source isolation ────────────────────────────────────────────────────────
// A retrieval is source-isolated iff every returned reference belongs to a capsule that is
// in `scopeCapsuleIds`. A single leak across the capsule boundary drops the score to 0 —
// the issue brief calls source isolation a hard tenant-isolation guarantee, so partial
// credit would dilute its meaning. The scope is normalised to a string set so the function
// stays agnostic to the branded `KnowledgeCapsuleId` newtype.

export function scoreSourceIsolation(
  returned: readonly RetrievalReference[],
  scopeCapsuleIds: readonly KnowledgeCapsuleId[],
): number {
  if (returned.length === 0) return 1;
  const allowed = new Set<string>();
  for (const id of scopeCapsuleIds) allowed.add(String(id));
  for (const ref of returned) {
    if (!allowed.has(String(ref.capsuleId))) return 0;
  }
  return 1;
}

// ─── Citation quality ────────────────────────────────────────────────────────
// For every returned reference we check that the citation has the fields the parsed-unit
// kind supports. The mapping is encoded as a lookup keyed by `unit.kind` so a new unit
// kind in the contract surfaces here at compile time (TypeScript will flag the missing
// case once the discriminated union grows). A reference whose citation lacks a required
// field counts as malformed; the score is `well-formed / total`.
//
// Mapping (page-units require pageNumber; section-units require sectionPath; json-path
// and csv-row units require characterStart/characterEnd; html-block requires sectionPath;
// unsupported-media has no required citation fields — every well-formed CitationReference
// passes vacuously):

type CitationRequirementKey =
  | "page"
  | "section"
  | "json-path"
  | "csv-row"
  | "html-block"
  | "unsupported-media";

interface CitationCheckInput {
  readonly reference: RetrievalReference;
  readonly unitKind: CitationRequirementKey;
}

function isPageCitationWellFormed(reference: RetrievalReference): boolean {
  return reference.citation.pageNumber !== undefined;
}

function isSectionCitationWellFormed(reference: RetrievalReference): boolean {
  const path = reference.citation.sectionPath;
  return path !== undefined && path.length > 0;
}

function isSpanCitationWellFormed(reference: RetrievalReference): boolean {
  return (
    reference.citation.characterStart !== undefined && reference.citation.characterEnd !== undefined
  );
}

function isCitationWellFormed(input: CitationCheckInput): boolean {
  switch (input.unitKind) {
    case "page":
      return isPageCitationWellFormed(input.reference);
    case "section":
    case "html-block":
      return isSectionCitationWellFormed(input.reference);
    case "json-path":
    case "csv-row":
      return isSpanCitationWellFormed(input.reference);
    case "unsupported-media":
      return true;
  }
}

// A fixture passes per-chunk unit-kind metadata through to this function. We cannot infer
// the unit kind from a `CitationReference` alone — the contract permits any subset of the
// optional fields to be present — so the runner threads `chunkUnitKinds` through.

export function scoreCitationQuality(
  references: readonly RetrievalReference[],
  chunkUnitKinds: ReadonlyMap<string, CitationRequirementKey>,
): number {
  if (references.length === 0) return 1;
  let wellFormed = 0;
  for (const reference of references) {
    const unitKind = chunkUnitKinds.get(String(reference.chunkId));
    // A reference for which we have no unit-kind metadata is treated as well-formed —
    // there is nothing concrete to check against and penalising it would conflate
    // "missing test metadata" with "missing citation field".
    if (unitKind === undefined) {
      wellFormed += 1;
      continue;
    }
    if (isCitationWellFormed({ reference, unitKind })) wellFormed += 1;
  }
  return wellFormed / references.length;
}

// Map a contract `ParsedUnit` kind to the requirement key. Exported so the runner can
// build the `chunkUnitKinds` map from its fixture seed without re-declaring the union.
export function citationRequirementForUnit(unit: ParsedUnit): CitationRequirementKey {
  return unit.kind;
}

export type { CitationRequirementKey };

// ─── No-evidence accuracy ────────────────────────────────────────────────────
// Binary: `1.0` when the actual result matches the expected no-evidence flag, `0.0`
// otherwise. The function returns the typed literal so a downstream `passed` check can
// use `===` without worrying about floating-point comparisons.

export function scoreNoEvidenceAccuracy(
  actualNoEvidence: boolean,
  expectedNoEvidence: boolean,
  actualReason?: string,
  expectedReason?: string,
): 0 | 1 {
  if (actualNoEvidence !== expectedNoEvidence) return 0;
  if (expectedReason !== undefined) {
    return actualReason === expectedReason ? 1 : 0;
  }
  return 1;
}

// ─── Context-budget fit ──────────────────────────────────────────────────────
// `1.0` when the retrieved chunk-token total fits within the configured budget. When it
// exceeds the budget we return the bounded ratio `budget / used`, which keeps the score in
// `[0, 1]` while preserving how far over budget the retrieval spilled. Queries without a
// configured budget are treated vacuously as 1.0 because there is no concrete fit target.

export function scoreContextBudgetFit(
  references: readonly RetrievalReference[],
  chunkTokenCounts: ReadonlyMap<string, number>,
  budgetTokens: number | undefined,
): number {
  if (budgetTokens === undefined) return 1;
  if (references.length === 0) return 1;
  if (budgetTokens <= 0) return 0;
  let used = 0;
  for (const reference of references) {
    used += chunkTokenCounts.get(String(reference.chunkId)) ?? 0;
  }
  if (used <= 0) return 1;
  if (used <= budgetTokens) return 1;
  return budgetTokens / used;
}
