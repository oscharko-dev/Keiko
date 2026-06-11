// Retrieval orchestrator (Epic #189, Issue #199). Single entry point that the future
// #200 Conversation Center integration calls. Composes the rest of the retrieval layer:
//
//   1. Resolve scope: `capsuleId` → single-capsule scope; `capsuleSetId` →
//      `buildComposedRetrievalScope` (from #263); neither → `noEvidence: "no-scope"`.
//   2. Reject empty / whitespace-only query text → `noEvidence: "empty-query"`.
//   3. `searchVectorsForScope` does the actual embedding + similarity work and
//      surfaces a structured failure reason if it produces no refs.
//   4. `validateAnswerGrounding` is applied against the *strictest* policy among the
//      in-scope capsules (e.g. a 3-capsule set with one capsule pinned to
//      "require-citations" enforces that floor on the whole answer).
//   5. If the grounding policy rejects, the runner returns
//      `RetrievalResult { references: [], noEvidence: true,
//      reason: "answer-grounding-rejected" }` — even when `searchVectorsForScope`
//      produced refs. We never leak refs the policy disallows.
//
// The runner does NOT throw on expected paths (no scope, empty query, dim mismatch,
// embedding failure). It only propagates `RetrievalError` from `searchVectorsForScope`
// on store-corruption invariants (e.g. blob length mismatch) — that's a real bug, not
// a user-facing condition.

import type {
  CapsuleAnswerGroundingPolicy,
  CapsuleSetId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";

import { getCapsule } from "../capsule-lifecycle.js";
import { buildComposedRetrievalScope } from "../composition.js";
import { KnowledgeNotFoundError } from "../errors.js";
import { listCapsuleSources } from "../source-lifecycle.js";
import {
  SourceRoutingValidationError,
  validateSourceRoutingForCapsule,
} from "../source-routing-validation.js";
import type { KnowledgeStore } from "../store.js";

import { validateAnswerGrounding } from "./answer-grounding.js";
import {
  searchVectorsForScope,
  type RetrievalScopeInput,
  type SearchOutcome,
} from "./scoped-vector-search.js";
import {
  DEFAULT_RETRIEVAL_TOP_K,
  MAX_RETRIEVAL_TOP_K,
  type RetrievalNoEvidenceReason,
  type RetrievalQuery,
  type RetrievalResult,
} from "./types.js";

export interface RetrievalDependencies {
  readonly store: KnowledgeStore;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  // Optional cancellation. Honoured by the embedding adapter; the store reads are
  // synchronous so they cannot be interrupted, only the model call.
  readonly signal?: AbortSignal;
}

// ─── Public entry point ──────────────────────────────────────────────────────
export async function runLocalKnowledgeRetrieval(
  deps: RetrievalDependencies,
  query: RetrievalQuery,
): Promise<RetrievalResult> {
  const trimmed = query.text.trim();
  if (trimmed.length === 0) return empty("empty-query");

  const scopeResolution = resolveScope(deps.store, query);
  if (!scopeResolution.ok) return empty(scopeResolution.reason);
  const { scope, policy } = scopeResolution;

  const topK = clampTopK(query.topK);
  const search = await searchVectorsForScope(deps.store, deps.embeddingAdapter, scope, trimmed, {
    topK,
    ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });

  return finaliseWithGrounding(search, policy);
}

// ─── Scope + policy resolution ───────────────────────────────────────────────
interface ResolvedScopeOk {
  readonly ok: true;
  readonly scope: RetrievalScopeInput;
  // Strictest policy across the in-scope capsules. The ordering is:
  //   require-citations > require-citations-or-state-no-evidence > best-effort.
  readonly policy: CapsuleAnswerGroundingPolicy;
}
interface ResolvedScopeFail {
  readonly ok: false;
  readonly reason: RetrievalNoEvidenceReason;
}
type ResolvedScope = ResolvedScopeOk | ResolvedScopeFail;

function resolveScope(store: KnowledgeStore, query: RetrievalQuery): ResolvedScope {
  if (query.capsuleId !== undefined) {
    return resolveSingleCapsuleScope(store, query.capsuleId);
  }
  if (query.capsuleSetId !== undefined) {
    return resolveCapsuleSetScope(store, query.capsuleSetId);
  }
  return { ok: false, reason: "no-scope" };
}

function resolveSingleCapsuleScope(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): ResolvedScope {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) return { ok: false, reason: "no-scope" };
  if (!isCapsuleRetrievalScopeValid(store, capsule)) {
    return { ok: false, reason: "no-scope" };
  }
  return {
    ok: true,
    scope: { capsuleIds: [capsule.id] },
    policy: capsule.answerGroundingPolicy,
  };
}

function resolveCapsuleSetScope(store: KnowledgeStore, setId: CapsuleSetId): ResolvedScope {
  // `buildComposedRetrievalScope` throws `KnowledgeNotFoundError` on an unknown set.
  // That's a real caller bug (UI gave us a stale id) so we surface it as no-scope; the
  // alternative — propagating the error — would force the BFF to catch on a path that's
  // semantically "the set does not exist, no answer can fire".
  let scope: ReturnType<typeof buildComposedRetrievalScope>;
  try {
    scope = buildComposedRetrievalScope(store, setId);
  } catch (cause) {
    if (cause instanceof KnowledgeNotFoundError) return { ok: false, reason: "no-scope" };
    if (cause instanceof SourceRoutingValidationError) return { ok: false, reason: "no-scope" };
    throw cause;
  }
  if (scope.capsuleIds.length === 0) return { ok: false, reason: "no-scope" };
  const policy = strictestPolicy(store, scope.capsuleIds);
  return {
    ok: true,
    scope: { capsuleIds: scope.capsuleIds, sourceFilter: scope.sourceIds },
    policy,
  };
}

const POLICY_RANK: Readonly<Record<CapsuleAnswerGroundingPolicy, number>> = Object.freeze({
  "require-citations": 2,
  "require-citations-or-state-no-evidence": 1,
  "best-effort": 0,
});

function strictestPolicy(
  store: KnowledgeStore,
  capsuleIds: readonly KnowledgeCapsuleId[],
): CapsuleAnswerGroundingPolicy {
  let strictest: CapsuleAnswerGroundingPolicy = "best-effort";
  for (const id of capsuleIds) {
    const capsule = getCapsule(store, id);
    if (capsule === undefined) continue;
    if (POLICY_RANK[capsule.answerGroundingPolicy] > POLICY_RANK[strictest]) {
      strictest = capsule.answerGroundingPolicy;
    }
  }
  return strictest;
}

function isCapsuleRetrievalScopeValid(store: KnowledgeStore, capsule: KnowledgeCapsule): boolean {
  try {
    validateSourceRoutingForCapsule(capsule, listCapsuleSources(store, capsule.id));
    return true;
  } catch (cause) {
    if (cause instanceof SourceRoutingValidationError) {
      return false;
    }
    throw cause;
  }
}

// ─── Search → grounding bridge ───────────────────────────────────────────────
function finaliseWithGrounding(
  search: SearchOutcome,
  policy: CapsuleAnswerGroundingPolicy,
): RetrievalResult {
  const decision = validateAnswerGrounding(search.references, policy);
  if (!decision.allow) {
    return {
      references: [],
      noEvidence: true,
      reason: "answer-grounding-rejected",
    };
  }
  if (search.references.length === 0) {
    return {
      references: [],
      noEvidence: true,
      ...(search.noEvidenceReason !== undefined ? { reason: search.noEvidenceReason } : {}),
    };
  }
  return { references: search.references, noEvidence: false };
}

function clampTopK(input: number | undefined): number {
  if (input === undefined) return DEFAULT_RETRIEVAL_TOP_K;
  if (input <= 0) return DEFAULT_RETRIEVAL_TOP_K;
  return Math.min(input, MAX_RETRIEVAL_TOP_K);
}

function empty(reason: RetrievalNoEvidenceReason): RetrievalResult {
  return { references: [], noEvidence: true, reason };
}
