// Pure helpers for the compaction builder (ADR-0053 D4). No IO, no clock, no randomness. Every
// free-text string that enters a record is scrubbed via redact() from keiko-security BEFORE
// inclusion (the PR2 in-memory defense-in-depth; the CRITICAL BOUNDARY CORRECTION over ADR-0053
// keeps keiko-workflows free of any keiko-memory-capture edge). Split from compaction.ts to hold
// both files under the 400-LOC budget.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  countContextTokens,
  validateContextPreservedFact,
  type ContextAssumption,
  type ContextCommandOutcome,
  type ContextInvalidationKey,
  type ContextLaneId,
  type ContextPreservedFact,
  type ContextProvenanceRef,
  type ContextRehydrationHandle,
  type ContextTokenAccounting,
  type ContextUserConstraint,
} from "@oscharko-dev/keiko-contracts";
import { hashExcerptContent } from "@oscharko-dev/keiko-workspace";
import { redact } from "@oscharko-dev/keiko-security";

import type { ContextLaneInput, ContextLaneItemInput } from "./allocator.js";

// The rich session-level payload the caller hands to the builder. Every field optional; every
// free-text member is redacted before it reaches a record.
export interface CompactionDigest {
  readonly preservedFacts?: readonly ContextPreservedFact[] | undefined;
  readonly assumptions?: readonly ContextAssumption[] | undefined;
  readonly userConstraints?: readonly ContextUserConstraint[] | undefined;
  readonly decisions?: readonly string[] | undefined;
  readonly openQuestions?: readonly string[] | undefined;
  readonly filesInspected?: readonly string[] | undefined;
  readonly filesChanged?: readonly string[] | undefined;
  readonly commandOutcomes?: readonly ContextCommandOutcome[] | undefined;
  readonly failingTests?: readonly string[] | undefined;
  readonly droppedCategories?: readonly string[] | undefined;
}

// Result of projecting a digest into the additive record fields (post-redaction, post-validation).
export interface DigestProjection {
  readonly preservedFacts?: readonly ContextPreservedFact[] | undefined;
  readonly assumptions?: readonly ContextAssumption[] | undefined;
  readonly userConstraints?: readonly ContextUserConstraint[] | undefined;
  readonly decisions?: readonly string[] | undefined;
  readonly openQuestions?: readonly string[] | undefined;
  readonly filesInspected?: readonly string[] | undefined;
  readonly filesChanged?: readonly string[] | undefined;
  readonly commandOutcomes?: readonly ContextCommandOutcome[] | undefined;
  readonly failingTests?: readonly string[] | undefined;
  readonly droppedCategories?: readonly string[] | undefined;
}

function redactStrings(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined ? undefined : values.map((value) => redact(value));
}

function redactRef(ref: ContextProvenanceRef): ContextProvenanceRef {
  return ref.notPersistedReason === undefined
    ? ref
    : { ...ref, notPersistedReason: redact(ref.notPersistedReason) };
}

// A redacted fact is kept ONLY when it still satisfies the sourceRef-or-inferred invariant. An
// unsourced, non-inferred "fact" is DROPPED (and counted by the caller) — never silently coerced.
function projectFact(fact: ContextPreservedFact): ContextPreservedFact | undefined {
  const redacted: ContextPreservedFact = {
    ...fact,
    statement: redact(fact.statement),
    ...(fact.sourceRef !== undefined ? { sourceRef: redactRef(fact.sourceRef) } : {}),
    ...(fact.corroborating !== undefined
      ? { corroborating: fact.corroborating.map(redactRef) }
      : {}),
  };
  return validateContextPreservedFact(redacted).ok ? redacted : undefined;
}

export function projectFacts(facts: readonly ContextPreservedFact[]): {
  readonly kept: readonly ContextPreservedFact[];
  readonly dropped: number;
} {
  const kept: ContextPreservedFact[] = [];
  let dropped = 0;
  for (const fact of facts) {
    const projected = projectFact(fact);
    if (projected === undefined) {
      dropped += 1;
    } else {
      kept.push(projected);
    }
  }
  return { kept, dropped };
}

function projectAssumption(assumption: ContextAssumption): ContextAssumption {
  return {
    ...assumption,
    statement: redact(assumption.statement),
    rationale: redact(assumption.rationale),
  };
}

function projectConstraint(constraint: ContextUserConstraint): ContextUserConstraint {
  return {
    ...constraint,
    statement: redact(constraint.statement),
    ...(constraint.sourceRef !== undefined ? { sourceRef: redactRef(constraint.sourceRef) } : {}),
  };
}

function projectOutcome(outcome: ContextCommandOutcome): ContextCommandOutcome {
  return {
    ...outcome,
    command: redact(outcome.command),
    summary: redact(outcome.summary),
  };
}

// The structured (typed) digest members: facts validated + redacted, assumptions/constraints/
// outcomes redacted in their free-text members. Facts stay strictly separate from assumptions.
function projectStructured(digest: CompactionDigest): DigestProjection {
  return {
    ...(digest.preservedFacts !== undefined
      ? { preservedFacts: projectFacts(digest.preservedFacts).kept }
      : {}),
    ...(digest.assumptions !== undefined
      ? { assumptions: digest.assumptions.map(projectAssumption) }
      : {}),
    ...(digest.userConstraints !== undefined
      ? { userConstraints: digest.userConstraints.map(projectConstraint) }
      : {}),
    ...(digest.commandOutcomes !== undefined
      ? { commandOutcomes: digest.commandOutcomes.map(projectOutcome) }
      : {}),
  };
}

// The free-text / path-list digest members. decisions/openQuestions/failingTests are redacted;
// file-path lists are kept verbatim (paths are not free text and never reach the browser; PR5
// applies the persistence-time redaction posture).
function projectPlain(digest: CompactionDigest): DigestProjection {
  return {
    ...(digest.decisions !== undefined ? { decisions: redactStrings(digest.decisions) } : {}),
    ...(digest.openQuestions !== undefined
      ? { openQuestions: redactStrings(digest.openQuestions) }
      : {}),
    ...(digest.filesInspected !== undefined ? { filesInspected: digest.filesInspected } : {}),
    ...(digest.filesChanged !== undefined ? { filesChanged: digest.filesChanged } : {}),
    ...(digest.failingTests !== undefined
      ? { failingTests: redactStrings(digest.failingTests) }
      : {}),
    ...(digest.droppedCategories !== undefined
      ? { droppedCategories: digest.droppedCategories }
      : {}),
  };
}

// Projects the digest into the additive record fields: every free-text member is redacted, facts
// are validated (unsourced facts dropped), assumptions stay strictly separate from facts.
export function projectDigest(digest: CompactionDigest): DigestProjection {
  return { ...projectStructured(digest), ...projectPlain(digest) };
}

export function tokensForItems(
  items: readonly ContextLaneItemInput[],
  tokenAccounting: ContextTokenAccounting | undefined,
): number {
  let total = 0;
  for (const item of items) {
    total += countContextTokens(item.text, tokenAccounting);
  }
  return total;
}

export function laneItems(
  lanes: readonly ContextLaneInput[],
  laneId: ContextLaneId,
): readonly ContextLaneItemInput[] {
  for (const lane of lanes) {
    if (lane.laneId === laneId) {
      return lane.items;
    }
  }
  return [];
}

export function itemsByIds(
  items: readonly ContextLaneItemInput[],
  ids: readonly string[],
): readonly ContextLaneItemInput[] {
  const byId = new Map<string, ContextLaneItemInput>(items.map((item) => [item.id, item]));
  const out: ContextLaneItemInput[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found !== undefined) {
      out.push(found);
    }
  }
  return out;
}

// Enriches a repo-file ref with the per-excerpt content hash of the EXACT excluded text (the finer
// invalidation signal, ADR-0053 REFINEMENT 2). Non-repo-file refs are returned unchanged.
function enrichRef(ref: ContextProvenanceRef, text: string | undefined): ContextProvenanceRef {
  if (ref.kind !== "repo-file" || text === undefined) {
    return ref;
  }
  return { ...ref, contentHash: hashExcerptContent(text) };
}

export function buildSourceSpans(
  excluded: readonly ContextLaneItemInput[],
  provenance: ReadonlyMap<string, ContextProvenanceRef>,
): readonly ContextProvenanceRef[] {
  const spans: ContextProvenanceRef[] = [];
  for (const item of excluded) {
    const ref = provenance.get(item.id);
    if (ref !== undefined) {
      spans.push(enrichRef(ref, item.text));
    }
  }
  return spans;
}

export function buildInvalidationKeys(
  spans: readonly ContextProvenanceRef[],
  fileHashes: ReadonlyMap<string, string> | undefined,
): readonly ContextInvalidationKey[] {
  if (fileHashes === undefined) {
    return [];
  }
  const keys: ContextInvalidationKey[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const scopePath = span.scopePath;
    if (span.kind !== "repo-file" || scopePath === undefined || seen.has(scopePath)) {
      continue;
    }
    const contentHash = fileHashes.get(scopePath);
    if (contentHash !== undefined) {
      seen.add(scopePath);
      keys.push({ scopePath, contentHash });
    }
  }
  return keys;
}

// Stable handle id: hashExcerptContent over the laneId plus the SORTED excluded ids, so the same
// eviction set always yields the same opaque key regardless of allocator ordering.
function handleId(laneId: ContextLaneId, excludedIds: readonly string[]): string {
  const sorted = [...excludedIds].sort((a, b) => (a < b ? -1 : 1));
  return hashExcerptContent(`${laneId}:${sorted.join(",")}`);
}

// Copies the kind/scopePath/lineRange/contentHash of a single repo-file excerpt onto the handle so
// rehydrateHandle can resolve it directly. Only when EXACTLY one excluded item is a repo-file span.
function singleRepoFileFields(
  spans: readonly ContextProvenanceRef[],
): Partial<Pick<ContextRehydrationHandle, "kind" | "scopePath" | "lineRange" | "contentHash">> {
  const repoFiles = spans.filter((span) => span.kind === "repo-file");
  const only = repoFiles.length === 1 ? repoFiles[0] : undefined;
  if (only === undefined) {
    return {};
  }
  return {
    kind: only.kind,
    ...(only.scopePath !== undefined ? { scopePath: only.scopePath } : {}),
    ...(only.lineRange !== undefined ? { lineRange: only.lineRange } : {}),
    ...(only.contentHash !== undefined ? { contentHash: only.contentHash } : {}),
  };
}

function singleToolResultFields(
  spans: readonly ContextProvenanceRef[],
): Partial<Pick<ContextRehydrationHandle, "kind" | "artifactId">> {
  const toolResults = spans.filter((span) => span.kind === "tool-result");
  const only = toolResults.length === 1 ? toolResults[0] : undefined;
  if (only === undefined) {
    return {};
  }
  return { kind: only.kind, artifactId: only.stableId };
}

function directRehydrationFields(
  spans: readonly ContextProvenanceRef[],
): Partial<
  Pick<ContextRehydrationHandle, "kind" | "scopePath" | "lineRange" | "contentHash" | "artifactId">
> {
  const repoFile = singleRepoFileFields(spans);
  if (repoFile.kind !== undefined) {
    return repoFile;
  }
  return singleToolResultFields(spans);
}

export function buildRehydrationHandle(input: {
  readonly laneId: ContextLaneId;
  readonly excludedIds: readonly string[];
  readonly spans: readonly ContextProvenanceRef[];
  readonly approxTokens: number;
}): ContextRehydrationHandle {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: input.laneId,
    handleId: handleId(input.laneId, input.excludedIds),
    itemCount: input.excludedIds.length,
    approxTokens: input.approxTokens,
    ...directRehydrationFields(input.spans),
  };
}

export function summaryHashOf(excluded: readonly ContextLaneItemInput[]): string {
  return hashExcerptContent(excluded.map((item) => item.text).join("\n"));
}
